// Virtual keyboard, recording and transport.

import {
  app,
  songLength,
  mixEvents,
  setChannel,
  clearAllChannels,
  CHANNEL_COUNT,
  NOTE_CHANNEL_COUNT,
  LYRIC_CHANNEL,
  MAX_CHANNEL_VOLUME,
  hasLyrics,
  lyricEnd
} from './app.js?v=13';

import {
  openVoices,
  snapshotRack,
  channelVolume,
  setChannelVolume,
  applyLiveChannel
} from './voices.js?v=13';

import {
  requestLyricMic,
  armLyricCapture,
  beginLyricCapture,
  stopLyricCapture,
  stopLyricStream,
  playLyrics,
  stopLyrics,
  setLyricVolume
} from './lyrics.js?v=13';

import {
  micProblem,
  micInAppBrowser,
  offerMicInSafari,
  micRefusedByTake,
  micGrantedByTake
} from './sample-recorder.js?v=13';

import { startClick, stopClick, COUNT_IN_BEATS } from './click.js?v=13';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const COMPUTER_KEYS = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17
};

let keysEl = null;
let playback = null;
const activePointers = new Map();
const heldComputer = new Map();

// The lyric channel's own take: a microphone capture rather than note events.
// `startingLyrics` covers the wait for the microphone prompt, when no take is
// running yet but a second tap must not begin another one.
const LYRIC_START_LEAD = 0.35; // seconds between the tap and the take's first frame
const LYRIC_MIC_WAIT_MS = 20000; // the longest a take waits for the microphone
const LYRIC_MAX_SECONDS = 300; // a lyric take stops itself after this long

let startingLyrics = false;
// Counts the takes asked for, so one whose microphone answer arrives after the
// rack was swapped — or after the player gave up on it — is dropped rather than
// starting a recording nobody asked for any more.
let lyricAttempt = 0;
let lyricClock = null;
let lyricStopTimer = null;

// The beat a take with a count-in begins on, and the timer that counts it down
// on the info line — so it is clear the take has not started and the keys
// played now are not being written down yet.
let countInEnd = 0;
let countInTimer = null;

// How early a note may be pressed and still be taken as the take's first:
// players play just before the beat, not on it.
const REC_LEAD_GRACE = 0.12;
// Sixteenths in a beat — what Quantize snaps to, a bar of 4/4 being counted in.
const QUANT_STEPS = 4;

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

// Which note channels hold something to play. Pass a channel index to leave it
// out — the take that is being recorded.
function recordedChannels(exclude = -1) {
  const out = [];
  for (let i = 0; i < NOTE_CHANNEL_COUNT; i++) {
    if (i === exclude) continue;
    if ((app.song.channels[i] || []).length) out.push(i);
  }
  return out;
}

export function initKeyboard() {
  keysEl = document.getElementById('keys');
  renderKeyboard();

  // The transport's own keybed is guarded like a mounted one, so a long press on
  // it never becomes the browser's selection menu rather than a note.
  guardKeybed(keysEl);
  keysEl.addEventListener('pointerdown', onKeysDown);
  keysEl.addEventListener('pointermove', onKeysMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('keydown', onComputerDown);
  window.addEventListener('keyup', onComputerUp);

  const down = document.getElementById('oct-down');
  const up = document.getElementById('oct-up');
  if (down) down.addEventListener('click', () => shiftOctave(-12));
  if (up) up.addEventListener('click', () => shiftOctave(12));

  const bar = document.getElementById('channel-bar');
  if (bar) {
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.chan');
      if (btn) selectChannel(Number(btn.dataset.channel));
    });
  }

  // The five knobs above the keyboard: one level per channel, heard at once if
  // the song is playing.
  initChannelVolumes();

  const rec = document.getElementById('btn-rec');
  if (rec) rec.addEventListener('click', toggleRecord);

  const play = document.getElementById('btn-play');
  if (play) {
    play.addEventListener('click', () => {
      if (app.song.playing) {
        stopPlayback();
      } else if (!mixEvents().length && !hasLyrics()) {
        app.toast('Nothing recorded yet — tap Rec, then play the keys or sing the lyrics');
      } else {
        startPlayback();
      }
    });
  }

  const loop = document.getElementById('btn-loop');
  if (loop) {
    loop.classList.toggle('on', app.song.loop);
    loop.addEventListener('click', () => {
      app.song.loop = !app.song.loop;
      loop.classList.toggle('on', app.song.loop);
    });
  }

  // The click track and Quantize: the two switches that decide how a take is
  // timed. Click is on from the start, so a first take is counted in without
  // anything to set up; Quantize is off until asked for, because snapping a take
  // changes the feel of what was played.
  const clickBtn = document.getElementById('btn-click');
  if (clickBtn) {
    clickBtn.classList.toggle('on', !!app.song.click);
    clickBtn.addEventListener('click', () => {
      app.song.click = !app.song.click;
      clickBtn.classList.toggle('on', !!app.song.click);
      // A take that is already running keeps the click it started with; the
      // switch is about the next take.
      const running = app.song.recording;
      app.toast(
        app.song.click
          ? running
            ? 'Click on — the next take is counted in'
            : 'Click on — a bar of count-in at ' + (app.state.bpm || 120) + ' BPM, then the take'
          : running
            ? 'Click off — the next take starts on the tap'
            : 'Click off — every take starts on the tap'
      );
    });
  }

  const quantBtn = document.getElementById('btn-quantize');
  if (quantBtn) {
    quantBtn.classList.toggle('on', !!app.song.quantize);
    quantBtn.addEventListener('click', () => {
      app.song.quantize = !app.song.quantize;
      quantBtn.classList.toggle('on', !!app.song.quantize);
      if (!app.song.quantize) {
        app.toast('Quantize off — takes keep their own timing');
        return;
      }
      // Turning it on puts the take already in the channel on the grid too, so
      // the switch does something to a take that is already recorded.
      const recording = app.song.recording;
      const n =
        app.song.channel === LYRIC_CHANNEL || recording
          ? 0
          : quantizeTake(app.song.events, takeTempo());
      if (n) updateSongInfo();
      app.toast(
        recording
          ? 'Quantize on — this take is snapped when it stops'
          : n
            ? 'Quantize on — ' + n + (n === 1 ? ' note' : ' notes') + ' snapped to the sixteenth'
            : 'Quantize on — every take is snapped to the sixteenth'
      );
    });
  }

  const clear = document.getElementById('btn-clear-song');
  if (clear) {
    clear.addEventListener('click', () => {
      stopPlayback();
      clearAllChannels();
      updateSongInfo();
      app.toast('All five channels cleared');
    });
  }

  updateSongInfo();
  applyLiveChannel(app.song.channel);
}

