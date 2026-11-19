// Sample recorder.
//
// "Rec sample" records the rack's own output for up to ten seconds and loads the
// take into a Sampler, so the keys play it. Recording starts on the tap, so
// nothing has to be timed against the count-in: the three beeps go straight to
// the speakers and never reach the take.
//
// A voice take is a deliberate step of its own: the Mic button asks for the
// microphone and keeps the permission granted, and Rec sample then records the
// voice alone, so the keys play back just the voice. Rec sample never asks by
// itself, so a browser that cannot hand a microphone over cannot take the page
// down with the request. Mic asks in a browser the player opened, Safari above
// all, where iOS puts the request to itself and answers it. It never asks in an
// app's own browser on iOS: there the request is not answered at all — iOS ends
// the app showing the page instead, and nothing a page does can prevent that —
// so the tap points at the site's public link in Safari, and at a recording
// loaded with the Sampler, for a voice.

import { app } from './app.js';
import { updateSampleName } from './patchbay.js';

const BEEP_HZ = 880;
const BEEP_LEN = 0.12;
const BEEP_GAP = 0.5;
const MAX_SECONDS = 10;
// Each side of the take is taken down a little, so a loud patch and a loud
// voice together still fit under the mix; the take is normalised afterwards.
const MIX_GAIN = 0.7;
// How long the take waits for the microphone prompt before carrying on without
// it, so an unanswered prompt cannot hold up the recording. An answer that comes
// later still joins the take: see the handler at the end of startTake.
const MIC_WAIT_MS = 8000;
// The take is finished in two steps, with this in between: the capture stops,
// the microphone track is closed, and only then are the nodes pulled apart. A
// live microphone torn out of a running graph in one go is what iOS did not
// survive, and a take it does survive is worth the few milliseconds.
const STOP_FLUSH_MS = 140;

let phase = 'idle'; // 'idle' | 'arming' | 'recording'
let finishing = false; // a stop is still loading its take into the Sampler
let session = null; // { stream, micSource, voice, micGain, synth, synthGain, mix, node, kind, sink, chunks, peak, capturing }
let countTimers = [];
let stopTimer = null;
let clockTimer = null;
let workletModule = null;
let takes = 0;
let createSampler = null;
let micAllowed = false; // the microphone permission is granted: takes hold a voice
let micBusy = false; // a microphone request is in flight
let micClosedBefore = false; // an earlier load took the app down for the mic

function button() {
  return document.getElementById('btn-rec-sample');
}

function setButton(label, { disabled = false, on = false } = {}) {
  const btn = button();
  if (!btn) return;
  btn.textContent = label;
  btn.disabled = disabled;
  btn.classList.toggle('on', on);
}

function clearTimers() {
  for (const t of countTimers) clearTimeout(t);
  countTimers = [];
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

// One short sine blip on its own, straight to the speakers, so the count-in is
// heard even with the rack's master level down. It is not part of the take.
function beep(ctx, at) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = BEEP_HZ;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(0.16, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + BEEP_LEN);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + BEEP_LEN + 0.02);
  osc.onended = () => {
    try {
      osc.disconnect();
      g.disconnect();
    } catch (e) {
      /* ignore */
    }
  };
}

function countIn(ctx) {
  const t0 = ctx.currentTime + 0.05;
  beep(ctx, t0);
  beep(ctx, t0 + BEEP_GAP);
  beep(ctx, t0 + BEEP_GAP * 2);
}

// Release a microphone stream, if one was opened.
function stopStream(stream) {
  if (!stream) return;
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    /* ignore */
  }
}

// Let go of a microphone request the take no longer wants.
function releaseMicRequest(request) {
  Promise.resolve(request)
    .then((m) => stopStream(m && m.stream))
    .catch(() => {});
}

// The function this WebKit offers for opening the microphone. Only the standard
// one, on navigator.mediaDevices: every browser the player can open has it, and
// the old prefixed getters that a web view may expose instead lead into the same
// capture code that closes the app on iOS.
function micGetter() {
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === 'function') return (c) => md.getUserMedia(c);
  return null;
}

// Whether Rec sample may ask for the microphone by itself, or the reason it may
// not. Rec sample never asks by itself whatever the browser: the Mic button is the
// one place a request comes from, with the player's tap behind it. This only says
// whether this browser has anything to ask with at all.
function micUnsupported() {
  if (micGetter()) return null;
  return 'unsupported';
}

