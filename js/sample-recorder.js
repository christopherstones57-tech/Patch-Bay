// Sample recorder.
//
// "Rec sample" records the rack's own output for up to ten seconds and loads the
// take into a Sampler, so the keys play it. Recording starts on the tap, so
// nothing has to be timed against the count-in: the three beeps go straight to
// the speakers and never reach the take.
//
// A voice take is a deliberate step of its own: the Mic button asks for the
// microphone and keeps the permission granted, and Rec sample then records the
// voice alone, so the keys play back just the voice.
//
// The microphone is only ever asked for where a request is safe, and every
// request goes through micBlockedReason first. On iOS an app's own browser is
// never asked: a web view whose app has no microphone usage description of its
// own cannot be handed one, and iOS ends the whole app when it is asked instead
// of answering the page — and the page cannot tell the two apps apart before it
// asks. So the Mic button there answers with the site's public link in Safari,
// and Rec sample records the rack without waiting on a request that would take
// the app down. A note across the page load remembers a request that never came
// back, for a browser this page could not recognise in advance, and that one is
// not asked again either.

import { app, setAudioSession, addCable, removeCable } from './app.js?v=12';
import { updateSampleName, updateParamControl, revealModule } from './patchbay.js?v=12';

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
// How long the Mic button waits on a request that never answers. A web view that
// is not allowed a microphone can leave the request unsettled rather than reject
// it, and the button must not sit on "Mic…" for ever when it does.
const MIC_PROMPT_WAIT_MS = 30000;
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
let micRefused = false; // this browser has answered a request with no
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
  // Straight to the speakers, but through the page's own output route, so the
  // count-in is heard wherever the rack is.
  g.connect(app.output || ctx.destination);
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

// Release a microphone stream, if one was opened, and put the page back in the
// full-volume playback session. Recording is its own session, and a synth left
// playing in it is quiet and routed the way a phone call would be — so this runs
// even when there was no stream to close.
function stopStream(stream) {
  if (stream) {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      /* ignore */
    }
  }
  setAudioSession('playback');
}

// Let go of a microphone request the take no longer wants.
function releaseMicRequest(request) {
  Promise.resolve(request)
    .then((m) => stopStream(m && m.stream))
    .catch(() => {});
}

// The microphone must not hear the page's own speakers ------------------------
//
// A microphone on a phone sits inches from the speaker, and a voice take asks
// for the browser's echo cancellation to stay off so the voice arrives as it
// sounds. A synth left playing during a voice take is therefore recorded into it
// as the room hears it, and then every key plays that take back, synth and all.
// So the rack's own output is silenced for the length of a voice take: it is not
// wanted in the recording, and it is the only thing the microphone could hear.
// The level it was at is put back as soon as the take stops.
let rackMuted = null;

function muteRack() {
  const e = app.engine;
  if (!e || !e.master || rackMuted !== null) return;
  try {
    rackMuted = e.master.gain.value;
    e.master.gain.setTargetAtTime(0, e.ctx.currentTime, 0.01);
  } catch (err) {
    rackMuted = null;
  }
}

function unmuteRack() {
  const e = app.engine;
  const v = rackMuted;
  rackMuted = null;
  if (!e || !e.master || v === null) return;
  try {
    e.master.gain.setTargetAtTime(v, e.ctx.currentTime, 0.02);
  } catch (err) {
    try {
      e.master.gain.value = v;
    } catch (err2) {
      /* ignore */
    }
  }
}

// The function this browser offers for opening the microphone. The standard one
// on navigator.mediaDevices is used where it exists; a web view from an older
// WebKit may only expose the prefixed call, which takes callbacks rather than a
// promise and is wrapped into the same shape here, so a browser that can hand a
// microphone over is never passed by for want of the newer name.
function micGetter() {
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === 'function') return (c) => md.getUserMedia(c);

  const legacy = navigator.webkitGetUserMedia || navigator.getUserMedia;
  if (typeof legacy === 'function') {
    return (c) =>
      new Promise((resolve, reject) => {
        try {
          legacy.call(
            navigator,
            c,
            (stream) => resolve(stream),
            (e) => reject(e || new Error('Microphone unavailable'))
          );
        } catch (e) {
          reject(e);
        }
      });
  }

  // Some web views keep the prefixed MediaDevices object instead of the call.
  const wmd = navigator.webkitMediaDevices;
  if (wmd && typeof wmd.getUserMedia === 'function') return (c) => wmd.getUserMedia(c);

  return null;
}

