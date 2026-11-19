// Virtual keyboard, recording and transport.

import {
  app,
  songLength,
  mixEvents,
  setChannel,
  clearAllChannels,
  CHANNEL_COUNT
} from './app.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const COMPUTER_KEYS = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17
};

let keysEl = null;
let playback = null;
const activePointers = new Map();
const heldComputer = new Map();

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

export function initKeyboard() {
  keysEl = document.getElementById('keys');
  renderKeyboard();

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

  const rec = document.getElementById('btn-rec');
  if (rec) rec.addEventListener('click', toggleRecord);

  const play = document.getElementById('btn-play');
  if (play) {
    play.addEventListener('click', () => {
      if (app.song.playing) {
        stopPlayback();
      } else if (!mixEvents().length) {
        app.toast('Nothing recorded yet — tap Rec, then play the keys');
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

  const clear = document.getElementById('btn-clear-song');
  if (clear) {
    clear.addEventListener('click', () => {
      stopPlayback();
      clearAllChannels();
      updateSongInfo();
      app.toast('All four channels cleared');
    });
  }

  updateSongInfo();
}

export function renderKeyboard() {
  if (!keysEl) return;
  keysEl.innerHTML = '';

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

  keysEl.appendChild(frag);
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
  try {
    keysEl.setPointerCapture(e.pointerId);
  } catch (err) {
    /* not fatal */
  }
  const midi = Number(el.dataset.midi);
  activePointers.set(e.pointerId, { midi, el });
  noteOn(midi);
}

function onKeysMove(e) {
  const entry = activePointers.get(e.pointerId);
  if (!entry) return;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const key = under && under.closest ? under.closest('.key') : null;
  if (key && key !== entry.el) {
    noteOff(entry.midi);
    const midi = Number(key.dataset.midi);
    activePointers.set(e.pointerId, { midi, el: key });
    noteOn(midi);
  }
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
  const sheet = document.getElementById('module-sheet');
  if (sheet && sheet.classList.contains('open')) return;
  const mixSheet = document.getElementById('mix-sheet');
  if (mixSheet && mixSheet.classList.contains('open')) return;
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

export function noteOn(midi, vel = 0.85) {
  if (!app.engine || !app.ctx) return;
  if (app.ctx.state !== 'running') {
    app.ctx.resume().catch(() => {});
    app.toast('Tap Start audio to switch the synth on');
    return;
  }
  app.engine.noteOn(midi, app.ctx.currentTime, vel);
  if (app.song.recording) {
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
  if (app.song.recording) {
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
  if (!keysEl) return;
  const el = keysEl.querySelector(`.key[data-midi="${midi}"]`);
  if (el) el.classList.toggle('active', on);
}

// Channels ------------------------------------------------------------------

// Switch which channel Rec writes to. Takes stay independent, so each can be
// recorded on its own and played or mixed with the others afterwards.
export function selectChannel(i) {
  if (!(i >= 0 && i < CHANNEL_COUNT)) return;
  if (app.song.recording) {
    app.toast('Stop recording before you change channel');
    return;
  }
  if (i === app.song.channel) {
    updateChannels();
    return;
  }
  setChannel(i);
  updateSongInfo();
  const n = app.song.channels[i].length;
  app.toast('Channel ' + (i + 1) + (n ? ' — ' + n + ' notes' : ' — empty'));
}

function updateChannels() {
  const bar = document.getElementById('channel-bar');
  if (!bar) return;
  for (const btn of bar.querySelectorAll('.chan')) {
    const i = Number(btn.dataset.channel);
    btn.classList.toggle('on', i === app.song.channel);
    btn.classList.toggle('has', (app.song.channels[i] || []).length > 0);
  }
}

export function updateSongInfo() {
  const el = document.getElementById('song-info');
  if (!el) return;
  const evs = app.song.events;
  const label = 'Ch ' + (app.song.channel + 1);
  if (app.song.recording) {
    el.textContent = 'rec ' + label + '…';
  } else {
    const n = evs.length;
    el.textContent =
      label +
      ' · ' +
      (n ? n + (n === 1 ? ' note' : ' notes') + ' · ' + songLength(evs).toFixed(1) + 's' : 'empty');
  }
  updateChannels();
}

// Recording -----------------------------------------------------------------

function toggleRecord() {
  const btn = document.getElementById('btn-rec');
  if (!app.ctx) {
    app.toast('Start the audio first');
    return;
  }
  if (!app.song.recording) startRecording();
  else stopRecording();
  updateSongInfo();
}

function startRecording() {
  stopPlayback();
  const take = app.song.channels[app.song.channel];
  take.length = 0; // a new take replaces this channel only, not the song
  app.song.events = take;
  app.song.recording = true;
  const btn = document.getElementById('btn-rec');
  if (btn) btn.classList.add('on');

  const label = 'channel ' + (app.song.channel + 1);

  // The other channels play along, so a part can be recorded against them and
  // keeps their timing on the shared mix timeline.
  const backing = mixEvents(app.song.channel);
  if (backing.length) {
    const state = playEvents(backing, null);
    app.song.recStart = state.startAt;
    app.toast('Recording ' + label + ' — the other channels play along');
  } else {
    app.song.recStart = app.ctx.currentTime;
    app.toast('Recording ' + label + ' — play the keys');
  }
}

function stopRecording() {
  const btn = document.getElementById('btn-rec');
  app.song.recording = false;
  if (btn) btn.classList.remove('on');
  stopPlayback(); // an accompanying take stops with the recording
  const t = app.ctx ? Math.max(0, app.ctx.currentTime - app.song.recStart) : 0;
  for (const ev of app.song.events) {
    if (ev.end == null) ev.end = Math.max(ev.start + 0.1, t);
  }
  updateSongInfo();
}

// Playback ------------------------------------------------------------------

// Plays a list of events from now, calling onFinish when the last one has had
// its tail. The channels' own takes are passed in one at a time.
function playEvents(events, onFinish) {
  const list = events.slice().sort((a, b) => a.start - b.start);
  const startAt = app.ctx.currentTime + 0.1;
  const state = {
    events: list,
    startAt,
    index: 0,
    timer: null,
    stopped: false,
    onFinish,
    end: songLength(list)
  };
  playback = state;

  const tick = () => {
    if (state.stopped) return;
    const horizon = app.ctx.currentTime + 0.3;
    while (state.index < state.events.length) {
      const ev = state.events[state.index];
      if (state.startAt + ev.start > horizon) break;
      app.engine.noteOn(ev.midi, state.startAt + ev.start, ev.vel);
      app.engine.noteOff(
        ev.midi,
        state.startAt + (ev.end == null ? ev.start + 0.25 : ev.end)
      );
      state.index++;
    }
    if (app.ctx.currentTime > state.startAt + state.end + 0.4) {
      state.stopped = true;
      clearInterval(state.timer);
      if (state.onFinish) state.onFinish();
    }
  };

  tick();
  state.timer = setInterval(tick, 60);
  return state;
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
  const events = mixEvents();
  if (!events.length) return;
  stopPlayback();
  app.song.playing = true;
  const btn = document.getElementById('btn-play');
  if (btn) btn.classList.add('on');
  // Play plays what Mix saves: every channel together.
  const run = () => {
    playEvents(events, () => {
      if (app.song.loop && app.song.playing) run();
      else stopPlayback();
    });
  };
  run();
}

export function stopPlayback() {
  app.song.playing = false;
  const btn = document.getElementById('btn-play');
  if (btn) btn.classList.remove('on');
  if (playback) {
    playback.stopped = true;
    if (playback.timer) clearInterval(playback.timer);
    playback = null;
  }
  if (app.engine && app.ctx) app.engine.allNotesOff(app.ctx.currentTime);
}

// Play the mix once and resolve when it ends. Used by the Ogg recorder, which
// captures the live output in real time.
export function playOnce() {
  return new Promise((resolve) => {
    if (!app.engine || !app.ctx) {
      resolve();
      return;
    }
    stopPlayback();
    const events = mixEvents();
    if (!events.length) {
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
      resolve();
    };
    playEvents(events, finish);
    setTimeout(finish, (songLength(events) + 4) * 1000);
  });
}