// The browser's own processing colours a voice and pumps its level, so the take
// first asks for it turned off. A browser that refuses a constraint it does not
// implement is asked again for the plain built-in microphone, and so is one that
// is still letting go of a device another app held: a plain voice is better than
// a take with no voice in it.
const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
};
const MIC_BUSY = ['NotReadableError', 'TrackStartError', 'AbortError'];

// Open the microphone, asking the browser for it when it has not been allowed
// yet. This goes out with the tap so the browser treats it as the player's
// doing; the take waits for the answer.
async function openMicrophone() {
  // Nothing is asked from an app's own browser on iOS, however it was reached:
  // iOS answers the request by ending the app that shows the page, and asking is
  // exactly what closes it. The tap that leads here says so instead; this is the
  // backstop that keeps any other path from sending the request as well.
  if (micInAppBrowser()) return { stream: null, reason: 'webview' };

  const get = micGetter();
  if (!get) return { stream: null, reason: 'unsupported' };

  // The note goes down before the request and comes away when it answers: one
  // still there on the next load is this request having closed the app.
  noteMicTry();
  try {
    const attempts = [{ audio: MIC_CONSTRAINTS }, { audio: true }];
    let reason = 'unknown';
    for (let i = 0; i < attempts.length; i++) {
      try {
        const stream = await get(attempts[i]);
        return { stream, reason: null };
      } catch (e) {
        reason = (e && e.name) || 'unknown';
        // A refusal of the permission itself is the whole answer: asking again
        // would show the same prompt, or come straight back with the same refusal.
        if (reason === 'NotAllowedError' || reason === 'SecurityError') break;
        // The device is still being handed over, or the audio route has only just
        // changed: give it a moment before asking for the plain microphone.
        if (i === 0 && MIC_BUSY.includes(reason)) {
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    }
    return { stream: null, reason };
  } finally {
    clearMicTry();
  }
}

// iOS, including an iPad that reports itself as a Mac; its touch screen is what
// gives that one away.
function isIos() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

// Whether the page is shown by an app's own browser rather than one the player
// opened. Safari the player opened names its own version as well as its engine;
// an app's web view reports the engine alone, or talks to its app through message
// handlers, and a home screen app is not a tab either.
function micInAppBrowser() {
  if (!isIos()) return false;
  const ua = navigator.userAgent || '';
  const handlers = window.webkit && window.webkit.messageHandlers;
  if (handlers && Object.keys(handlers).length) return true;
  if (navigator.standalone) return true;
  // A browser from the App Store is a browser, not an app's own view: it can
  // put the request to iOS itself.
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  return !(/Version\/[\d.]+/.test(ua) && /Safari\/[\d.]+/.test(ua));
}

// A short way to say why the microphone did not open.
function micProblem(reason) {
  if (reason === 'NotAllowedError' || reason === 'SecurityError') {
    return isIos()
      ? 'Microphone blocked — allow it in Settings › Safari › Microphone'
      : 'Microphone blocked — allow it for this page';
  }
  if (reason === 'NotFoundError' || reason === 'DevicesNotFoundError') return 'No microphone found';
  if (reason === 'NotReadableError' || reason === 'TrackStartError' || reason === 'AbortError') {
    return 'The microphone is busy';
  }
  if (reason === 'webview' || reason === 'unsupported') {
    return 'This browser cannot record a microphone';
  }
  if (reason === 'timeout') return 'No answer to the microphone prompt';
  if (reason === 'stalled') return 'The microphone gave no sound';
  return 'Microphone unavailable';
}

// The site's own public link, when the page is being shown at its preview one:
// the same site at the address it can be opened in Safari.
function micPublicHost() {
  const host = location.hostname || '';
  const m = /^(.*)--preview\./.exec(host);
  return m && /(^|\.)freemilk\.app$/.test(host) ? m[1] + '.freemilk.app' : null;
}

// Where a voice gets recorded when this browser will not be handed a microphone:
// the site's public link in Safari, where iOS does put the request, or a take
// made in another app and loaded with the Sampler. Said instead of asking, since
// asking is what closes the app.
function micInAppMessage() {
  const publicHost = micPublicHost();
  return (
    'Microphone needs Safari — ' +
    (publicHost
      ? 'tap Go Live, then open ' + publicHost + ' in Safari'
      : 'publish with Go Live and open the site in Safari') +
    ", or load a recording with the Sampler's Load sample"
  );
}

// The way a voice is recorded from a browser that will not be handed a
// microphone: the site's own public link in Safari, where iOS does put the
// request. The tap that asks puts that link on the clipboard where the web view
// allows it, so getting there is a paste rather than typing an address; a web
// view that will not take the clipboard is given the address to read instead.
function offerMicInSafari() {
  const publicHost = micPublicHost();
  const link = publicHost ? 'https://' + publicHost + '/' : null;
  if (!link || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    app.toast(micInAppMessage(), 8000);
    return;
  }
  navigator.clipboard
    .writeText(link)
    .then(() => {
      app.toast('Link copied — tap Go Live, then paste it into Safari and tap Mic there', 9000);
    })
    .catch(() => {
      app.toast(micInAppMessage(), 8000);
    });
}

// What to say when the take has no voice in it.
function micAdvice(reason) {
  if (reason === 'webview') return 'Mic off here — open the site in Safari for a voice';
  // The ordinary case: Rec sample never asks, so a take holds the keys alone
  // until the Mic button is turned on.
  if (reason === 'off') return 'Mic is off';
  return micProblem(reason);
}

// A note across a page load -----------------------------------------------
//
// In an app's own browser the request for the microphone does not come back with
// an error: iOS ends the app showing the page, because that app has no microphone
// usage description of its own and nothing a page does can give it one. That
// cannot be known beforehand, so a note is left before the request and taken away
// as soon as the request answers. A note still there on the next load is a
// request that never answered: this browser closes for the microphone, and from
// then on the Mic button names the way a voice can be recorded instead of trying.
const MIC_TRY_KEY = 'patchbay.micTry';
const MIC_CLOSED_KEY = 'patchbay.micClosed';
const MIC_NOTE_MAX_MS = 10 * 60 * 1000;
// How long a browser that closed for a request is left alone for. Asking it again
// is worth another go eventually — the browser may have been given a microphone
// since — but not on every visit, since every attempt costs the page.
const MIC_CLOSED_MAX_MS = 24 * 60 * 60 * 1000;

function noteMicTry() {
  try {
    localStorage.setItem(MIC_TRY_KEY, String(Date.now()));
  } catch (e) {
    /* no storage: the page simply has no memory of a close */
  }
}

function clearMicTry() {
  try {
    localStorage.removeItem(MIC_TRY_KEY);
  } catch (e) {
    /* ignore */
  }
}

// Read once per page load: takes the note away, and remembers when the note was
// left by a load that never came back.
function readMicTry() {
  let t = 0;
  try {
    t = Number(localStorage.getItem(MIC_TRY_KEY)) || 0;
    if (t) localStorage.removeItem(MIC_TRY_KEY);
    if (t && Date.now() - t < MIC_NOTE_MAX_MS) {
      localStorage.setItem(MIC_CLOSED_KEY, String(Date.now()));
      return true;
    }
  } catch (e) {
    /* ignore */
  }
  return false;
}

function clearMicClosed() {
  try {
    localStorage.removeItem(MIC_CLOSED_KEY);
  } catch (e) {
    /* ignore */
  }
}

function readMicClosed() {
  try {
    const raw = localStorage.getItem(MIC_CLOSED_KEY);
    if (!raw) return false;
    const t = Number(raw);
    // A bare flag is all an older build wrote; treat it as long expired.
    if (!t) return false;
    if (Date.now() - t > MIC_CLOSED_MAX_MS) {
      localStorage.removeItem(MIC_CLOSED_KEY);
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// What the browser already knows about the microphone permission: 'granted',
// 'denied', 'prompt', or null where it will not say. Reading it never shows a
// prompt and never opens the device.
async function micPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return null;
    const status = await navigator.permissions.query({ name: 'microphone' });
    return (status && status.state) || null;
  } catch (e) {
    return null;
  }
}

// The Mic button -----------------------------------------------------------

function micButton() {
  return document.getElementById('btn-mic');
}

function setMicButton(label, { on = false, disabled = false } = {}) {
  const btn = micButton();
  if (!btn) return;
  btn.textContent = label;
  btn.disabled = disabled;
  btn.classList.toggle('on', on);
}

// Turn the microphone on and keep it on, so Rec sample then records the voice.
// The request was started by the Mic button itself, in the same tap; this only
// waits for the answer and reports it. Works in Safari and, where the browser
// shows the page from an app, in that app's browser too if iOS grants it.
//
// The request is already in flight, so nothing here can spend the gesture before
// iOS has seen it: iOS refuses a request made after an await, because the gesture
// it checks has passed.
async function turnMicOn(request) {
  if (micBusy) return;
  micBusy = true;
  setMicButton('Mic…', { disabled: true });

  // The prompt, where there still is one, is this browser's: say it is coming.
  // Reading the permission is only for that message and never holds up the
  // request itself.
  micPermission()
    .then((state) => {
      if (micBusy && state !== 'granted') app.toast('Asking for the microphone…');
    })
    .catch(() => {});

  let result;
  try {
    result = await request;
  } catch (e) {
    console.warn('Could not open the microphone', e);
    result = { stream: null, reason: 'unavailable' };
  }
  micBusy = false;

  const stream = result && result.stream;
  if (!stream) {
    setMicButton('Mic off');
    // A web view that will not hand over a microphone is answered in its own way
    // by iOS, and the answer is no; the site's own link in Safari is where a voice
    // is reliably recorded, and a Voice Memo can be loaded into the Sampler.
    app.toast(
      micInAppBrowser()
        ? micInAppMessage()
        : micProblem(result && result.reason) + ' — tap Mic to try again',
      micInAppBrowser() ? 8000 : undefined
    );
    return;
  }
  if (!(await waitForLiveMic(stream, 1500))) {
    stopStream(stream);
    setMicButton('Mic off');
    app.toast('The microphone gave no sound — tap Mic to try again');
    return;
  }

  // What is kept is the permission, not the device: the stream is closed again at
  // once, so the phone's audio route stays on the speakers until a take needs a
  // voice in it.
  stopStream(stream);
  micAllowed = true;
  micClosedBefore = false;
  clearMicClosed();
  setMicButton('Mic on', { on: true });
  app.toast('Microphone on — Rec sample records your voice with the keys');
}

function turnMicOff() {
  micAllowed = false;
  setMicButton('Mic');
  app.toast('Microphone off — takes record the rack alone');
}

function onMicClick() {
  if (micBusy) return;

  // In an app's own browser on iOS there is nothing to ask: the request never
  // comes back, the app showing the page is ended instead, and that is the whole
  // of what the tap did. So no request goes out — the tap puts the site's public
  // link on the clipboard and says where a voice is recorded, and the patch is
  // still there afterwards.
  if (micInAppBrowser()) {
    offerMicInSafari();
    return;
  }

  if (micAllowed) {
    turnMicOff();
    return;
  }
  // A browser that closed for an earlier request still gets another go: the rack is
  // kept on the device, so a close costs the page but not the patch, and only the
  // player can say whether this browser has been given a microphone since. The note
  // from that close is read once on load and shown as a hint, not repeated here.
  // The request goes out with the tap itself, in a browser the player opened;
  // that browser puts it to iOS, which answers it. iOS refuses a request made after
  // an await, because the gesture it checks has already passed, so the call is sent
  // from here rather than from anything waiting on it.
  const request = openMicrophone();
  turnMicOn(request).catch((e) => {
    console.error(e);
    micBusy = false;
    setMicButton('Mic off');
    app.toast('Could not open the microphone');
  });
}

// Only an ended track is a track the take cannot use: another app took the
// device, and nothing would ever come out of it.
//
// A track that is still `muted` is a different matter. Safari keeps a fresh
// capture track muted until its first audio arrives and does not reliably send
// the `unmute` event, so waiting for that event gave up on perfectly good
// microphones and turned every voice take into a keys-only one. So a muted track
// is waited on a little to give the route time to settle, and then used anyway.
function waitForLiveMic(stream, ms) {
  const track = stream && stream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') return Promise.resolve(false);
  if (!track.muted) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => settle(true), ms);
    function settle(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        track.onunmute = null;
      } catch (e) {
        /* ignore */
      }
      resolve(ok);
    }
    try {
      track.onunmute = () => settle(true);
    } catch (e) {
      settle(true);
    }
  });
}

