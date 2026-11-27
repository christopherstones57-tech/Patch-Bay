// App bootstrap: builds the default rack, the audio engine, the module picker
// and the toolbar.

// Every module is imported with the same version stamp as index.html's script
// tag. A browser caches an ES module by its URL, so a stamp on index.html alone
// leaves a device fetching a new main.js and reusing an old keyboard.js or
// app.js from before — a page that fails to instantiate, which shows as an
// empty keybed and a screen where nothing answers. Change the number in
// index.html and in every import, in every file, together.
import {
  app,
  uid,
  mixEvents,
  songLength,
  hasLyrics,
  lyricEnd,
  setAudioSession,
  getAudioSessionType
} from './app.js?v=13';
import { DEFS, defaultParams, MODULE_INFO, MODULE_GROUPS } from './modules.js?v=13';
import { Engine } from './engine.js?v=13';
import { voiceBus, applyLiveChannel } from './voices.js?v=13';
import { liveOutput } from './output-route.js?v=13';
import { autoPatch, autoConnectModule } from './autopatch.js?v=13';
import {
  initPatchbay,
  rebuildCards,
  addCard,
  scheduleCables,
  startScopeLoop,
  revealModule,
  renderPatchMap,
  initPatchMap,
  fitPatchMap,
  zoomPatchMap
} from './patchbay.js?v=13';
import { initKeyboard, updateSongInfo, stopPlayback, stopRecordingNow, playTune } from './keyboard.js?v=13';
import {
  initVisualiser,
  openVisualiser,
  closeVisualiser,
  setVisualiserCaption
} from './visualiser.js?v=13';
import { DEMO_TUNES } from './demo.js?v=13';
import { exportWav, exportFlac, exportOgg, oggMime } from './export.js?v=13';
import { initSampleRecorder } from './sample-recorder.js?v=13';
import { saveSongFile, importSongFile } from './song-file.js?v=13';
import { loadRack, saveRack, startAutoSave } from './persist.js?v=13';
import { listPresets, savePreset, removePreset, presetRack, adoptRack, BUILT_IN_PRESETS } from './presets.js?v=13';

let toastTimer = null;

// Sit the message just above the transport, so it never covers the transport's
// buttons or the keys — Rec sample's Stop in particular.
function placeToast(el) {
  const transport = document.getElementById('transport');
  const gap = 8;
  const top = transport ? transport.getBoundingClientRect().top : window.innerHeight;
  el.style.bottom = Math.max(gap + 24, window.innerHeight - top + gap) + 'px';
}

function hideToast() {
  const el = document.getElementById('toast');
  if (el) el.classList.remove('show');
  clearTimeout(toastTimer);
  toastTimer = null;
}

function toast(msg, ms) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  placeToast(el);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 3400);
}

app.toast = toast;

function makeModule(type, x, y) {
  const mod = {
    id: uid('m'),
    type,
    x: x == null ? 30 : x,
    y: y == null ? 30 : y,
    params: defaultParams(type),
    data: {}
  };
  app.state.modules.push(mod);
  if (app.engine) app.engine.addModule(mod);
  return mod;
}

// The default rack ------------------------------------------------------------
//
// The patch the app opens with on every visit, and what "Default rack" puts back
// afterwards: a source through the filter, amplifier and delay into the Output,
// with the envelope, the LFO and the sequencer beside them. Only the module types
// and where they sit are written down; autoPatch() does the wiring, so the default
// patch follows the same routing rules as any rack the player patches themselves.
// Every module is made with defaultParams(), so its settings are the ones it was
// built with, never a leftover from the last visit.
const DEFAULT_RACK = {
  bpm: 120,
  master: 1,
  modules: [
    ['sampler', 20, 30],
    ['vco', 250, 30],
    ['vcf', 480, 30],
    ['vca', 20, 350],
    ['adsr', 250, 350],
    ['lfo', 480, 350],
    ['output', 20, 670],
    ['delay', 250, 670],
    ['seq', 480, 670]
  ]
};

// Load the default rack into the app, replacing whatever was there. The modules
// go into the engine as they are made, so this works both on a page nobody has
// touched yet and on a rack the player cleared or replaced.
function loadDefaultRack() {
  app.state.modules = [];
  app.state.cables = [];
  app.state.bpm = DEFAULT_RACK.bpm;
  app.state.master = DEFAULT_RACK.master;

  for (const [type, x, y] of DEFAULT_RACK.modules) {
    if (DEFS[type]) makeModule(type, x, y);
  }
  autoPatch();
  return app.state;
}

// Bring the rack up on load. Every visit starts clean: loadRack() puts the song
// back to its first-visit state — five empty channels, their faders at full, no
// loop, Rec on channel 1, the middle octave — and the default patch is built
// with every module at its original settings. Nothing is read back from the last
// visit; what is kept on the device on purpose, the player's own presets, stays.
function initRack() {
  loadRack();
  loadDefaultRack();
  // The Output is the only module that reaches the speakers: a rack that turned
  // up without one gets a fresh one now, so the cards drawn below always show a
  // patch that can be heard.
  ensureOutput();
  saveRack();
}

function nextSpot() {
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col < 5; col++) {
      const x = 30 + col * 245;
      const y = 40 + row * 330;
      const taken = app.state.modules.some(
        (m) => Math.abs(m.x - x) < 200 && Math.abs(m.y - y) < 250
      );
      if (!taken) return { x, y };
    }
  }
  return { x: 30, y: 40 };
}

// A silent loop, to hold the phone's media session ---------------------------
//
// On iOS the browser decides which audio session a page's sound plays in partly
// from the media it has seen. A page that only ever uses Web Audio can be given
// the ambient session: mixed down under other audio, following the silent
// switch, and on a phone sometimes routed to the earpiece. That reads as the
// synth being almost silent however far the phone's own volume is turned up.
// Starting a silent audio element in the player's first tap puts the page into
// media playback instead — the session a music app would use — and the synth
// then comes out of the loudspeaker at the phone's media volume. The file is
// silence itself, so nothing is heard from it; it only holds the session open.
const SILENT_RATE = 22050;