// One keybed, drawn the same wherever it appears: the transport's keyboard and
// the one in the visualiser are built from here, so they always match.
function fillKeybed(el) {
  if (!el) return;
  el.innerHTML = '';

  const base = app.keyBase;
  const WHITE = [0, 2, 4, 5, 7, 9, 11];
  const BLACK = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 };

  const frag = document.createDocumentFragment();

  for (let o = 0; o < 2; o++) {
    for (const s of WHITE) {
      const midi = base + o * 12 + s;
      const el = document.createElement('div');
      el.className = 'key white';
      el.dataset.midi = String(midi);
      el.innerHTML = `<span class="lbl">${noteName(midi)}</span>`;
      frag.appendChild(el);
    }
  }
  const top = document.createElement('div');
  top.className = 'key white';
  top.dataset.midi = String(base + 24);
  top.innerHTML = `<span class="lbl">${noteName(base + 24)}</span>`;
  frag.appendChild(top);

  for (let o = 0; o < 2; o++) {
    for (const wi of [0, 1, 3, 4, 5]) {
      const midi = base + o * 12 + BLACK[wi];
      const el = document.createElement('div');
      el.className = 'key black';
      el.dataset.midi = String(midi);
      el.style.left = ((o * 7 + wi + 1) / 15) * 100 + '%';
      frag.appendChild(el);
    }
  }

  el.appendChild(frag);
}

// Every keybed drawn besides the transport's own: the visualiser mounts one, so
// music can be played while the picture runs. They share its notes, its octave
// and its pressed-key highlight.
const extraKeybeds = new Set();

export function mountKeybed(el) {
  if (!el || extraKeybeds.has(el)) return;
  extraKeybeds.add(el);
  fillKeybed(el);
  guardKeybed(el);
  el.addEventListener('pointerdown', onKeysDown);
  el.addEventListener('pointermove', onKeysMove);
}

// A keybed is played by holding a key, sliding off it and pressing again — never
// by selecting anything. A press that stays put on text is answered on iOS with
// its own menu, the magnifier and Copy, which opens over the keys while the note
// that started it still sounds and takes the next tap for itself. The keys hold
// nothing to copy, so every way a browser asks to begin a selection or raise
// that menu on the bed is turned down. css/app.css takes the callout away; this
// is the same answer for the events a long press becomes — a context menu, a
// selection starting, or a key dragged as if it were something to move.
function guardKeybed(el) {
  const block = (e) => e.preventDefault();
  el.addEventListener('contextmenu', block);
  el.addEventListener('selectstart', block);
  el.addEventListener('dragstart', block);
}

function keybedElements() {
  const list = [];
  if (keysEl) list.push(keysEl);
  for (const el of extraKeybeds) list.push(el);
  return list;
}

export function renderKeyboard() {
  fillKeybed(keysEl);
  for (const el of extraKeybeds) fillKeybed(el);
}

// The octave the extra keyboards carry, so the visualiser can be played on its
// own without closing it.
export function shiftKeyboardOctave(delta) {
  shiftOctave(delta);
}

function releaseAllKeys() {
  for (const info of activePointers.values()) {
    noteOff(info.midi);
    if (info.el) info.el.classList.remove('active');
  }
  activePointers.clear();
  for (const [key, midi] of heldComputer.entries()) {
    noteOff(midi);
    heldComputer.delete(key);
  }
}

function shiftOctave(delta) {
  releaseAllKeys();
  app.keyBase = Math.max(12, Math.min(72, app.keyBase + delta));
  renderKeyboard();
}

function onKeysDown(e) {
  const el = e.target.closest('.key');
  if (!el) return;
  e.preventDefault();
  const bed = e.currentTarget;
  try {
    if (bed && bed.setPointerCapture) bed.setPointerCapture(e.pointerId);
  } catch (err) {
    /* not fatal */
  }
  const midi = Number(el.dataset.midi);
  activePointers.set(e.pointerId, { midi, el, bed });
  noteOn(midi);
}

function onKeysMove(e) {
  const entry = activePointers.get(e.pointerId);
  if (!entry) return;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const key = under && under.closest ? under.closest('.key') : null;
  if (!key || key === entry.el) return;
  // A finger that slides off the keybed it started on ends the note rather than
  // carrying on with whatever key it happens to be over elsewhere on the page.
  if (entry.bed && !entry.bed.contains(key)) return;
  noteOff(entry.midi);
  const midi = Number(key.dataset.midi);
  activePointers.set(e.pointerId, { midi, el: key, bed: entry.bed });
  noteOn(midi);
}

function onPointerUp(e) {
  const entry = activePointers.get(e.pointerId);
  if (!entry) return;
  noteOff(entry.midi);
  activePointers.delete(e.pointerId);
}