// Take the rack's own output out of a running take, so a voice take never holds
// the notes the keys played along with it.
function dropSynthFromTake(s) {
  try {
    if (s.synth && s.synthGain) s.synth.disconnect(s.synthGain);
  } catch (e) {
    /* ignore */
  }
  try {
    if (s.synthGain) s.synthGain.disconnect();
  } catch (e) {
    /* ignore */
  }
  s.synth = null;
  s.synthGain = null;
}

// Join a microphone to a take that has already begun, so an answer to the
// prompt that arrives late still records the voice rather than being dropped.
function attachMic(s, stream) {
  const ctx = app.ctx;
  if (!ctx || !s.mix) {
    stopStream(stream);
    return;
  }
  try {
    noteMicTry();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = MIX_GAIN;
    source.connect(gain);
    gain.connect(s.mix);
    s.stream = stream;
    s.micSource = source;
    s.micGain = gain;
    s.voice = true;
    // The take has become a voice take: the rack leaves it, and what it caught
    // while it was keys-only is dropped, so the sample holds the voice alone.
    dropSynthFromTake(s);
    s.chunks = [];
    s.peak = 0;
    s.startedAt = performance.now();
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(stopTake, MAX_SECONDS * 1000);
  } catch (e) {
    stopStream(stream);
  } finally {
    clearMicTry();
  }
}