let silentClipUrl = null;
let silentAudioPlaying = false;
let silentAudioWired = false;

// A one-second WAV of nothing at all, as a Blob URL.
function silentClip() {
  if (silentClipUrl) return silentClipUrl;
  const frames = SILENT_RATE;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true); // the fmt chunk's size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SILENT_RATE, true);
  view.setUint32(28, SILENT_RATE * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  tag(36, 'data');
  view.setUint32(40, frames * 2, true);
  // Every sample stays 0, so the file is silence from beginning to end.
  silentClipUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  return silentClipUrl;
}

// Start that loop, in the tap that starts the synth. It makes no sound, but
// playing it is what moves the page onto the media playback session, so it is
// worth trying on every gesture until the browser lets it through.
function holdAudioSession() {
  const el = document.getElementById('audio-session');
  if (!el) return;
  if (!silentAudioWired) {
    silentAudioWired = true;
    // A browser that stops it — the page sent to the background, say — lets the
    // next tap start it again rather than leaving the synth on the quiet session.
    el.addEventListener('pause', () => {
      silentAudioPlaying = false;
    });
    // Coming back from the background can leave the element stopped and the page
    // on the quiet session again, so it is started once more when the page shows.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!app.ctx || app.ctx.state !== 'running') return;
      silentAudioPlaying = false;
      holdAudioSession();
    });
  }
  if (silentAudioPlaying) return;
  try {
    if (!el.src) el.src = silentClip();
    // Not muted and not turned down: a muted element does not earn the playback
    // session, and silence is already in the file itself.
    el.muted = false;
    el.volume = 1;
    const started = el.play();
    if (started && started.then) {
      silentAudioPlaying = true;
      started.then(
        () => setAudioSession('playback'),
        () => {
          silentAudioPlaying = false;
        }
      );
    } else {
      silentAudioPlaying = true;
    }
  } catch (e) {
    silentAudioPlaying = false;
  }
}

// The AudioContext is built inside the player's first tap or key press, never
// when the page loads. Chrome keeps a context created before a gesture
// suspended, and a suspended context is silent: the keys play nothing and the
// demo tune runs with no sound. Made in the gesture, the browser starts it at
// once, so the first sound the player asks for is the first sound they hear.
function initAudio() {
  if (app.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    toast('This browser has no Web Audio support');
    return;
  }
  try {
    // Ask for the full-volume playback session before the first sound. On iOS a
    // page that never asks can be given the quiet ambient one, where the synth
    // is mixed down under other audio and follows the silent switch.
    setAudioSession('playback');
    holdAudioSession();
    app.ctx = new AC({ latencyHint: 'interactive' });
    // The title card's tune plays through this context too, rather than through
    // one of its own: a phone will not start a context made as the page loaded,
    // and a card with a second one was silent while the rack played. js/splash.js
    // finds it here — this listener runs in the capture phase of the same press
    // that opens the card, so it is built and running by the time the card
    // asks.
    window.patchBayAudio = app.ctx;
    // A saved rack that lost its Output would build a silent engine: give it
    // one before the graph is made, so the keys and the demo tune are heard.
    if (app.state.modules.length) ensureOutput();
    // The live graph leaves through the page's own output route: straight into
    // the context's speakers node, on the phone's loud playback session.
    app.output = liveOutput(app.ctx);
    app.engine = new Engine(app.ctx, app.state, { out: app.output });
    // The live rack plays under the knob of the channel Rec is set to.
    applyLiveChannel(app.song.channel);
  } catch (e) {
    console.error(e);
    // Leave nothing half-built behind: the next gesture gets another try.
    try {
      if (app.ctx) app.ctx.close();
    } catch (err) {
      /* ignore */
    }
    app.ctx = null;
    app.engine = null;
    window.patchBayAudio = null;
    toast('Could not start the audio engine');
    return;
  }
  // A context can be suspended again later — a tab sent to the background, say
  // — so the button follows the context itself rather than the one resume()
  // call that started it.
  if (app.ctx.addEventListener) {
    app.ctx.addEventListener('statechange', () => {
      if (app.ctx && app.ctx.state === 'running') markAudioOn();
    });
  }
}

function markAudioOn() {
  if (!app.engine) return;
  // iOS can put the page back in its default session after an interruption or a
  // trip to the background: claim the one the synth is using again. The stored
  // type is asked for, so a take recording the microphone keeps its own.
  setAudioSession(getAudioSessionType());
  const btn = document.getElementById('btn-start');
  if (btn) {
    btn.classList.add('on');
    btn.textContent = 'Audio on';
  }
  app.engine.startSchedulers();
}

// The browser refused to start the sound. Say what to do about it, rather than
// leaving a silent page with a button that looks like it did something.
function audioBlocked() {
  toast(
    'The browser will not let the page play sound — allow audio for this site, then tap Start audio'
  );
}