function onComputerDown(e) {
  if (e.repeat) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  // A sheet on top owns the keyboard, whichever sheet it is.
  if (document.querySelector('.sheet.open')) return;
  const key = e.key.toLowerCase();
  const semi = COMPUTER_KEYS[key];
  if (semi == null) return;
  if (heldComputer.has(key)) return;
  const midi = app.keyBase + semi;
  heldComputer.set(key, midi);
  noteOn(midi);
}

function onComputerUp(e) {
  const key = e.key.toLowerCase();
  if (!heldComputer.has(key)) return;
  noteOff(heldComputer.get(key));
  heldComputer.delete(key);
}

// A note pressed before the audio is running — the very first tap, while the
// browser is still starting the context — sounds as the context opens instead of
// being dropped, so the first touch of a key is never silent. The note is short,
// as a tap on a key is.
function playWhenRunning(midi, vel) {
  const ctx = app.ctx;
  let resuming;
  try {
    resuming = ctx.resume ? ctx.resume() : Promise.resolve();
  } catch (e) {
    resuming = Promise.reject(e);
  }
  Promise.resolve(resuming).then(
    () => {
      if (!app.engine || !app.ctx || app.ctx !== ctx) return;
      if (ctx.state !== 'running') {
        app.toast('Tap Start audio to switch the synth on');
        return;
      }
      const t = ctx.currentTime;
      app.engine.noteOn(midi, t, vel);
      app.engine.noteOff(midi, t + 0.3);
    },
    () => app.toast('Tap Start audio to switch the synth on')
  );
}

export function noteOn(midi, vel = 0.85) {
  if (!app.ctx) return;
  // An empty rack has nothing to play the note: say so rather than let the key
  // look broken.
  if (!app.state.modules.length) {
    app.toast('The rack is empty — add a module with + Add module');
    return;
  }
  if (!app.engine) {
    app.toast('The audio engine could not start — reload the page');
    return;
  }
  if (app.ctx.state !== 'running') {
    playWhenRunning(midi, vel);
    return;
  }
  app.engine.noteOn(midi, app.ctx.currentTime, vel);
  // A lyric take records the voice, not the keys: the notes played over it are
  // heard but are not written into a channel of their own.
  if (app.song.recording && !app.song.lyricRecording && takeIsRunning()) {
    app.song.events.push({
      midi,
      start: Math.max(0, app.ctx.currentTime - app.song.recStart),
      end: null,
      vel
    });
  }
  highlight(midi, true);
}

export function noteOff(midi) {
  if (!app.engine || !app.ctx) return;
  app.engine.noteOff(midi, app.ctx.currentTime);
  if (app.song.recording && !app.song.lyricRecording && takeIsRunning()) {
    const t = Math.max(0, app.ctx.currentTime - app.song.recStart);
    for (let i = app.song.events.length - 1; i >= 0; i--) {
      const ev = app.song.events[i];
      if (ev.midi === midi && ev.end == null) {
        ev.end = Math.max(ev.start + 0.05, t);
        break;
      }
    }
  }
  highlight(midi, false);
  updateSongInfo();
}

function highlight(midi, on) {
  for (const bed of keybedElements()) {
    const el = bed.querySelector(`.key[data-midi="${midi}"]`);
    if (el) el.classList.toggle('active', on);
  }
}

// Channels ------------------------------------------------------------------

// Switch which channel Rec writes to. Takes stay independent, so each can be
// recorded on its own and played or mixed with the others afterwards. The fifth
// channel is the lyric one: Rec there records a voice take instead of notes.
export function selectChannel(i) {
  if (!(i >= 0 && i < CHANNEL_COUNT)) return;
  // The channel already chosen asks for nothing — in particular it must not be
  // read as a change of channel while a take is running, which would answer a
  // tap on the lit button with "Stop recording before you change channel".
  if (i === app.song.channel) {
    updateChannels();
    return;
  }
  if (startingLyrics) {
    app.toast('The microphone is still starting');
    return;
  }
  if (app.song.recording) {
    app.toast('Stop recording before you change channel');
    return;
  }
  setChannel(i);
  // The live synth plays under the knob of the channel Rec would record to, so
  // a part is heard at the level it will play back at.
  applyLiveChannel(i);
  updateSongInfo();
  if (i === LYRIC_CHANNEL) {
    const take = app.song.lyrics;
    app.toast(
      'Channel 5 · lyrics ' +
        (take && take.buffer ? take.buffer.duration.toFixed(1) + 's' : '— empty')
    );
    return;
  }
  const n = app.song.channels[i].length;
  app.toast('Channel ' + (i + 1) + (n ? ' — ' + n + ' notes' : ' — empty'));
}

// Channel volume knobs ------------------------------------------------------

// The five knobs above the keyboard set how loud each part is in the mix: the
// note channels are trimmed as they join the voice bus, and the lyric take on
// its way into the rack. A part is heard at its knob while it plays, so a mix
// can be balanced without stopping the song.
//
// A knob turns through 270°, and its travel is measured in decibels rather than
// in linear gain: silence at the bottom, 0 dB at the top of the useful part of
// the sweep — unity, the level a part was recorded at — and +6 dB at the end of
// the turn. The decibel taper is what makes it easy to set finely: near unity a
// pixel of drag is about a third of a decibel, while the long way down reaches
// a full 60 dB, so a part can be tucked right under a mix without the bottom of
// the travel turning into a switch between loud and gone.
const KNOB_MIN_DB = -60; // the quietest the knob sets, a breath above silence
const KNOB_MAX_DB = 20 * Math.log10(MAX_CHANNEL_VOLUME); // +6 dB: twice the level
const KNOB_SWING = 270; // degrees the pointer turns through, silence to full
const KNOB_TRAVEL = 190; // pixels of drag that cover the whole turn
const KNOB_FINE = 4; // hold shift to drag a quarter as fast
const KNOB_QUIET = 0.0005; // below this the channel is off, not quietly playing
const KNOB_DOUBLE_TAP = 320; // ms: a second tap within this puts the knob back