// Load the capture worklet once per page.
function loadWorklet(ctx) {
  if (!workletModule) {
    const url = new URL('./sample-recorder-worklet.js', import.meta.url).href;
    workletModule = ctx.audioWorklet.addModule(url).catch((e) => {
      workletModule = null;
      throw e;
    });
  }
  return workletModule;
}

// The node the take is read from. An AudioWorklet runs on the audio thread and
// hands over every block; the deprecated ScriptProcessor is the fallback.
async function buildCapture(ctx, s) {
  if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      await loadWorklet(ctx);
      const node = new AudioWorkletNode(ctx, 'sample-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      node.port.onmessage = (e) => {
        if (!s.capturing) return;
        const data = e.data;
        if (data && data.length) {
          s.chunks.push(data);
          notePeak(s, data);
        }
      };
      s.kind = 'worklet';
      return node;
    } catch (e) {
      console.warn('Worklet capture unavailable, using the script processor', e);
    }
  }
  if (typeof ctx.createScriptProcessor !== 'function') return null;
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!s.capturing) return;
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    s.chunks.push(data);
    notePeak(s, data);
  };
  s.kind = 'script';
  return processor;
}

// Track the loudest sample so far, so the button can show that the take is
// hearing something.
function notePeak(s, data) {
  let p = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] < 0 ? -data[i] : data[i];
    if (v > p) p = v;
  }
  if (p > s.peak) s.peak = p;
}