// The master meter ------------------------------------------------------------
//
// A small bar beside the Vol slider showing what the page is actually sending
// out. It reads after the volume knob, not before it, so it is the level the
// speakers are handed: a bar that stays dark while the keys are played means the
// patch or the knob is quiet, and a bar that sits at the top while a phone is
// still quiet means the page has done its part and what is left is the phone's
// own routing.
function startMasterMeter() {
  const meter = document.getElementById('master-meter');
  const bar = meter ? meter.querySelector('i') : null;
  if (!bar) return;

  let engine = null;
  let analyser = null;
  let sink = null;
  let bus = null;
  let buffer = null;

  // The tap belongs to the engine it was made for: when the rack is swapped the
  // old engine is disposed, so its analyser and its silent sink go with it
  // rather than piling up on the destination.
  const dropTap = () => {
    try {
      if (analyser) analyser.disconnect();
      if (sink) sink.disconnect();
    } catch (e) {
      /* already gone */
    }
    try {
      if (bus) bus.disconnect(analyser);
    } catch (e) {
      /* already gone */
    }
    analyser = null;
    sink = null;
    bus = null;
  };

  const tick = () => {
    requestAnimationFrame(tick);
    if (document.hidden) return;
    if (!app.engine || !app.ctx) {
      bar.style.height = '0%';
      engine = null;
      dropTap();
      return;
    }
    if (engine !== app.engine) {
      engine = app.engine;
      dropTap();
      try {
        analyser = app.ctx.createAnalyser();
        analyser.fftSize = 1024;
        buffer = new Float32Array(analyser.fftSize);
        // An analyser with no path to the speakers may never run, so it hangs
        // off a silent gain the way the visualiser's does.
        sink = app.ctx.createGain();
        sink.gain.value = 0;
        // After the rail, the last thing in the chain, so the bar reads exactly
        // what is leaving the page.
        (engine.rail || engine.volume).connect(analyser);
        // The recorded channels play through their own engines, summed on the
        // voice bus: the bar reads them too, or it would sit dark through a
        // playback that is plainly being heard.
        bus = voiceBus();
        if (bus) bus.connect(analyser);
        analyser.connect(sink);
        sink.connect(app.ctx.destination);
      } catch (e) {
        analyser = null;
        sink = null;
      }
    }
    if (!analyser) return;
    analyser.getFloatTimeDomainData(buffer);
    let peak = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = buffer[i] < 0 ? -buffer[i] : buffer[i];
      if (v > peak) peak = v;
    }
    bar.style.height = Math.min(100, Math.round(peak * 100)) + '%';
  };

  requestAnimationFrame(tick);
}

function unlockAudio(e) {
  // The first tap also claims the phone's media session: a page that only ever
  // plays Web Audio can be left on the quiet ambient one, where the synth is
  // barely audible however far the phone's own volume is turned up.
  holdAudioSession();

  if (!app.ctx) initAudio();
  if (!app.ctx) return;

  if (app.ctx.state === 'running') {
    markAudioOn();
    return;
  }
  if (!app.ctx.resume) return;

  // Ask on every event of the press, rather than once for all of them. Browsers
  // do not agree on which event is the gesture that may start a sound: Chrome
  // starts a context asked for during the pointerdown, while Safari counts the
  // one that ends the press — its pointerup, touchend or click — and leaves a
  // resume asked for before that waiting. A page that asked only once, on the
  // first of those, stayed silent in Safari: that resume was never answered,
  // and the click which followed was skipped as a second ask for the same tap.
  // Asking again costs nothing, since a context on its way up answers at once.
  let resuming;
  try {
    resuming = app.ctx.resume();
  } catch (err) {
    resuming = Promise.reject(err);
  }
  // Only an event that ends a press, or a key, can say the page will not play:
  // a refusal of the first event of a press is a browser asking for the rest of
  // it, and a warning about it would be wrong.
  const asked =
    !e ||
    e.type === 'pointerup' ||
    e.type === 'touchend' ||
    e.type === 'click' ||
    e.type === 'keydown';
  Promise.resolve(resuming).then(
    () => {
      if (app.ctx && app.ctx.state === 'running') markAudioOn();
    },
    () => {
      if (asked) audioBlocked();
    }
  );
}

// The module at the end of the rack's audio chain: one with an audio Out that no
// cable leads away from. That is what a missing Output has to be fed from.
function chainEnd() {
  const fed = new Set(
    app.state.cables.filter((c) => c.from.port === 'out').map((c) => c.from.id)
  );
  const modules = app.state.modules;
  for (let i = modules.length - 1; i >= 0; i--) {
    const mod = modules[i];
    const def = DEFS[mod.type];
    if (!def || !def.outputs.some((p) => p.id === 'out')) continue;
    if (fed.has(mod.id)) continue;
    return mod;
  }
  return null;
}

// A rack has to reach an Output: it is the only module that gets to the
// speakers, so a rack without one is silent however it is patched — and worse,
// silently so, which reads exactly like the synth being broken. A rack saved
// without its Output gets a fresh one, wired to the end of the chain, rather
// than opening with nothing to play.
function ensureOutput() {
  if (app.state.modules.some((m) => m.type === 'output')) return;
  const spot = nextSpot();
  const from = chainEnd();
  const mod = makeModule('output', spot.x, spot.y);
  if (from) {
    addCable(from.id, 'out', mod.id, 'in');
  } else if (app.state.modules.length > 1) {
    // Nothing is left dangling — there is no end of chain to feed it from — so
    // the rack is patched from scratch rather than left with no way out.
    autoPatch();
  }
  addCard(mod);
  scheduleCables();
}

function addModuleOfType(type) {
  if (!DEFS[type]) return;
  // Keep a destination for the audio so a freshly cleared rack still sounds.
  const makesSound = DEFS[type].outputs.some((p) => p.id === 'out');
  if (makesSound) ensureOutput();
  const spot = nextSpot();
  const mod = makeModule(type, spot.x, spot.y);
  autoConnectModule(mod);
  addCard(mod);
  scheduleCables();
  revealModule(mod.id);
  toast(DEFS[type].name + ' added');
}

// One lowercase string per module for the search to look through: its type id,
// its name, its description, and the heading and words of the family it is
// listed under — so "osc", "gen", "fx", "seq" or a group's own name finds all
// of it.
function moduleSearchText(type) {
  const def = DEFS[type];
  let text = type + ' ' + def.name + ' ' + (MODULE_INFO[type] || '');
  for (const group of MODULE_GROUPS) {
    if (group.types.includes(type)) text += ' ' + group.label + ' ' + group.words;
  }
  return text.toLowerCase();
}

// { node, head, text }: a picker option, the heading above it, and what it
// matches.
let moduleSearch = [];