// One drag at a time: which knob, which finger, and where it started from. The
// drag is relative — it moves the level from where it found it — so a touch
// never makes the value jump to wherever it landed.
let knobDrag = null;
let knobTap = { channel: -1, at: 0 };

function knobChannel(el) {
  const i = el && el.dataset ? Number(el.dataset.channel) : -1;
  return i >= 0 && i < CHANNEL_COUNT ? i : -1;
}

function knobDb(gain) {
  return gain > KNOB_QUIET ? Math.max(KNOB_MIN_DB, 20 * Math.log10(gain)) : KNOB_MIN_DB;
}

function gainFromDb(db) {
  const d = Math.max(KNOB_MIN_DB, Math.min(KNOB_MAX_DB, Number(db)));
  if (!Number.isFinite(d) || d <= KNOB_MIN_DB + 0.01) return 0;
  return Math.pow(10, d / 20);
}

// Where the knob points for a level: 0 at silence, 1 at full.
function knobFraction(gain) {
  if (!(gain > KNOB_QUIET)) return 0;
  const f = (knobDb(Math.min(gain, MAX_CHANNEL_VOLUME)) - KNOB_MIN_DB) / (KNOB_MAX_DB - KNOB_MIN_DB);
  return Math.max(0, Math.min(1, f));
}

function knobGain(fraction) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  return gainFromDb(KNOB_MIN_DB + f * (KNOB_MAX_DB - KNOB_MIN_DB));
}

// The readout under the dial: decibels to a tenth, with the sign it needs.
function knobText(gain) {
  if (!(gain > KNOB_QUIET)) return 'off';
  const tenths = Math.round(20 * Math.log10(gain) * 10) / 10;
  if (tenths > 0) return '+' + tenths.toFixed(1);
  if (tenths < 0) return '\u2212' + Math.abs(tenths).toFixed(1);
  return '0.0';
}

// Draw one knob: the filled part of its ring, the pointer, and its readout.
function paintKnob(el, gain) {
  if (!el) return;
  const frac = knobFraction(gain);
  el.style.setProperty('--knob-angle', (-KNOB_SWING / 2 + frac * KNOB_SWING).toFixed(2) + 'deg');
  el.style.setProperty('--knob-sweep', (frac * KNOB_SWING).toFixed(2) + 'deg');
  el.classList.toggle('off', !(gain > KNOB_QUIET));
  const val = el.querySelector('.knob-val');
  if (val) val.textContent = knobText(gain);
  el.setAttribute('aria-valuenow', String(Math.round(knobDb(gain))));
  el.setAttribute('aria-valuetext', gain > KNOB_QUIET ? knobText(gain) + ' dB' : 'off');
}

function initChannelVolumes() {
  const row = document.getElementById('channel-vols');
  if (!row) return;
  for (const el of row.querySelectorAll('.knob[data-channel]')) {
    el.addEventListener('pointerdown', onKnobDown);
    el.addEventListener('pointermove', onKnobMove);
    el.addEventListener('pointerup', onKnobUp);
    el.addEventListener('pointercancel', onKnobUp);
    el.addEventListener('lostpointercapture', onKnobUp);
  }
  row.addEventListener('keydown', onKnobKey);
  syncChannelVolumes();
}

function onKnobDown(e) {
  const el = e.target && e.target.closest ? e.target.closest('.knob') : null;
  if (!el) return;
  // Only the primary button: a right-click or a middle-click is not a turn.
  if (e.button != null && e.button > 0) return;
  const i = knobChannel(el);
  if (i < 0) return;
  e.preventDefault();
  // Focus follows the finger, so the arrow keys turn the knob just touched.
  try {
    el.focus({ preventScroll: true });
  } catch (err) {
    /* focus is a nicety: the knob still turns */
  }

  // A second tap in the same place puts the channel back at unity, the level
  // every part is recorded at, however far the knob was turned.
  const at = Date.now();
  if (knobTap.channel === i && at - knobTap.at < KNOB_DOUBLE_TAP) {
    knobTap = { channel: -1, at: 0 };
    knobDrag = null;
    el.classList.remove('dragging');
    applyChannelVolume(i, 1);
    app.toast('Channel ' + (i + 1) + ' back at 0 dB');
    return;
  }
  knobTap = { channel: i, at };

  knobDrag = {
    el,
    channel: i,
    pointerId: e.pointerId,
    startY: e.clientY,
    startFrac: knobFraction(channelVolume(i))
  };
  el.classList.add('dragging');
  try {
    el.setPointerCapture(e.pointerId);
  } catch (err) {
    /* a browser without capture still gets the moves over the knob */
  }
}

function onKnobMove(e) {
  if (!knobDrag || e.pointerId !== knobDrag.pointerId) return;
  e.preventDefault();
  // Up is louder: the drag is measured from where the finger went down, so the
  // level never jumps, and shift makes it four times as fine.
  const dy = (knobDrag.startY - e.clientY) / KNOB_TRAVEL;
  const frac = knobDrag.startFrac + dy * (e.shiftKey ? 1 / KNOB_FINE : 1);
  applyChannelVolume(knobDrag.channel, knobGain(frac));
}

function onKnobUp(e) {
  if (!knobDrag) return;
  if (e && e.pointerId != null && e.pointerId !== knobDrag.pointerId) return;
  const el = knobDrag.el;
  const id = knobDrag.pointerId;
  knobDrag = null;
  el.classList.remove('dragging');
  try {
    el.releasePointerCapture(id);
  } catch (err) {
    /* already released */
  }
}