// Show how the take is going in the message above the transport, rather than on
// the button: the button then keeps the same "■ Stop" label and size for the
// whole take, so it never moves under the finger.
function startClock(s) {
  clockTimer = setInterval(() => {
    const secs = (performance.now() - s.startedAt) / 1000;
    // A voice take that has heard nothing by now is worth saying so about: the
    // take can be stopped instead of waiting out ten seconds of silence.
    if (s.voice && secs > 2 && s.peak <= 0) {
      app.toast('The microphone is giving no sound — tap ■ Stop and try Mic again');
      return;
    }
    const level = Math.round(Math.min(1, s.peak) * 100);
    app.toast('● ' + secs.toFixed(1) + 's · ' + level + '% — tap ■ Stop');
  }, 250);
}

// Drop the recorder's nodes without touching the engine's own routing: the
// master stays patched to the speakers.
function teardown(s) {
  if (!s) return;
  if (s.kind === 'worklet' && s.node) {
    try {
      s.node.port.postMessage({ record: false });
    } catch (e) {
      /* ignore */
    }
  }
  try {
    if (s.micSource && s.micGain) s.micSource.disconnect(s.micGain);
  } catch (e) {
    /* ignore */
  }
  try {
    if (s.micGain) s.micGain.disconnect();
  } catch (e) {
    /* ignore */
  }
  try {
    if (s.synth && s.synthGain) s.synth.disconnect(s.synthGain);
  } catch (e) {
    /* ignore */
  }
  try {
    if (s.synthGain) s.synthGain.disconnect();
  } catch (e) {
    /* ignore */
  }
  try {
    if (s.mix) s.mix.disconnect();
  } catch (e) {
    /* ignore */
  }
  try {
    if (s.node) {
      if (s.node.onaudioprocess !== undefined) s.node.onaudioprocess = null;
      if (s.node.port) s.node.port.onmessage = null;
      s.node.disconnect();
    }
  } catch (e) {
    /* ignore */
  }
  try {
    if (s.sink) s.sink.disconnect();
  } catch (e) {
    /* ignore */
  }
  if (s.stream) stopStream(s.stream);
}