function showModuleMatches(query) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  let shown = 0;

  // A heading starts hidden and only comes back with a module under it, so a
  // search never leaves an empty "Sound effects" sitting in the list.
  for (const entry of moduleSearch) {
    if (entry.head) entry.head.hidden = true;
  }
  for (const entry of moduleSearch) {
    const hit = terms.every((t) => entry.text.includes(t));
    entry.node.hidden = !hit;
    if (!hit) continue;
    shown++;
    if (entry.head) entry.head.hidden = false;
  }

  const list = document.getElementById('module-list');
  if (list) list.scrollTop = 0;

  const hint = document.getElementById('module-hint');
  if (hint) {
    if (!terms.length) {
      hint.textContent = 'Tap a module to add it to the rack. It patches itself in automatically.';
    } else if (!shown) {
      hint.textContent = 'No module matches “' + query.trim() + '” — try osc, gen, fx or seq.';
    } else {
      hint.textContent = shown + ' of ' + moduleSearch.length + ' modules match “' + query.trim() + '”';
    }
  }

  const clear = document.getElementById('module-search-clear');
  if (clear) clear.hidden = query.trim().length === 0;
}

function setModuleSearch(value) {
  const input = document.getElementById('module-search');
  if (input && input.value !== value) input.value = value;
  showModuleMatches(value);
}

function clearModuleSearch(focus) {
  setModuleSearch('');
  const input = document.getElementById('module-search');
  if (input && focus) input.focus();
}

function buildModulePicker() {
  const list = document.getElementById('module-list');
  if (!list) return;
  list.innerHTML = '';
  moduleSearch = [];

  // One heading per group, in the order MODULE_GROUPS lists them, with the
  // group's colour on the heading and on every module card under it.
  const addGroup = (label, types, hue) => {
    const head = document.createElement('div');
    head.className = 'module-group-head';
    if (hue != null) head.style.setProperty('--hue', hue);
    head.textContent = label;
    list.appendChild(head);

    for (const type of types) {
      if (!DEFS[type] || placed.has(type)) continue;
      placed.add(type);
      const def = DEFS[type];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'module-option';
      b.style.setProperty('--hue', def.hue);
      b.innerHTML =
        `<span class="module-option-name">${def.name}</span>` +
        `<span class="module-option-desc">${MODULE_INFO[type] || ''}</span>`;
      b.addEventListener('click', () => {
        addModuleOfType(type);
        closeModulePicker();
      });
      list.appendChild(b);
      moduleSearch.push({ node: b, head, text: moduleSearchText(type) });
    }
  };

  const placed = new Set();
  for (const group of MODULE_GROUPS) addGroup(group.label, group.types, group.hue);

  // A module a group has not caught up with still gets a home in the list.
  const rest = Object.keys(DEFS).filter((t) => !placed.has(t));
  if (rest.length) addGroup('More modules', rest, null);

  setModuleSearch('');
}

function openModulePicker() {
  const sheet = document.getElementById('module-sheet');
  if (!sheet) return;
  // Every visit starts with the full list, so an old search never hides a
  // module someone is looking for now.
  setModuleSearch('');
  const list = document.getElementById('module-list');
  if (list) list.scrollTop = 0;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
}

function closeModulePicker() {
  const sheet = document.getElementById('module-sheet');
  if (!sheet) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  const search = document.getElementById('module-search');
  if (search) search.blur();
}

function wireModulePicker() {
  const open = document.getElementById('btn-add-module');
  if (open) open.addEventListener('click', openModulePicker);
  const close = document.getElementById('sheet-close');
  if (close) close.addEventListener('click', closeModulePicker);
  const backdrop = document.querySelector('.sheet-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeModulePicker);

  const search = document.getElementById('module-search');
  if (search) search.addEventListener('input', () => showModuleMatches(search.value));
  const clear = document.getElementById('module-search-clear');
  if (clear) clear.addEventListener('click', () => clearModuleSearch(true));

  // Enter, the keyboard's Search key and the Search button all do the same:
  // apply the term and put the keyboard away, so the matches below can be seen.
  const form = document.getElementById('module-search-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const term = search ? search.value : '';
      showModuleMatches(term);
      if (search) search.blur();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Only an open picker answers Escape here; the rest of the UI has its own
    // handler in init(). Without this, a leftover search term would be cleared
    // (and its hidden input focused) while some other overlay was open.
    const sheet = document.getElementById('module-sheet');
    if (!sheet || !sheet.classList.contains('open')) return;
    // Escape drops the search first, and closes the picker on the next press.
    if (search && search.value) {
      clearModuleSearch(true);
      return;
    }
    closeModulePicker();
  });
}

function dropEngine() {
  if (app.engine) app.engine.dispose();
  app.engine = null;
}

function startEngine() {
  // Building the context builds its engine, so there is nothing more to do.
  if (!app.ctx) {
    initAudio();
    return;
  }
  // A swap of rack — a preset, Clear rack, Default rack — has to end with an
  // engine, and a rack with modules but no Output has to end with an Output:
  // both are added here rather than leaving the rack silent.
  if (app.state.modules.length) ensureOutput();
  // A rack swap keeps the route it already has; a context that has been replaced
  // gets a fresh one.
  if (!app.output || app.output.context !== app.ctx) app.output = liveOutput(app.ctx);
  app.engine = new Engine(app.ctx, app.state, { out: app.output });
  // A fresh engine starts at unity: give it the knob of the channel in hand.
  applyLiveChannel(app.song.channel);
  if (app.ctx.state === 'running') app.engine.startSchedulers();
}

function resetAll() {
  stopRecordingNow();
  stopPlayback();
  dropEngine();
  loadDefaultRack();
  startEngine();
  rebuildCards();
  scheduleCables();
  syncTransportSettings();
  saveRack();
  toast('Default rack loaded');
}

function clearRack() {
  if (!app.state.modules.length) {
    toast('The rack is already empty — add modules with + Add module');
    return;
  }
  stopRecordingNow();
  stopPlayback();
  dropEngine();
  app.state.modules = [];
  app.state.cables = [];
  startEngine();
  rebuildCards();
  scheduleCables();
  toast('Rack cleared — add modules with + Add module');
}