// A computer keyboard turns the knob too: arrows by half a decibel, page keys by
// three, Home and End to the ends.
function onKnobKey(e) {
  const el = e.target && e.target.closest ? e.target.closest('.knob') : null;
  if (!el) return;
  const i = knobChannel(el);
  if (i < 0) return;
  const step = e.shiftKey ? 0.1 : 0.5;
  let db = knobDb(channelVolume(i));
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowRight':
      db += step;
      break;
    case 'ArrowDown':
    case 'ArrowLeft':
      db -= step;
      break;
    case 'PageUp':
      db += 3;
      break;
    case 'PageDown':
      db -= 3;
      break;
    case 'Home':
      db = KNOB_MIN_DB;
      break;
    case 'End':
      db = KNOB_MAX_DB;
      break;
    default:
      return;
  }
  e.preventDefault();
  applyChannelVolume(i, gainFromDb(db));
}

function applyChannelVolume(i, value) {
  if (!(i >= 0 && i < CHANNEL_COUNT)) return;
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.max(0, Math.min(MAX_CHANNEL_VOLUME, n)) : 1;
  app.song.volumes[i] = v;
  setChannelVolume(i, v);
  if (i === LYRIC_CHANNEL) setLyricVolume(v);
  else if (i === app.song.channel) applyLiveChannel(i);
  syncChannelVolumes();
}

// Put the knobs back where the song has them — on load, and after an import.
function syncChannelVolumes() {
  const row = document.getElementById('channel-vols');
  if (!row) return;
  for (const el of row.querySelectorAll('.knob[data-channel]')) {
    const i = knobChannel(el);
    if (i < 0) continue;
    paintKnob(el, channelVolume(i));
  }
}

function updateChannels() {
  const bar = document.getElementById('channel-bar');
  if (!bar) return;
  for (const btn of bar.querySelectorAll('.chan')) {
    const i = Number(btn.dataset.channel);
    // The lyric channel holds audio rather than notes, so a dot means it has a
    // take rather than that it has events.
    const has =
      i === LYRIC_CHANNEL ? hasLyrics() : (app.song.channels[i] || []).length > 0;
    btn.classList.toggle('on', i === app.song.channel);
    btn.classList.toggle('has', has);
  }
}

// The Rec button says what a take will hold: notes on channels 1–4, the voice on
// the lyric channel.
function syncRecordLabel() {
  const btn = document.getElementById('btn-rec');
  if (!btn || app.song.recording) return;
  btn.textContent = app.song.channel === LYRIC_CHANNEL ? '\u25CF Rec voice' : '\u25CF Rec';
}

export function updateSongInfo() {
  const el = document.getElementById('song-info');
  if (!el) return;
  if (app.song.recording) {
    const left = countInLeft();
    if (left > 0) {
      const beat = 60 / (app.state.bpm || 120);
      el.textContent =
        'rec Ch ' + (app.song.channel + 1) + ' · count-in ' + Math.ceil(left / beat);
    } else {
      el.textContent = app.song.lyricRecording
        ? 'rec Ch 5 · lyrics…'
        : 'rec Ch ' + (app.song.channel + 1) + '…';
    }
  } else if (app.song.channel === LYRIC_CHANNEL) {
    const take = app.song.lyrics;
    el.textContent =
      'Ch 5 · ' +
      (take && take.buffer ? 'lyrics ' + take.buffer.duration.toFixed(1) + 's' : 'empty');
  } else {
    const evs = app.song.events;
    const label = 'Ch ' + (app.song.channel + 1);
    const n = evs.length;
    el.textContent =
      label +
      ' · ' +
      (n ? n + (n === 1 ? ' note' : ' notes') + ' · ' + songLength(evs).toFixed(1) + 's' : 'empty');
  }
  updateChannels();
  syncChannelVolumes();
  syncRecordLabel();
}

// Recording -----------------------------------------------------------------

function toggleRecord() {
  if (!app.ctx) {
    app.toast('Start the audio first');
    return;
  }
  if (startingLyrics) {
    app.toast('The microphone is still starting');
    return;
  }
  if (!app.song.recording) {
    if (app.song.channel === LYRIC_CHANNEL) startLyricRecording();
    else startRecording();
  } else if (app.song.lyricRecording) {
    stopLyricRecording();
  } else {
    stopRecording();
  }
  updateSongInfo();
}

// A take with a count-in has not begun until the click reaches the downbeat: the
// keys are heard, but nothing is written down until then. A note played just
// before the beat is taken as the take's first rather than dropped.
function takeIsRunning() {
  if (!app.ctx) return false;
  return app.ctx.currentTime >= app.song.recStart - REC_LEAD_GRACE;
}

function startRecording() {
  stopPlayback();
  const ch = app.song.channel;
  const take = app.song.channels[ch];
  take.length = 0; // a new take replaces this channel only, not the song
  app.song.events = take;
  // The rack this take is made with is kept with the channel: played back or
  // mixed down later, the channel goes through that rack and not the one on
  // screen then. A sample held by a Sampler travels with it.
  app.song.racks[ch] = snapshotRack();
  app.song.recording = true;
  const btn = document.getElementById('btn-rec');
  if (btn) btn.classList.add('on');

  const label = 'channel ' + (ch + 1);
  const beat = 60 / (app.state.bpm || 120);

  // With the click on, the take is counted in for a bar and begins on the
  // downbeat, so every part is played against the same grid and Quantize has
  // something to snap to. With it off, the take begins on the tap as it always
  // did.
  const countIn = app.song.click ? COUNT_IN_BEATS : 0;
  const startAt = app.ctx.currentTime + (countIn ? 0.12 + countIn * beat : 0.1);

  app.song.recStart = startAt;

  if (countIn) {
    countInEnd = startAt;
    startClick({ from: startAt, countIn, bpm: app.state.bpm, keepGoing: true });
    startCountInClock();
  }

  // The other channels play along, from that same downbeat, so a part recorded
  // against them keeps their timing on the shared mix timeline — each through
  // its own rack. The lyric take plays too: it is part of the song, and a part
  // recorded after it should follow it.
  const backing = recordedChannels(ch);
  if (backing.length || hasLyrics()) {
    playChannels(backing, null, { when: startAt });
    app.toast(
      countIn
        ? 'Recording ' +
            label +
            ' — ' +
            countIn +
            ' beats of count-in, then play; the other channels play along'
        : 'Recording ' + label + ' — the other channels play along'
    );
  } else if (countIn) {
    app.toast(
      'Recording ' + label + ' — ' + countIn + ' beats of count-in, then play'
    );
  } else {
    app.toast('Recording ' + label + ' — play the keys');
  }
}