async function startTake(micRequest) {
  const ctx = app.ctx;
  if (!ctx) {
    releaseMicRequest(micRequest);
    app.toast('Start the audio first');
    return;
  }

  phase = 'arming';
  setButton('Rec…', { disabled: true });

  if (ctx.state !== 'running') {
    try {
      await ctx.resume();
    } catch (e) {
      /* fall through to the check below */
    }
  }
  if (ctx.state !== 'running') {
    releaseMicRequest(micRequest);
    phase = 'idle';
    setButton('Rec sample');
    app.toast('Tap Start audio first');
    return;
  }

  // The microphone request went out with the tap; the take waits a while for
  // its answer and then carries on with the synth alone.
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ stream: null, reason: 'timeout' }), MIC_WAIT_MS)
  );
  const micResult = await Promise.race([micRequest, timeout]);

  let stream = micResult.stream;
  // A permission that was granted and is refused now — revoked in Settings — must
  // not leave the Mic button reading as if it still worked.
  if (
    !stream &&
    micAllowed &&
    (micResult.reason === 'NotAllowedError' ||
      micResult.reason === 'SecurityError' ||
      micResult.reason === 'unsupported')
  ) {
    micAllowed = false;
    setMicButton('Mic off');
  }
  // A stream whose track has already ended would only record silence: treat it
  // as no microphone and say so. One that is merely still waking up is not that
  // — see waitForLiveMic.
  if (stream && !(await waitForLiveMic(stream, 600))) {
    stopStream(stream);
    stream = null;
  }
  let problem = stream ? null : micAdvice(micResult.reason || 'stalled');

  // Opening the microphone can interrupt the audio context on iOS, and a stream
  // source joined to an interrupted context records silence: get the context
  // running again before the voice is attached to it.
  if (stream && ctx.state !== 'running') {
    try {
      await ctx.resume();
    } catch (e) {
      /* the take then holds the synth as far as the context allows */
    }
  }

  let micSource = null;
  if (stream) {
    // Joining a live stream to a running context is the last step that could
    // close the app on iOS, so the note is taken around it too.
    noteMicTry();
    try {
      micSource = ctx.createMediaStreamSource(stream);
    } catch (e) {
      stopStream(stream);
      stream = null;
      problem = micProblem('unavailable');
    } finally {
      clearMicTry();
    }
  }

  const synth = app.engine && app.engine.master ? app.engine.master : null;
  if (!micSource && !synth) {
    stopStream(stream);
    phase = 'idle';
    setButton('Rec sample');
    app.toast(problem + ', and there is no audio to record');
    return;
  }

  const sink = ctx.createGain();
  const s = {
    stream,
    micSource,
    voice: !!micSource,
    micGain: null,
    synth,
    synthGain: null,
    mix: null,
    node: null,
    kind: null,
    sink,
    chunks: [],
    peak: 0,
    startedAt: 0,
    capturing: false
  };

  let node = null;
  try {
    node = await buildCapture(ctx, s);
  } catch (e) {
    console.warn('Could not build the recorder', e);
    node = null;
  }
  if (!node) {
    stopStream(stream);
    phase = 'idle';
    setButton('Rec sample');
    app.toast('This browser cannot capture a recording');
    return;
  }
  s.node = node;

  try {
    // One gain node feeds the recorder. A voice take holds the voice alone: the
    // rack's own notes would otherwise be baked into the sample, and the keys
    // should play back the voice rather than a recording of themselves.
    const mix = ctx.createGain();
    s.mix = mix;
    if (micSource) {
      const micGain = ctx.createGain();
      micGain.gain.value = MIX_GAIN;
      s.micGain = micGain;
      micSource.connect(micGain);
      micGain.connect(mix);
    } else if (synth) {
      const synthGain = ctx.createGain();
      synthGain.gain.value = MIX_GAIN;
      s.synthGain = synthGain;
      synth.connect(synthGain);
      synthGain.connect(mix);
    }
    mix.connect(node);

    // The recorder has to reach the speakers to be rendered, but nothing it
    // hears may be monitored. The worklet writes no output of its own, so it
    // can go straight to the destination; the script processor is muted by a
    // zero gain instead.
    if (s.kind === 'worklet') {
      node.connect(ctx.destination);
    } else {
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(ctx.destination);
    }
  } catch (e) {
    teardown(s);
    phase = 'idle';
    setButton('Rec sample');
    app.toast('This browser cannot capture a recording');
    return;
  }

  session = s;
  phase = 'recording';
  s.capturing = true;
  s.startedAt = performance.now();
  if (s.kind === 'worklet') {
    try {
      node.port.postMessage({ record: true });
    } catch (e) {
      /* ignore */
    }
  }

  setButton('■ Stop', { on: true });
  // The count-in is a sound in the room, and a microphone would put it into the
  // take: a voice take starts straight away instead.
  if (!micSource) countIn(ctx);
  // The explanation the take opened with gets a moment to be read before the
  // running count takes over the message.
  countTimers.push(
    setTimeout(() => {
      if (session === s) startClock(s);
    }, 1600)
  );
  stopTimer = setTimeout(stopTake, MAX_SECONDS * 1000);

  if (micSource) {
    app.toast('Recording your voice — sing, then tap ■ Stop');
  } else if (micResult.reason === 'off') {
    // The ordinary case, and the one that reads as a bug otherwise: the keys are
    // being recorded, not the voice, because the Mic button was never turned on.
    app.toast('Recording the keys alone — tap Mic first to record your voice');
  } else {
    app.toast(problem + ' — this take holds the keys alone');
  }

  // A prompt answered after the take began still records the voice: the stream
  // joins the running take, and one the take can no longer use is let go.
  Promise.resolve(micRequest)
    .then((m) => {
      const late = m && m.stream;
      if (!late) return;
      if (session !== s) {
        stopStream(late);
        return;
      }
      // Already the take's own microphone: leave it running.
      if (s.micSource || s.stream === late) return;
      attachMic(s, late);
    })
    .catch(() => {});
}