// Presets -----------------------------------------------------------------

function syncTransportSettings() {
  const master = document.getElementById('master');
  if (master) master.value = String(app.state.master);
  const bpm = document.getElementById('bpm');
  if (bpm) bpm.value = String(app.state.bpm);
}

function presetWhen(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch (e) {
    return '';
  }
}

function renderPresetList() {
  const list = document.getElementById('preset-list');
  if (!list) return;
  list.innerHTML = '';

  const built = BUILT_IN_PRESETS;
  const mine = listPresets();

  const hint = document.getElementById('preset-hint');
  if (hint) {
    if (!mine.length) {
      hint.textContent =
        built.length +
        ' built-in ' +
        (built.length === 1 ? 'preset' : 'presets') +
        ' to start from. Tap one to put it in the rack, or name this patch above and save it.';
    } else {
      hint.textContent =
        built.length +
        ' built-in and ' +
        mine.length +
        ' of your own. Tap a preset to put it in the rack.';
    }
  }

  const addHead = (label, hue) => {
    const head = document.createElement('div');
    head.className = 'module-group-head';
    head.style.setProperty('--hue', hue);
    head.textContent = label;
    list.appendChild(head);
  };

  const addRow = (preset, deletable) => {
    const row = document.createElement('div');
    row.className = 'preset-row';

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'module-option preset-option';

    const name = document.createElement('span');
    name.className = 'module-option-name';
    name.textContent = preset.name;

    const modules = preset.modules.length;
    const cables = preset.cables.length;
    const when = deletable ? presetWhen(preset.savedAt) : '';
    const counts =
      modules +
      (modules === 1 ? ' module' : ' modules') +
      ' · ' +
      cables +
      (cables === 1 ? ' cable' : ' cables') +
      (when ? ' · ' + when : '');

    const desc = document.createElement('span');
    desc.className = 'module-option-desc';
    desc.textContent = (preset.description ? preset.description + ' · ' : '') + counts;

    load.append(name, desc);
    load.addEventListener('click', () => loadPresetIntoRack(preset));
    row.appendChild(load);

    if (deletable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'preset-del';
      del.setAttribute('aria-label', 'Delete preset ' + preset.name);
      del.textContent = '×';
      del.addEventListener('click', () => {
        if (!confirm('Delete the preset “' + preset.name + '”?')) return;
        removePreset(preset.id);
        renderPresetList();
        toast('Preset deleted');
      });
      row.appendChild(del);
    }

    list.appendChild(row);
  };

  if (built.length) {
    addHead('Built-in', 200);
    for (const preset of built) addRow(preset, false);
  }
  if (mine.length) {
    addHead('Your presets', 60);
    for (const preset of mine) addRow(preset, true);
  }
}

function openPresetSheet() {
  const sheet = document.getElementById('preset-sheet');
  if (!sheet) return;
  const input = document.getElementById('preset-name');
  if (input) input.value = '';
  renderPresetList();
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
}