function stopRecording() {
  const btn = document.getElementById('btn-rec');
  app.song.recording = false;
  if (btn) btn.classList.remove('on');
  stopClick();
  clearCountInClock();
  stopPlayback(); // an accompanying take stops with the recording
  const t = app.ctx ? Math.max(0, app.ctx.currentTime - app.song.recStart) : 0;
  for (const ev of app.song.events) {
    if (ev.end == null) ev.end = Math.max(ev.start + 0.1, t);
  }
  // Quantize is the last step of a take: the notes are put on the grid the click
  // counted in, once the take has stopped and every note has its end.
  let snapped = 0;
  if (app.song.quantize && app.song.events.length) {
    snapped = quantizeTake(app.song.events, takeTempo());
  }
  updateSongInfo();
  if (snapped) {
    app.toast(
      'Take quantized — ' +
        snapped +
        (snapped === 1 ? ' note' : ' notes') +
        ' on the sixteenth'
    );
  }
}

// How much of a count-in is left, in seconds, or 0 when the take has begun.
function countInLeft() {
  if (!app.song.recording || !app.ctx) return 0;
  const left = countInEnd - app.ctx.currentTime;
  return left > 0 ? left : 0;
}

// The info line counts the bar in, so it is clear the take has not started yet.
function startCountInClock() {
  clearInterval(countInTimer);
  countInTimer = setInterval(() => {
    if (countInLeft() <= 0) {
      clearCountInClock();
      updateSongInfo();
      return;
    }
    updateSongInfo();
  }, 100);
}

function clearCountInClock() {
  if (countInTimer) clearInterval(countInTimer);
  countInTimer = null;
  countInEnd = 0;
}

// The tempo a take was made at: the BPM the channel's own rack was recorded
// with, so quantizing follows the take rather than the BPM field afterwards.
function takeTempo() {
  const rack = app.song.racks[app.song.channel];
  return (rack && rack.bpm) || app.state.bpm || 120;
}

// Snap a take to the sixteenth of its own tempo. The click counted the take in,
// so a note played a little early or late lands on the beat it meant; a note
// whose start and end round onto the same line is kept at half a step rather
// than becoming nothing. Returns how many notes were moved.
function quantizeTake(events, bpm) {
  const tempo = Number(bpm) || 120;
  const step = 60 / tempo / QUANT_STEPS;
  const shortest = step * 0.5;
  for (const ev of events) {
    ev.start = Math.max(0, Math.round(ev.start / step) * step);
    const end = ev.end == null ? ev.start + shortest : Math.round(ev.end / step) * step;
    ev.end = Math.max(ev.start + shortest, end);
  }
  events.sort((a, b) => a.start - b.start);
  return events.length;
}

// The lyric channel ---------------------------------------------------------
//
// Rec on channel 5 records the voice rather than the keys. The take is captured
// on the same timeline as the other channels — they play along as its backing —
// and what it holds is kept for playback and mixed into every export.

// Ask for the microphone and, once it is there, start the take. The request goes
// out with the tap itself, inside startLyricRecording's synchronous part, because
// a browser will only answer a prompt it can trace back to the player's gesture.
function startLyricRecording() {
  if (startingLyrics || app.song.recording) return;
  if (!app.ctx || !app.engine) {
    app.toast('Start the audio first');
    return;
  }
  startingLyrics = true;
  const attempt = ++lyricAttempt;
  const request = requestLyricMic();
  app.toast('Getting a microphone for your lyrics…', 6000);
  beginLyricTake(request, attempt)
    .catch((e) => {
      console.error(e);
      app.toast('Could not start the lyric take');
      stopPlayback();
    })
    .finally(() => {
      if (attempt === lyricAttempt) startingLyrics = false;
      updateSongInfo();
    });
}