// Stop the take. The graph is let go in a fixed order — the capture first, then
// the microphone, then the nodes — and the take is built a moment later, so the
// microphone is never pulled out of a graph that is being taken apart at the same
// time. Nothing here can leave the button stuck: the take either reaches the
// Sampler or says why it could not.
function stopTake() {
  if (finishing) return;
  const s = session;
  if (!s) {
    clearTimers();
    phase = 'idle';
    setButton('Rec sample');
    return;
  }

  finishing = true;
  clearTimers();
  session = null;
  phase = 'idle';
  setButton('Rec sample');

  s.capturing = false;
  if (s.kind === 'worklet' && s.node && s.node.port) {
    try {
      s.node.port.postMessage({ record: false });
    } catch (e) {
      /* ignore */
    }
  }

  // The microphone goes back to the speakers before anything else moves: its
  // track is closed while the nodes it fed are still standing.
  try {
    if (s.micSource && s.micGain) s.micSource.disconnect(s.micGain);
  } catch (e) {
    /* ignore */
  }
  try {
    if (s.micSource) s.micSource.disconnect();
  } catch (e) {
    /* ignore */
  }
  stopStream(s.stream);
  s.stream = null;

  // Closing the microphone hands the audio back to the speakers, which can
  // interrupt the context on iOS: ask it to run again so the rack is not left
  // silent once the take is over.
  if (app.ctx && app.ctx.state !== 'running' && typeof app.ctx.resume === 'function') {
    try {
      app.ctx.resume().catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  app.toast('Finishing the take…');

  setTimeout(() => {
    try {
      teardown(s);
      const buffer = buildBuffer(app.ctx, s.chunks);
      s.chunks = [];
      if (!buffer) {
        app.toast(
          s.voice
            ? 'Nothing was picked up — the microphone gave no sound'
            : 'Nothing was picked up — play the keys while it records'
        );
        return;
      }
      applyToSampler(buffer);
    } catch (e) {
      console.error('Could not finish the take', e);
      app.toast('Could not save the take — try again');
    } finally {
      finishing = false;
    }
  }, STOP_FLUSH_MS);
}

// Trim the silence around the take, normalise it and fade the edges so it does
// not click when a key starts it.
function buildBuffer(ctx, chunks) {
  if (!ctx || !chunks || !chunks.length) return null;
  let total = 0;
  for (const c of chunks) total += c.length;
  if (!total) return null;

  const flat = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    flat.set(c, off);
    off += c.length;
  }

  let rawPeak = 0;
  for (let i = 0; i < total; i++) rawPeak = Math.max(rawPeak, Math.abs(flat[i]));
  if (rawPeak < 0.0005) return null;

  // Trim against the take's own peak so a quiet recording still keeps its
  // sound, while a loud one drops its room noise.
  const floor = Math.max(0.002, rawPeak * 0.03);
  let a = 0;
  while (a < total && Math.abs(flat[a]) < floor) a++;
  if (a >= total) return null;
  let b = total - 1;
  while (b > a && Math.abs(flat[b]) < floor) b--;

  const rate = ctx.sampleRate;
  const start = Math.max(0, a - Math.floor(rate * 0.02));
  const end = Math.min(total, b + Math.floor(rate * 0.06));
  const len = end - start;
  if (len < Math.floor(rate * 0.02)) return null;

  const buffer = ctx.createBuffer(1, len, rate);
  const data = buffer.getChannelData(0);
  data.set(flat.subarray(start, end));

  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0.0001) {
    const gain = Math.min(8, 0.9 / peak);
    for (let i = 0; i < len; i++) data[i] *= gain;
  }

  const fade = Math.min(Math.floor(rate * 0.005), Math.floor(len / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    data[i] *= g;
    data[len - 1 - i] *= g;
  }
  return buffer;
}

function applyToSampler(buffer) {
  let mod = app.state.modules.find((m) => m.type === 'sampler') || null;
  if (!mod && createSampler) mod = createSampler();
  if (!mod) {
    app.toast('Could not add a Sampler for the recording');
    return;
  }

  takes++;
  mod.data = mod.data || {};
  mod.data.buffer = buffer;
  mod.data.name = 'Take ' + takes;
  updateSampleName(mod.id);
  app.toast('Sample ready — play the keys to hear it');
}

export function initSampleRecorder(opts = {}) {
  createSampler = opts.createSampler || null;

  const mic = micButton();
  if (mic) mic.addEventListener('click', onMicClick);

  // A load that follows a microphone request with no answer means the last one
  // closed the app. The page then knows better and the button says so.
  const closed = readMicTry();
  micClosedBefore = closed || readMicClosed();
  if (micClosedBefore) {
    // Late enough to follow the first-run hint rather than replace it. The Mic
    // button no longer sends a request from a browser like this, so this is the
    // way a voice is recorded, said once after a load that was closed for one.
    setTimeout(() => {
      app.toast(micInAppMessage(), 8000);
    }, 4600);
  }

  const btn = button();
  if (!btn) return;

  btn.addEventListener('click', () => {
    // A take still being loaded from the last stop owns the button until it is
    // done, so a tap can never start a second one over it.
    if (finishing) return;
    if (phase === 'recording') {
      stopTake();
      return;
    }
    if (phase !== 'idle') return;

    // Rec sample never asks for the microphone: only the Mic button does, and
    // only where an answer is possible. A request this browser answers by closing
    // the app would take the take down with it, and a take of the rack alone is
    // worth far more than that.
    let micRequest;
    if (micAllowed) {
      micRequest = openMicrophone();
    } else {
      const blocked = micUnsupported();
      micRequest = Promise.resolve({ stream: null, reason: blocked || 'off' });
    }

    startTake(micRequest).catch((e) => {
      console.error(e);
      releaseMicRequest(micRequest);
      if (session) stopTake();
      else {
        phase = 'idle';
        setButton('Rec sample');
        app.toast('Could not record a sample');
      }
    });
  });
}