function closePresetSheet() {
  const sheet = document.getElementById('preset-sheet');
  if (!sheet || !sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  const input = document.getElementById('preset-name');
  if (input) input.blur();
}

function saveCurrentPreset() {
  const input = document.getElementById('preset-name');
  const name = input ? input.value.trim() : '';

  if (!name) {
    toast('Give the preset a name first');
    if (input) input.focus();
    return;
  }
  if (!app.state.modules.length) {
    toast('The rack is empty — add modules before saving a preset');
    return;
  }

  const preset = savePreset(name);
  if (!preset) {
    toast('Could not save the preset — the browser is out of storage');
    return;
  }

  if (input) input.value = '';
  renderPresetList();
  toast('Preset “' + preset.name + '” saved');
}

function loadPresetIntoRack(preset) {
  const rack = presetRack(preset);
  if (!rack.modules.length) {
    toast('That preset has nothing in it');
    return;
  }

  loadRackIntoApp(rack);
  closePresetSheet();
  toast('Preset “' + preset.name + '” loaded');
}

// Put a cleaned rack (a preset, a demo tune's own patch) into the app: stop what
// is running, replace the rack and build the engine and cards for it, so what
// plays next is that rack and not the one before.
function loadRackIntoApp(rack) {
  if (!rack || !rack.modules.length) return;
  stopRecordingNow();
  stopPlayback();
  dropEngine();
  adoptRack(rack);
  startEngine();
  rebuildCards();
  scheduleCables();
  syncTransportSettings();
}

// Visualiser and the demo tunes -------------------------------------------

// Which demo the details are about: the one last chosen, and the first until
// another is. The visualiser's own button plays this one.
let currentDemo = DEMO_TUNES[0];

function openVisualiserView() {
  unlockAudio();
  setVisualiserCaption('Live audio');
  openVisualiser();
}

function renderDemoList() {
  const list = document.getElementById('demo-list');
  if (!list) return;
  list.innerHTML = '';

  for (const tune of DEMO_TUNES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'module-option';
    b.style.setProperty('--hue', tune.hue);
    b.classList.toggle('on', tune === currentDemo);

    const name = document.createElement('span');
    name.className = 'module-option-name';
    name.textContent = tune.name;

    const desc = document.createElement('span');
    desc.className = 'module-option-desc';
    const beats = Math.round(tune.rack.bpm);
    desc.textContent = tune.description + ' · ' + beats + ' BPM';

    b.append(name, desc);
    b.addEventListener('click', () => playDemoTune(tune));
    list.appendChild(b);
  }

  const hint = document.getElementById('demo-hint');
  if (hint) {
    hint.textContent =
      DEMO_TUNES.length +
      ' pieces of their own, each on a different rack. Tap one to load its rack and play it — the rack on screen is replaced.';
  }
}

function openDemoSheet() {
  const sheet = document.getElementById('demo-sheet');
  if (!sheet) return;
  renderDemoList();
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
}

function closeDemoSheet() {
  const sheet = document.getElementById('demo-sheet');
  if (!sheet || !sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
}

// Play a demo tune. Each one comes with the rack it was written for, so the rack
// on screen is replaced by it first — the tune then plays through exactly the
// sound it was made with.
function playDemoTune(tune) {
  const chosen = tune || currentDemo || DEMO_TUNES[0];
  currentDemo = chosen;
  closeDemoSheet();

  unlockAudio();
  const rack = presetRack(chosen.rack);
  if (!rack.modules.length) {
    toast('That demo has no rack to play');
    return;
  }
  loadRackIntoApp(rack);

  const started = playTune(chosen.notes, {
    onFinish() {
      setVisualiserCaption('Live audio');
      toast(chosen.name + ' finished');
    }
  });
  if (!started) {
    toast('Start the audio first, then play a demo');
    return;
  }
  setVisualiserCaption(chosen.name + ' — Patch Bay');
  openVisualiser();
  toast('Playing ' + chosen.name);
}

// Patch view -------------------------------------------------------------

// The whole patch, drawn to fit the screen: every module and every cable at
// once, so a rack too big to see in the scrolling view can be read at a glance.
// Tapping a module in the map jumps back to its card in the rack.
function openPatchView() {
  const view = document.getElementById('patch-view');
  if (!view) return;

  hideToast();
  const counts = renderPatchMap(document.getElementById('patch-map'));

  const info = document.getElementById('patch-view-info');
  if (info) {
    info.textContent = counts.modules
      ? counts.modules +
        (counts.modules === 1 ? ' module · ' : ' modules · ') +
        counts.cables +
        (counts.cables === 1 ? ' cable' : ' cables')
      : '';
  }

  const empty = document.getElementById('patch-view-empty');
  if (empty) empty.hidden = counts.modules > 0;

  view.classList.add('open');
  view.setAttribute('aria-hidden', 'false');
}

function closePatchView() {
  const view = document.getElementById('patch-view');
  if (!view || !view.classList.contains('open')) return;
  view.classList.remove('open');
  view.setAttribute('aria-hidden', 'true');
}

// The tune's name ---------------------------------------------------------
//
// A song has one name, and every file it is exported as is written under it —
// <name>.wav, <name>.flac, <name>.ogg and <name>.json. It is shown at the top of
// the app so the tune can be named without opening the mix, and the Mix sheet's
// name box edits the same name, so the two never disagree. A song file carries
// the name with it.

const UNNAMED_TUNE = 'Untitled tune';
const TUNE_NAME_MAX = 80;

// The name as it is written down: on one line, without the spaces either end.
function tuneName() {
  return String((app.song && app.song.name) || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// What the top of the app says: the tune's name, or that it has none yet.
function renderTuneName() {
  const btn = document.getElementById('btn-tune-name');
  if (!btn) return;
  const name = tuneName();
  btn.textContent = name || UNNAMED_TUNE;
  btn.classList.toggle('unnamed', !name);
  btn.title = name
    ? 'Tap to rename this tune — its files are saved as ' + name
    : 'Tap to name this tune — its files are saved under it';
}

const tuneNameParts = () => ({
  btn: document.getElementById('btn-tune-name'),
  input: document.getElementById('tune-name-input'),
  save: document.getElementById('btn-tune-save'),
  cancel: document.getElementById('btn-tune-cancel')
});

// A tap on Cancel blurs the box before the button's own click lands, and that
// blur must not save what was typed.
let tuneRenameCancelled = false;

// A tap on the name turns it into a box, holding the name the tune has now.
function startTuneRename() {
  const { btn, input, save, cancel } = tuneNameParts();
  if (!btn || !input || !input.hidden) return;
  tuneRenameCancelled = false;
  input.value = tuneName();
  btn.hidden = true;
  input.hidden = false;
  if (save) save.hidden = false;
  if (cancel) cancel.hidden = false;
  input.focus();
  input.select();
}

// Put the box away again. `keep` writes what was typed in — Enter, Save, or a
// tap somewhere else — and without it the name is left as it was.
function endTuneRename(keep) {
  const { btn, input, save, cancel } = tuneNameParts();
  if (!input || input.hidden) return;
  const typed = keep ? input.value : null;
  input.hidden = true;
  if (save) save.hidden = true;
  if (cancel) cancel.hidden = true;
  if (btn) btn.hidden = false;
  if (typed !== null) {
    const name = typed.slice(0, TUNE_NAME_MAX).replace(/\s+/g, ' ').trim();
    if (name !== app.song.name) {
      app.song.name = name;
      const mix = document.getElementById('mix-name');
      if (mix) mix.value = name;
      toast(name ? 'Tune named "' + name + '"' : 'Name cleared — the files keep their defaults');
    }
  }
  renderTuneName();
}

// Mix down ---------------------------------------------------------------

const MIX_LABELS = { wav: 'WAV', flac: 'FLAC', ogg: 'OGG' };

function mixSummary() {
  const events = mixEvents();
  const notes = events.length;
  const take = hasLyrics() ? app.song.lyrics : null;
  if (!notes && !take) {
    return 'Nothing recorded yet — tap Rec, pick a channel with 1–5, then play the keys or sing the lyrics.';
  }
  const perChannel = app.song.channels
    .map((list, i) => 'ch ' + (i + 1) + ': ' + list.length)
    .join(' · ');
  const length = Math.max(songLength(events), lyricEnd()).toFixed(1);
  const lyrics = take ? ' · lyrics ' + take.buffer.duration.toFixed(1) + 's' : '';
  return (
    'Mixing ' +
    notes +
    (notes === 1 ? ' note' : ' notes') +
    ' over ' +
    length +
    's' +
    lyrics +
    ' — ' +
    perChannel
  );
}

function openMixSheet() {
  const sheet = document.getElementById('mix-sheet');
  if (!sheet) return;
  const summary = document.getElementById('mix-summary');
  if (summary) summary.textContent = mixSummary();
  const name = document.getElementById('mix-name');
  if (name) name.value = app.song.name || '';
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
}

function closeMixSheet() {
  const sheet = document.getElementById('mix-sheet');
  if (!sheet) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
}

function exportMixTo(format) {
  if (format === 'flac') return exportFlac();
  if (format === 'ogg') return exportOgg();
  return exportWav();
}

async function runExport(format, btnId) {
  const label = MIX_LABELS[format] || 'Mix';
  const btn = btnId ? document.getElementById(btnId) : null;
  // WAV and FLAC render the mix offline, so they work before the sound has been
  // started — a take restored from the last visit can be mixed straight away.
  // OGG is captured from the live output, so only that one needs the audio on.
  if (format === 'ogg' && !app.ctx) {
    toast('Start the audio first');
    return;
  }
  if (format === 'ogg' && !oggMime()) {
    toast('Ogg recording is not supported here — use WAV or FLAC');
    return;
  }
  if (btn) btn.disabled = true;
  toast(format === 'ogg' ? 'Recording OGG…' : 'Rendering ' + label + '…');
  try {
    const name = await exportMixTo(format);
    toast(label + (name ? ' saved as ' + name : ' saved'));
  } catch (e) {
    console.error(e);
    toast(e.message || label + ' export failed');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function doMix(format) {
  if (!mixEvents().length && !hasLyrics()) {
    toast('Nothing recorded yet — the mix needs at least one take');
    return;
  }
  closeMixSheet();
  await runExport(format, 'mix-' + format);
}

// Song files --------------------------------------------------------------
//
// A mix is what a song sounds like; a song file is what it is. The Import button
// reads one back into the app — every channel, the rack each was recorded with
// and the lyric take — and the Mix sheet's Song file option writes one out.

async function runImport(file) {
  const open = document.getElementById('btn-import');
  if (open) open.disabled = true;
  toast('Reading ' + (file.name || 'the song') + '…');
  try {
    const info = await importSongFile(file);
    syncTransportSettings();
    // The song brings its own name with it, so the top of the app says it.
    renderTuneName();
    updateSongInfo();
    const parts = [];
    if (info.notes) parts.push(info.notes + (info.notes === 1 ? ' note' : ' notes'));
    if (info.lyrics) parts.push('the lyrics');
    let msg = 'Song imported — ' + (parts.length ? parts.join(' and ') : 'no takes in it');
    if (info.racks) {
      msg +=
        ' · ' + info.racks + (info.racks === 1 ? ' channel keeps its rack' : ' channels keep their racks');
    }
    if (info.lyricsLost) msg += ' · the lyrics could not be read';
    toast(msg, 9000);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Could not import that song', 8000);
  } finally {
    if (open) open.disabled = false;
  }
}

async function runSongSave() {
  const btn = document.getElementById('mix-song');
  if (btn) btn.disabled = true;
  toast('Writing the song file…');
  try {
    const name = await saveSongFile();
    toast('Song file saved as ' + name + ' — Import brings it back');
  } catch (e) {
    console.error(e);
    toast(e.message || 'Could not save the song file');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function wireSongFile() {
  const input = document.getElementById('song-file-input');
  const open = document.getElementById('btn-import');
  if (open && input) {
    open.addEventListener('click', () => {
      // The picker is emptied first, so choosing the same file again after a
      // failed import still counts as a change.
      input.value = '';
      input.click();
    });
  }
  if (input) {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (file) runImport(file);
    });
  }

  const save = document.getElementById('mix-song');
  if (save) {
    save.addEventListener('click', () => {
      closeMixSheet();
      runSongSave();
    });
  }
}

// The name at the top of the app is the tune's own: tapped to rename it, with
// Enter or Save keeping the name and Escape or Cancel leaving it as it was. A
// tap anywhere else keeps what has been typed, so the keyboard can simply be
// put away.
function wireTuneName() {
  const { btn, input, save, cancel } = tuneNameParts();
  if (btn) btn.addEventListener('click', startTuneRename);

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        endTuneRename(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        endTuneRename(false);
      }
    });
    input.addEventListener('blur', () => {
      if (tuneRenameCancelled) {
        tuneRenameCancelled = false;
        return;
      }
      endTuneRename(true);
    });
  }

  if (save) save.addEventListener('click', () => endTuneRename(true));
  if (cancel) {
    cancel.addEventListener('pointerdown', () => {
      tuneRenameCancelled = true;
    });
    cancel.addEventListener('click', () => endTuneRename(false));
  }

  renderTuneName();
}

function wireToolbar() {
  document.getElementById('btn-start').addEventListener('click', unlockAudio);

  wireTuneName();

  const master = document.getElementById('master');
  master.value = String(app.state.master);
  master.addEventListener('input', () => {
    const v = parseFloat(master.value);
    if (app.engine) app.engine.setMaster(v);
    else app.state.master = v;
  });

  const bpm = document.getElementById('bpm');
  bpm.value = String(app.state.bpm);
  bpm.addEventListener('change', () => {
    const v = Math.max(40, Math.min(240, Number(bpm.value) || 120));
    bpm.value = String(v);
    app.state.bpm = v;
    if (app.engine) app.engine.setBpm(v);
  });

  document.getElementById('btn-autopatch').addEventListener('click', () => {
    ensureOutput();
    autoPatch();
    scheduleCables();
    toast('Patched automatically');
  });

  document.getElementById('btn-reset').addEventListener('click', resetAll);
  document.getElementById('btn-clear-rack').addEventListener('click', clearRack);

  const patchView = document.getElementById('btn-patch-view');
  if (patchView) patchView.addEventListener('click', openPatchView);
  const patchClose = document.getElementById('patch-view-close');
  if (patchClose) patchClose.addEventListener('click', closePatchView);
  // The map pans and zooms under the fingers; a tap on a module jumps to it.
  initPatchMap((id) => {
    closePatchView();
    revealModule(id);
  });
  const patchZoomIn = document.getElementById('patch-view-zoom-in');
  if (patchZoomIn) patchZoomIn.addEventListener('click', () => zoomPatchMap(1.4));
  const patchZoomOut = document.getElementById('patch-view-zoom-out');
  if (patchZoomOut) patchZoomOut.addEventListener('click', () => zoomPatchMap(1 / 1.4));
  const patchFit = document.getElementById('patch-view-fit');
  if (patchFit) patchFit.addEventListener('click', fitPatchMap);

  const presetsBtn = document.getElementById('btn-presets');
  if (presetsBtn) presetsBtn.addEventListener('click', openPresetSheet);

  const visualiserBtn = document.getElementById('btn-visualiser');
  if (visualiserBtn) visualiserBtn.addEventListener('click', openVisualiserView);
  const demoBtn = document.getElementById('btn-demo');
  if (demoBtn) demoBtn.addEventListener('click', openDemoSheet);
  const visualiserDemo = document.getElementById('visualiser-demo');
  if (visualiserDemo) visualiserDemo.addEventListener('click', () => playDemoTune());
  const demoClose = document.getElementById('demo-sheet-close');
  if (demoClose) demoClose.addEventListener('click', closeDemoSheet);
  const demoBackdrop = document.querySelector('#demo-sheet .sheet-backdrop');
  if (demoBackdrop) demoBackdrop.addEventListener('click', closeDemoSheet);
  const presetClose = document.getElementById('preset-sheet-close');
  if (presetClose) presetClose.addEventListener('click', closePresetSheet);
  const presetBackdrop = document.querySelector('#preset-sheet .sheet-backdrop');
  if (presetBackdrop) presetBackdrop.addEventListener('click', closePresetSheet);
  const presetForm = document.getElementById('preset-save-form');
  if (presetForm) {
    presetForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveCurrentPreset();
    });
  }

  document.getElementById('btn-wav').addEventListener('click', () => runExport('wav', 'btn-wav'));
  document.getElementById('btn-ogg').addEventListener('click', () => runExport('ogg', 'btn-ogg'));

  document.getElementById('btn-mix').addEventListener('click', openMixSheet);
  document.getElementById('mix-sheet-close').addEventListener('click', closeMixSheet);
  const mixBackdrop = document.querySelector('#mix-sheet .sheet-backdrop');
  if (mixBackdrop) mixBackdrop.addEventListener('click', closeMixSheet);
  const mixName = document.getElementById('mix-name');
  if (mixName) {
    // The name is the song's: whatever is typed here is what the next export —
    // any of the four, from the sheet or the WAV and OGG buttons — is called,
    // and it travels on in the song file.
    mixName.addEventListener('input', () => {
      app.song.name = mixName.value;
      renderTuneName();
    });
  }
  for (const format of ['wav', 'flac', 'ogg']) {
    const btn = document.getElementById('mix-' + format);
    if (btn) btn.addEventListener('click', () => doMix(format));
  }

  wireSongFile();
}

// The instrument is laid out to exactly the height of the screen it is in, rather
// than to a guess at it: on a phone the address bar and the toolbar come and go,
// and a page laid out to the wrong height stretches the rack over the room the
// transport and the keys should have had, leaving them just past the bottom of
// the screen. The height itself lives in css/app.css, which reads --app-h and
// falls back to the viewport units until this has run.
function fitAppToScreen() {
  const h = Math.round(window.innerHeight || 0);
  if (h > 0) document.documentElement.style.setProperty('--app-h', h + 'px');
}

function init() {
  fitAppToScreen();
  window.addEventListener('resize', fitAppToScreen);
  window.addEventListener('orientationchange', fitAppToScreen);
  window.addEventListener('pageshow', fitAppToScreen);

  // Bring the rack up before anything draws it: always the default patch, with
  // every module at its original settings.
  initRack();

  // The first touch, key or click switches the audio on, and these listeners
  // come before everything else so that nothing later in this setup — a card
  // that will not draw, a microphone check, a canvas — can leave the synth
  // unable to make a sound. The capture phase means the gesture is seen before
  // the button or key that was tapped handles it, so the context is already
  // running when the tap's own handler asks it to play.
  //
  // The event that begins a press and the event that ends it are both listened
  // for: a browser that will not start a sound from the first of those starts it
  // from the second, so neither may be missing (see unlockAudio).
  for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'keydown', 'click']) {
    document.addEventListener(type, unlockAudio, { capture: true, passive: true });
  }

  initPatchbay();
  initKeyboard();
  startMasterMeter();
  initSampleRecorder({
    createSampler() {
      // The take needs somewhere to go: make sure the rack has an Output,
      // then add a Sampler and wire it in like + Add module does.
      ensureOutput();
      const spot = nextSpot();
      const mod = makeModule('sampler', spot.x, spot.y);
      autoConnectModule(mod);
      addCard(mod);
      scheduleCables();
      revealModule(mod.id);
      return mod;
    }
  });
  buildModulePicker();
  wireModulePicker();
  initVisualiser();
  wireToolbar();
  startScopeLoop();
  updateSongInfo();
  startAutoSave();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDemoSheet();
      closeMixSheet();
      closePresetSheet();
      closeVisualiser();
      closePatchView();
    }
  });

  // A message gets out of the way as soon as the transport is touched, and
  // follows the transport when the screen turns or the keyboard comes and goes.
  const transport = document.getElementById('transport');
  if (transport) transport.addEventListener('pointerdown', hideToast, { passive: true });
  window.addEventListener('resize', () => {
    const el = document.getElementById('toast');
    if (el && el.classList.contains('show')) placeToast(el);
  });

  // The hint would be hidden behind the splash card, so it waits for the card to
  // stand aside — js/splash.js says when it has.
  const hint = () => toast(
    'Tap a port, then a second port, to patch. Rec records into the channel picked with 1–5 — 5 holds your lyrics; Mix saves them all together.'
  );
  if (document.getElementById('splash')) {
    document.addEventListener('splash:done', () => setTimeout(hint, 500), { once: true });
  } else {
    setTimeout(hint, 900);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