async function beginLyricTake(request, attempt) {
  // A browser can leave a request unanswered — a web view that will not hand a
  // microphone over often does — so the take does not wait on it forever.
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ stream: null, reason: 'timeout' }), LYRIC_MIC_WAIT_MS)
  );
  const result = await Promise.race([
    Promise.resolve(request).catch((e) => ({
      stream: null,
      reason: (e && e.name) || 'unavailable'
    })),
    timeout
  ]);

  const stream = result && result.stream;
  if (attempt !== lyricAttempt) {
    // The take was given up on while the answer was on its way: let go of a
    // microphone nobody is recording into.
    if (stream) stopLyricStream(stream);
    return;
  }
  if (!stream) {
    micRefusedByTake(result && result.reason);
    sayMicTrouble(result && result.reason);
    return;
  }

  if (!app.ctx) {
    stopLyricStream(stream);
    app.toast('Start the audio first');
    return;
  }
  // Opening a microphone can interrupt the context, and a stream source joined
  // to an interrupted context records silence.
  if (app.ctx.state !== 'running') {
    try {
      await app.ctx.resume();
    } catch (e) {
      /* the check below says so */
    }
  }
  if (app.ctx.state !== 'running') {
    stopLyricStream(stream);
    app.toast('Tap Start audio first');
    return;
  }

  // The recorder is built and joined to the microphone first, so that once the
  // backing and the voice share a start time there is nothing left to wait for.
  const armed = await armLyricCapture(stream);
  if (attempt !== lyricAttempt) {
    stopLyricStream(stream);
    return;
  }
  if (!armed) {
    stopLyricStream(stream);
    app.toast('This browser cannot capture the lyrics');
    return;
  }

  // The note channels play from a known moment, so the voice can start at the
  // same one and the two line up sample for sample. With the click on, that
  // moment is the downbeat after a bar of count-in, so the lyric lands on the
  // same grid as the parts it is sung over.
  stopPlayback();
  const beat = 60 / (app.state.bpm || 120);
  const countIn = app.song.click ? COUNT_IN_BEATS : 0;
  const startAt = app.ctx.currentTime + LYRIC_START_LEAD + countIn * beat;
  const backing = recordedChannels();
  if (!beginLyricCapture(startAt)) {
    app.toast('This browser cannot capture the lyrics');
    return;
  }
  if (backing.length) {
    playChannels(backing, null, { when: startAt, lyrics: false });
  }

  app.song.recStart = startAt;
  app.song.recording = true;
  app.song.lyricRecording = true;
  micGrantedByTake();

  // The count-in is the count-in only: a click under the take would be picked up
  // by the microphone, and the backing already holds the beat. So the voice is
  // never recorded over a click.
  if (countIn) {
    countInEnd = startAt;
    startClick({ from: startAt, countIn, bpm: app.state.bpm, keepGoing: false });
    startCountInClock();
  }

  const btn = document.getElementById('btn-rec');
  if (btn) btn.classList.add('on');
  startLyricClock();
  lyricStopTimer = setTimeout(() => {
    if (!app.song.lyricRecording) return;
    app.toast('Five minutes is the longest lyric take');
    stopLyricRecording();
  }, LYRIC_MAX_SECONDS * 1000);

  updateSongInfo();
  app.toast(
    countIn
      ? 'Lyrics recording after a ' + countIn + ' beat count-in — then sing'
      : backing.length
        ? 'Recording your lyrics over the other channels — tap ● Rec to stop'
        : 'Recording your lyrics — tap ● Rec to stop',
    7000
  );
}

// What to say when the microphone did not open. A browser that is never asked on
// iOS has the site's own link in Safari to offer instead.
function sayMicTrouble(reason) {
  if (reason === 'webview' || reason === 'closed' || micInAppBrowser()) {
    offerMicInSafari(true);
    return;
  }
  app.toast(micProblem(reason || 'unavailable') + ' — the lyrics need a microphone', 10000);
}

function startLyricClock() {
  clearInterval(lyricClock);
  lyricClock = setInterval(() => {
    if (!app.song.lyricRecording) {
      clearInterval(lyricClock);
      lyricClock = null;
      return;
    }
    const el = document.getElementById('song-info');
    if (!el || !app.ctx) return;
    // The count-in line is the info line while the bar is being counted.
    if (countInLeft() > 0) return;
    const secs = Math.max(0, app.ctx.currentTime - app.song.recStart);
    el.textContent = 'rec Ch 5 · lyrics ' + secs.toFixed(1) + 's';
  }, 200);
}

function clearLyricTimers() {
  if (lyricStopTimer) clearTimeout(lyricStopTimer);
  lyricStopTimer = null;
  if (lyricClock) clearInterval(lyricClock);
  lyricClock = null;
}

// Finish the take. The capture is stopped first, the backing with it, and the
// buffer is built from what the audio thread sent before anything is said about
// it — so what is kept is what was recorded, and it stays in the channel for
// playback until another take replaces it or the song is cleared.
async function stopLyricRecording() {
  clearLyricTimers();
  stopClick();
  clearCountInClock();
  if (!app.song.lyricRecording) return;

  app.song.lyricRecording = false;
  app.song.recording = false;
  const btn = document.getElementById('btn-rec');
  if (btn) btn.classList.remove('on');

  stopPlayback();
  updateSongInfo();
  app.toast('Finishing the lyric take…');

  let take = null;
  try {
    take = await stopLyricCapture();
  } catch (e) {
    console.error('Could not finish the lyric take', e);
  }

  if (take && take.buffer && take.buffer.duration > 0.05) {
    app.song.lyrics = take;
    app.toast(
      'Lyrics recorded — ' + take.buffer.duration.toFixed(1) + 's in channel 5',
      6000
    );
  } else {
    app.toast('No lyrics were picked up — check the microphone and try again', 6000);
  }
  updateSongInfo();
}

// Finish a take if one is running. Swapping the rack — a preset, Clear rack,
// Default rack — rebuilds the engine, and a take left running would go on
// stamping its notes from a start time that no longer means anything. A lyric
// take is stopped the same way, though its buffer arrives a moment later.
export function stopRecordingNow() {
  // A lyric take whose microphone has not answered yet is given up on rather
  // than left to start after the rack it was meant for is gone.
  if (startingLyrics) {
    lyricAttempt++;
    startingLyrics = false;
  }
  if (!app.song.recording) return false;
  if (app.song.lyricRecording) stopLyricRecording();
  else stopRecording();
  return true;
}

// Playback ------------------------------------------------------------------

// Plays recorded channels from now, each through the rack it was recorded with,
// calling onFinish when the last note has had its tail. The lyric take is audio,
// so it starts on the same clock beside them unless the caller wants the notes
// alone — a lyric take being recorded plays no lyrics of its own.
function playChannels(channels, onFinish, opts) {
  const voices = openVoices(channels);
  return scheduleGroups(voices.groups, onFinish, {
    when: opts && opts.when,
    lyrics: !(opts && opts.lyrics === false),
    dispose: voices.dispose
  });
}

// Plays one engine's own events — the demo tune, which is not the song.
function playEvents(events, onFinish, opts) {
  return scheduleGroups([{ engine: app.engine, events }], onFinish, opts);
}