// Whether this browser may be asked for a microphone at all, and the reason it
// may not. Nothing in this file calls a microphone getter without asking here
// first, because the wrong request does not fail: it takes the page's app down.
//
//   'unsupported' — nothing here can open a microphone.
//   'webview'     — an app's own browser on iOS. Its app either has a microphone
//                   usage description, so asking shows the prompt, or has none,
//                   so asking ends the app before the page hears any answer. The
//                   page cannot tell those two apart beforehand, and the second
//                   costs the player everything else they had open, so this
//                   browser is never asked: the site's public link in Safari is.
//   'closed'      — an earlier request never came back, so this browser closed
//                   for it. Never asked again, whichever browser it turns out to
//                   be.
//
// Where a request is safe the Mic button turns the voice on; where it is not, the
// take records the rack alone and the button says where a voice can be taken.
function micBlockedReason() {
  if (!micGetter()) return 'unsupported';
  if (micClosesApp()) return 'webview';
  if (micClosedBefore) return 'closed';
  return null;
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
// doing; the take waits for the answer. A take that needs different processing —
// the lyric channel asks for echo cancellation — passes its own constraints;
// anything else gets the plain, unprocessed microphone above.
export async function openMicrophone(constraints) {
  // A browser that must not be asked answers at once, with the reason, and never
  // sees a request: see micBlockedReason.
  const blocked = micBlockedReason();
  if (blocked) return { stream: null, reason: blocked };

  const get = micGetter();

  // The note goes down before the request and comes away when it answers: one
  // still there on the next load is this request having closed the app.
  noteMicTry();
  // Recording is its own audio session: asked for under the playback one, a
  // request can be refused outright, and the synth's own sound ends up on the
  // quiet route a phone call would use.
  setAudioSession('play-and-record');
  try {
    const attempts = [{ audio: constraints || MIC_CONSTRAINTS }, { audio: true }];
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
    // Nothing was handed over, so nothing needs the record session any more:
    // the synth must not be left playing under it.
    setAudioSession('playback');
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
export function micInAppBrowser() {
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

// Whether asking this browser for a microphone would not be answered but would
// end the app showing the page. That is an app's own web view on iOS, and it is
// the one case worth refusing outright rather than reporting afterwards: iOS
// checks the app's microphone usage description before the page sees anything, so
// an app without one is terminated, and the page learns nothing until it is loaded
// again. A home screen app is not this — Safari is underneath it and prompts for
// its microphone as Safari does — so it is left out of the test above.
function micClosesApp() {
  if (!isIos()) return false;
  const ua = navigator.userAgent || '';
  const handlers = window.webkit && window.webkit.messageHandlers;
  if (handlers && Object.keys(handlers).length) return true;
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  return !(/Version\/[\d.]+/.test(ua) && /Safari\/[\d.]+/.test(ua));
}

// An answer no further tap can change on its own: this browser has no microphone
// to hand over, or will never show a prompt for one. Rec sample stops asking
// after one of these, so a browser that refuses cannot make every take wait on a
// request that will not come; the Mic button still asks whenever it is tapped.
function micRefusedPermanently(reason) {
  return (
    reason === 'NotAllowedError' ||
    reason === 'SecurityError' ||
    reason === 'unsupported' ||
    reason === 'webview' ||
    reason === 'closed' ||
    reason === 'timeout'
  );
}

// A short way to say why the microphone did not open.
export function micProblem(reason) {
  if (reason === 'NotAllowedError' || reason === 'SecurityError') {
    // A refusal from an app's own browser is not the player's to change in
    // Settings: that browser has to be given the microphone by the app showing
    // it, or the site opened somewhere that has one.
    if (micInAppBrowser()) return 'This browser will not hand over a microphone';
    return isIos()
      ? 'Microphone blocked — allow it for this site in Settings › Safari › Microphone, or open the link in Safari'
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

// The address the site can be opened at elsewhere, and whether it has to be
// published first. A page shown at its preview link is not the public site, so
// its public host goes with "tap Go Live"; a page already at the public link, or
// at any other host, only has to be opened there.
function micOpenElsewhere() {
  const host = location.hostname || '';
  if (!host) return null;
  const m = /^(.*)--preview\./.exec(host);
  if (m && /(^|\.)freemilk\.app$/.test(host)) {
    return { host: m[1] + '.freemilk.app', needsGoLive: true };
  }
  return { host, needsGoLive: false };
}

// Where a voice gets recorded when this browser will not be handed a microphone:
// the site opened in a browser that will, or a take made in another app and
// loaded with the Sampler. Said in place of an answer, since there is no other
// one here. `definite` says this browser is known never to ask — an app's own
// browser on iOS, or one that closed for a request — rather than one that only
// refused once and might be asked again.
function micInAppMessage(definite = false) {
  const elsewhere = micOpenElsewhere();
  let where = 'open the site in Safari';
  if (elsewhere) {
    where = elsewhere.needsGoLive
      ? 'tap Go Live, then open ' + elsewhere.host + ' in Safari'
      : 'open ' + elsewhere.host + ' in Safari';
  }
  return (
    (definite
      ? 'This browser cannot record a voice — record in Safari: '
      : 'If this browser will not hand over the microphone, record in Safari — ') +
    where +
    ", or load a recording with the Sampler's Load sample"
  );
}

// The way a voice is recorded from a browser that will not be handed a
// microphone: the site opened in Safari, which does put the request to iOS. The
// tap that asks puts that address on the clipboard where the web view allows it,
// so getting there is a paste rather than typing it; a web view that will not
// take the clipboard is given the address to read instead.
export function offerMicInSafari(definite = false) {
  const elsewhere = micOpenElsewhere();
  const link = elsewhere ? 'https://' + elsewhere.host + '/' : null;
  if (!link || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    app.toast(micInAppMessage(definite), 9000);
    return;
  }
  const how = elsewhere.needsGoLive
    ? 'tap Go Live, then paste it into Safari and tap Mic there'
    : 'paste it into Safari and tap Mic there';
  navigator.clipboard
    .writeText(link)
    .then(() => {
      app.toast(
        (definite ? 'This browser cannot record a voice. Link copied — ' : 'Link copied — ') + how,
        9000
      );
    })
    .catch(() => {
      app.toast(micInAppMessage(definite), 9000);
    });
}

// What to say when the take has no voice in it.
function micAdvice(reason) {
  // A take in a browser that is never asked, or one that closed for a request:
  // the rack is what it records, and the Mic button is where the way to record a
  // voice in Safari is.
  if (reason === 'webview' || reason === 'closed') {
    return 'Mic off here — tap Mic to copy the link for Safari';
  }
  if (reason === 'refused') {
    return 'The microphone is not available here — tap Mic to try again';
  }
  // The ordinary case, and the one that reads as a bug otherwise: the keys are
  // being recorded rather than the voice because Mic was never turned on.
  if (reason === 'off') return 'Mic is off';
  return micProblem(reason);
}

// A note across a page load -----------------------------------------------
//
// An app's own browser may answer a request for the microphone by ending the app
// that shows the page, because that app has no microphone usage description of
// its own and nothing a page does can give it one. A browser this page can
// recognise as an app's own is never asked at all (see micBlockedReason), but one
// it cannot — a web view that presents Safari's own user agent, say — takes the
// page down with the first request. So a note is left before every request and
// taken away as soon as it answers: one still there on the next load is a request
// that never answered, and that browser is not asked again either, for the day it
// is left alone for below, so no tap can repeat it.
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

// A take outside this file — the lyric channel's own — has answered a microphone
// request too, so the Mic button is told what happened, and this browser is
// remembered the same way a take of this file's would.
export function micGrantedByTake() {
  micAllowed = true;
  micRefused = false;
  micClosedBefore = false;
  clearMicClosed();
  setMicButton('Mic on', { on: true });
}

export function micRefusedByTake(reason) {
  if (micRefusedPermanently(reason)) micRefused = true;
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
    // A browser can leave the request unanswered — a web view that will not hand
    // a microphone over often does — so the button does not wait on it forever.
    result = await Promise.race([
      request,
      new Promise((resolve) =>
        setTimeout(() => resolve({ stream: null, reason: 'timeout' }), MIC_PROMPT_WAIT_MS)
      )
    ]);
  } catch (e) {
    console.warn('Could not open the microphone', e);
    result = { stream: null, reason: 'unavailable' };
  }
  micBusy = false;

  const stream = result && result.stream;
  if (!stream) {
    setMicButton('Mic off');
    if (micRefusedPermanently(result && result.reason)) micRefused = true;
    // An answer that came too late still holds a device: let it go rather than
    // leave the microphone open behind a button that says it is off.
    if (result && result.reason === 'timeout') releaseMicRequest(request);
    // A web view that will not hand a microphone over has nothing else to offer
    // here: the site's own public link in Safari is where a voice can be
    // recorded, and a Voice Memo can be loaded into the Sampler instead.
    if (micInAppBrowser() || (result && result.reason === 'webview')) {
      offerMicInSafari();
      return;
    }
    app.toast(micProblem(result && result.reason) + ' — tap Mic to try again', 12000);
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
  micRefused = false;
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

  if (micAllowed) {
    turnMicOff();
    return;
  }

  // Where no request can be made, saying so is the whole answer: no tap asks a
  // browser that would either take the app down or hand nothing over. A browser
  // that closed for an earlier request is included, so a second tap cannot do
  // what the first one did.
  const blocked = micBlockedReason();
  if (blocked) {
    setMicButton('Mic off');
    if (blocked === 'unsupported') {
      app.toast(micProblem('unsupported'), 8000);
    } else {
      offerMicInSafari(true);
    }
    return;
  }

  // The request goes out with the tap itself: iOS refuses one made after an
  // await, because the gesture it checks has already passed, so the call is sent
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
    // Nothing of the rack may reach the speaker now, or the microphone would
    // record it along with the voice.
    muteRack();
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
    const url = new URL('./sample-recorder-worklet.js?v=12', import.meta.url).href;
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
    const what = s.voice ? 'voice' : 'keys only';
    app.toast('● ' + secs.toFixed(1) + 's · ' + level + '% · ' + what + ' — tap ■ Stop');
  }, 250);
}

// Drop the recorder's nodes without touching the engine's own routing: the
// master stays patched to the speakers.
function teardown(s) {
  if (!s) return;
  unmuteRack();
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
  // Remember a browser that has answered no, so the next take does not wait on
  // the same answer again; the Mic button still asks whenever it is tapped.
  if (!stream && micRefusedPermanently(micResult.reason)) micRefused = true;
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

  if (micSource) {
    // A take that was handed a microphone is also the Mic button's answer: keep
    // the permission for the next take and show it as on.
    micAllowed = true;
    micRefused = false;
    micClosedBefore = false;
    clearMicClosed();
    setMicButton('Mic on', { on: true });
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
    micProblem: problem,
    micReason: micResult.reason || null,
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
  // A voice take silences the rack while it records: see muteRack.
  if (micSource) muteRack();
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
  // A muted rack goes back to the speakers as soon as the take stops, whether or
  // not there was a take still running.
  unmuteRack();
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
      applyToSampler(buffer, s.voice, s.micProblem);
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

// Middle C: the middle of the keybed, and the note a take plays at the pitch it
// was recorded at. Every other key is transposed from it.
const SAMPLER_ROOT = 60;

// A take is what the keys should play, so the Sampler becomes the only thing
// that reaches the Output — whether the take holds the voice or the rack. Its
// own controls are put back to a clean one-shot on middle C, its output goes
// straight to the Output, every other cable into the Output is unplugged and so
// is every other cable out of the sampler, so the synth's own sound and its
// effects are not heard under the recording. The modules themselves stay on the
// rack, so Auto-patch or a preset puts the synth back in one tap.
function focusSampler(mod) {
  mod.params.root = SAMPLER_ROOT;
  mod.params.loop = false;
  updateParamControl(mod.id, 'root');
  updateParamControl(mod.id, 'loop');
  soloSampler(mod);
}

function soloSampler(mod) {
  // Every Output the rack has: a cable into any one of them would reach the
  // speakers.
  const outputs = app.state.modules.filter((m) => m.type === 'output');
  if (!outputs.length) return;

  for (const cable of app.state.cables.slice()) {
    const intoOutput =
      cable.to.port === 'in' && outputs.some((o) => o.id === cable.to.id);
    // Everything else comes off the Output...
    if (intoOutput && cable.from.id !== mod.id) {
      removeCable(cable.id);
      continue;
    }
    // ...and the sampler feeds nothing but the Output.
    if (!intoOutput && cable.from.id === mod.id) removeCable(cable.id);
  }

  addCable(mod.id, 'out', outputs[0].id, 'in');
  if (app.onCablesChanged) app.onCablesChanged();
}

function applyToSampler(buffer, voice, problem) {
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
  // Every take takes over the keys: the recording is what plays, never the
  // recording plus the synth that made it.
  focusSampler(mod);
  updateSampleName(mod.id);
  // Show the card the take landed on, so it is plain that the keys are playing
  // this take and not the patch.
  revealModule(mod.id);
  // Say what the take holds, and when there was meant to be a voice but the
  // browser would not give one, say that too rather than leaving the player to
  // wonder why their voice was not in it. A take without a voice is the rack's
  // own sound recorded, which on the keys sounds exactly like the synth — that
  // is the take playing, not the patch.
  let msg = voice
    ? 'Sample ready — the voice alone plays on the keys'
    : "Sample ready — only this take plays on the keys, and it is the rack's own sound";
  if (!voice) {
    msg += problem
      ? '. ' + problem
      : micGetter()
        ? '. Tap Mic to record your voice instead'
        : '';
  }
  msg += ' — Auto-patch brings the synth back';
  app.toast(msg, 10000);
}

export function initSampleRecorder(opts = {}) {
  createSampler = opts.createSampler || null;

  const mic = micButton();
  if (mic) mic.addEventListener('click', onMicClick);

  // A load that follows a microphone request with no answer means the last one
  // closed the app. The page then knows better: this browser is not asked again,
  // and the player is told where a voice can be taken instead.
  const closed = readMicTry();
  micClosedBefore = closed || readMicClosed();
  if (micClosedBefore) {
    // Late enough to follow the first-run hint rather than replace it.
    setTimeout(() => {
      app.toast(micInAppMessage(true), 9000);
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

    // The take asks for the microphone itself, with this tap behind it, so the
    // first Rec sample of a visit can be a voice take without turning Mic on
    // first. Where a request is not safe it answers at once and the take records
    // the rack alone, which is what keeps this button from closing the app.
    const micRequest = micRequestForTake();

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

// The microphone a take asks for, answered at once where this browser must not be
// asked: an app's own browser on iOS, and one that closed for an earlier request.
function micRequestForTake() {
  const blocked = micBlockedReason();
  if (blocked) return Promise.resolve({ stream: null, reason: blocked });
  // A browser that answered no is remembered, so later takes record the rack
  // without waiting on the same answer again; the Mic button still says why.
  if (!micAllowed && micRefused) return Promise.resolve({ stream: null, reason: 'refused' });
  return openMicrophone();
}