// The one clock every channel is played on, so parts recorded on different racks
// still line up. Each event names the engine it goes through: the channel's own
// graph, built from that channel's rack snapshot.
function scheduleGroups(groups, onFinish, opts) {
  const withLyrics = !(opts && opts.lyrics === false);
  const items = [];
  let end = 0;

  for (const g of groups) {
    for (const ev of g.events) {
      items.push({ engine: g.engine, ev });
      const e = ev.end == null ? ev.start + 0.3 : ev.end;
      if (e > end) end = e;
    }
  }
  items.sort((a, b) => a.ev.start - b.ev.start);

  const startAt =
    opts && Number.isFinite(opts.when) ? opts.when : app.ctx.currentTime + 0.1;
  const state = {
    items,
    startAt,
    index: 0,
    timer: null,
    stopped: false,
    onFinish,
    // The engines this playback built for its channels, to be let go when it
    // ends or is stopped.
    dispose: (opts && opts.dispose) || null,
    // The song runs as long as whichever goes on longer: the notes or the voice.
    end: Math.max(end, withLyrics ? lyricEnd() : 0, 0.5)
  };
  playback = state;

  if (withLyrics) playLyrics(startAt);

  const tick = () => {
    if (state.stopped) return;
    const horizon = app.ctx.currentTime + 0.3;
    while (state.index < state.items.length) {
      const { engine, ev } = state.items[state.index];
      if (state.startAt + ev.start > horizon) break;
      engine.noteOn(ev.midi, state.startAt + ev.start, ev.vel);
      engine.noteOff(ev.midi, state.startAt + (ev.end == null ? ev.start + 0.25 : ev.end));
      state.index++;
    }
    if (app.ctx.currentTime > state.startAt + state.end + 0.4) {
      state.stopped = true;
      clearInterval(state.timer);
      releasePlayback(state);
      if (state.onFinish) state.onFinish();
    }
  };

  tick();
  state.timer = setInterval(tick, 60);
  return state;
}

// Let go of a playback's own channel engines, if it built any.
function releasePlayback(state) {
  if (!state || !state.dispose) return;
  const dispose = state.dispose;
  state.dispose = null;
  try {
    dispose();
  } catch (e) {
    /* ignore */
  }
}

export function startPlayback() {
  if (!app.engine || !app.ctx) return;
  if (app.ctx.state !== 'running') {
    app.ctx.resume().catch(() => {});
    app.toast('Tap Start audio to switch the synth on');
    return;
  }
  if (app.song.recording) {
    app.toast('Stop recording first');
    return;
  }
  const channels = recordedChannels();
  if (!channels.length && !hasLyrics()) {
    app.toast('Nothing recorded yet — tap Rec, then play the keys or sing the lyrics');
    return;
  }
  stopPlayback();
  app.song.playing = true;
  const btn = document.getElementById('btn-play');
  if (btn) btn.classList.add('on');
  // Play plays what Mix saves: every channel together, each through the rack it
  // was recorded with, and the lyric channel too.
  const run = () => {
    playChannels(channels, () => {
      if (app.song.loop && app.song.playing) run();
      else stopPlayback();
    });
  };
  run();
}

// Play a list of events once — the demo tune uses this. Returns false when the
// audio is not on yet, so the caller can tell the user rather than sit silent.
export function playTune(events, opts = {}) {
  if (!app.engine || !app.ctx) return false;
  if (app.song.recording) {
    app.toast('Stop recording first');
    return false;
  }

  const start = () => {
    stopPlayback();
    app.song.playing = true;
    const btn = document.getElementById('btn-play');
    if (btn) btn.classList.add('on');
    const list = events.slice().sort((a, b) => a.start - b.start);
    const run = () => {
      // A tune of its own is not the song: the recorded lyric channel stays out
      // of it.
      playEvents(
        list,
        () => {
          if (opts.loop && app.song.playing) {
            run();
            return;
          }
          stopPlayback();
          if (opts.onFinish) opts.onFinish();
        },
        { lyrics: false }
      );
    };
    run();
  };

  if (app.ctx.state !== 'running') {
    app.ctx
      .resume()
      .then(start)
      .catch(() => app.toast('Tap Start audio to switch the synth on'));
    return true;
  }
  start();
  return true;
}

export function stopPlayback() {
  app.song.playing = false;
  const btn = document.getElementById('btn-play');
  if (btn) btn.classList.remove('on');
  if (playback) {
    playback.stopped = true;
    if (playback.timer) clearInterval(playback.timer);
    // The engines built for the channels go with the playback that built them.
    releasePlayback(playback);
    playback = null;
  }
  // The lyric take is stopped with everything else, and the rack gets its own
  // level back.
  stopLyrics();
  // A click and its count-in belong to a take, so they go with the transport:
  // nothing keeps clicking after the recording that asked for it has stopped.
  stopClick();
  clearCountInClock();
  if (app.engine && app.ctx) app.engine.allNotesOff(app.ctx.currentTime);
}

// Play the mix once and resolve when it ends. Used by the Ogg recorder, which
// captures the live output in real time — the lyric channel included, because it
// is part of what the speakers play.
export function playOnce() {
  return new Promise((resolve) => {
    if (!app.engine || !app.ctx) {
      resolve();
      return;
    }
    stopPlayback();
    const channels = recordedChannels();
    if (!channels.length && !hasLyrics()) {
      const t = app.ctx.currentTime + 0.1;
      app.engine.noteOn(60, t, 0.9);
      app.engine.noteOff(60, t + 1.8);
      setTimeout(resolve, 3200);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // The take and the headroom it asked for go with the mix, so the live
      // rack is back to its own level once the recorder has stopped.
      stopPlayback();
      resolve();
    };
    playChannels(channels, finish);
    setTimeout(finish, (Math.max(songLength(mixEvents()), lyricEnd()) + 4) * 1000);
  });
}
