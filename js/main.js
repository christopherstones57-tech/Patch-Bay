// App bootstrap: builds the default rack, the audio engine, the module picker
// and the toolbar.

import { app, uid, mixEvents, songLength } from './app.js';
import { DEFS, defaultParams, MODULE_INFO } from './modules.js';
import { Engine } from './engine.js';
import { autoPatch, autoConnectModule } from './autopatch.js';
import {
  initPatchbay,
  rebuildCards,
  addCard,
  scheduleCables,
  startScopeLoop,
  revealModule,
  renderPatchMap
} from './patchbay.js';
import { initKeyboard, updateSongInfo, stopPlayback } from './keyboard.js';
import { exportWav, exportFlac, exportOgg, oggMime } from './export.js';
import { initSampleRecorder } from './sample-recorder.js';
import { loadRack, startAutoSave } from './persist.js';

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

function bootstrapPatch() {
  const layout = [
    ['sampler', 20, 30],
    ['vco', 250, 30],
    ['vcf', 480, 30],
    ['vca', 20, 350],
    ['adsr', 250, 350],
    ['lfo', 480, 350],
    ['output', 20, 670],
    ['delay', 250, 670],
    ['seq', 480, 670]
  ];
  for (const [type, x, y] of layout) makeModule(type, x, y);
  autoPatch();
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

function initAudio() {
  if (app.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    toast('This browser has no Web Audio support');
    return;
  }
  try {
    app.ctx = new AC({ latencyHint: 'interactive' });
    app.engine = new Engine(app.ctx, app.state, {});
  } catch (e) {
    console.error(e);
    toast('Could not start the audio engine');
  }
}

function markAudioOn() {
  const btn = document.getElementById('btn-start');
  if (btn) {
    btn.classList.add('on');
    btn.textContent = 'Audio on';
  }
  if (app.engine) app.engine.startSchedulers();
}

function unlockAudio() {
  if (!app.ctx) initAudio();
  if (!app.ctx) return;

  if (app.ctx.state !== 'running' && app.ctx.resume) {
    app.ctx
      .resume()
      .then(() => {
        if (app.ctx.state === 'running') markAudioOn();
      })
      .catch(() => {});
  } else {
    markAudioOn();
  }
}

function ensureOutput() {
  if (app.state.modules.some((m) => m.type === 'output')) return;
  const spot = nextSpot();
  const mod = makeModule('output', spot.x, spot.y);
  addCard(mod);
}

function addModuleOfType(type) {
  if (!DEFS[type]) return;
  // Keep a destination for the audio so a freshly cleared rack still sounds.
  const makesSound = DEFS[type].outputs.some((p) => p.id === 'out');
  if (makesSound && !app.state.modules.some((m) => m.type === 'output')) {
    const outSpot = nextSpot();
    const outMod = makeModule('output', outSpot.x, outSpot.y);
    addCard(outMod);
  }
  const spot = nextSpot();
  const mod = makeModule(type, spot.x, spot.y);
  autoConnectModule(mod);
  addCard(mod);
  scheduleCables();
  revealModule(mod.id);
  toast(DEFS[type].name + ' added');
}

// A typed word reaches a whole family of modules, not only the ones whose
// description happens to use it: osc for the oscillators, gen for the one-shot
// sound generators, fx for the processors, seq for the things that run in
// steps. Plain synonyms ride along with each family.
const SEARCH_GROUPS = [
  {
    words: 'osc oscillator synth synthesiser voice tone pitch lead drone',
    types: ['vco', 'harmonic', 'sync', 'metal', 'chip', 'supersaw', 'fmosc', 'pulse', 'wavetable', 'vox']
  },
  {
    words: 'source sound instrument sample noise string',
    types: ['vco', 'noise', 'sampler', 'pluck', 'drum']
  },
  {
    words: 'fx effect filter processor distortion shape',
    types: ['vcf', 'comb', 'vowel', 'phaser', 'eq', 'chorus', 'delay', 'reverb', 'drive', 'crusher', 'ringmod', 'folder', 'octaver', 'comp', 'trance']
  },
  {
    words: 'gen generator sfx one-shot percussion hit drum',
    types: ['drum', 'zap', 'riser', 'clang', 'boom', 'blip', 'ping', 'siren', 'whistle', 'glass', 'splash', 'bounce', 'sparkle', 'thunder', 'subdrop', 'clap', 'cowbell', 'boing', 'buzz', 'tweet', 'glitch']
  },
  {
    words: 'seq sequencer step pattern rhythm arpeggio trigger clock tempo',
    types: ['seq', 'turing', 'arp', 'clock', 'trance']
  },
  {
    words: 'cv control voltage modulation mod env envelope glide',
    types: ['lfo', 'adsr', 'random', 'slew', 'atten', 'transpose', 'cvmix', 'multiple', 'clock']
  },
  {
    words: 'utility util routing mix master level split scope visual',
    types: ['mixer', 'cvmix', 'multiple', 'atten', 'transpose', 'output', 'scope']
  }
];

// One lowercase string per module for the search to look through: its type id,
// its name, its description and the words of every family it belongs to.
function moduleSearchText(type) {
  const def = DEFS[type];
  let text = type + ' ' + def.name + ' ' + (MODULE_INFO[type] || '');
  for (const group of SEARCH_GROUPS) {
    if (group.types.includes(type)) text += ' ' + group.words;
  }
  return text.toLowerCase();
}

// { node, text }: a picker option and what it matches.
let moduleSearch = [];

function showModuleMatches(query) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  let shown = 0;
  for (const entry of moduleSearch) {
    const hit = terms.every((t) => entry.text.includes(t));
    entry.node.hidden = !hit;
    if (hit) shown++;
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
  for (const type of Object.keys(DEFS)) {
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
    moduleSearch.push({ node: b, text: moduleSearchText(type) });
  }
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

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
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
  if (!app.ctx) return;
  app.engine = new Engine(app.ctx, app.state, {});
  if (app.ctx.state === 'running') app.engine.startSchedulers();
}

function resetAll() {
  stopPlayback();
  dropEngine();
  app.state.modules = [];
  app.state.cables = [];
  bootstrapPatch();
  startEngine();
  rebuildCards();
  scheduleCables();
  toast('Default rack loaded');
}

function clearRack() {
  if (!app.state.modules.length) {
    toast('The rack is already empty — add modules with + Add module');
    return;
  }
  stopPlayback();
  dropEngine();
  app.state.modules = [];
  app.state.cables = [];
  startEngine();
  rebuildCards();
  scheduleCables();
  toast('Rack cleared — add modules with + Add module');
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

// Mix down ---------------------------------------------------------------

const MIX_LABELS = { wav: 'WAV', flac: 'FLAC', ogg: 'OGG' };

function mixSummary() {
  const events = mixEvents();
  if (!events.length) {
    return 'Nothing recorded yet — tap Rec, pick a channel with 1–4 and play the keys.';
  }
  const perChannel = app.song.channels
    .map((list, i) => 'ch ' + (i + 1) + ': ' + list.length)
    .join(' · ');
  return (
    'Mixing ' +
    events.length +
    ' notes over ' +
    songLength(events).toFixed(1) +
    's — ' +
    perChannel
  );
}

function openMixSheet() {
  const sheet = document.getElementById('mix-sheet');
  if (!sheet) return;
  const summary = document.getElementById('mix-summary');
  if (summary) summary.textContent = mixSummary();
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
  if (!app.ctx) {
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
    await exportMixTo(format);
    toast(label + ' saved');
  } catch (e) {
    console.error(e);
    toast(e.message || label + ' export failed');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function doMix(format) {
  if (!mixEvents().length) {
    toast('Nothing recorded yet — the mix needs at least one take');
    return;
  }
  closeMixSheet();
  await runExport(format, 'mix-' + format);
}

function wireToolbar() {
  document.getElementById('btn-start').addEventListener('click', unlockAudio);

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
  const patchMap = document.getElementById('patch-map');
  if (patchMap) {
    patchMap.addEventListener('click', (e) => {
      const box = e.target.closest ? e.target.closest('.map-module') : null;
      if (!box) return;
      const id = box.getAttribute('data-module');
      closePatchView();
      if (id) revealModule(id);
    });
  }

  document.getElementById('btn-wav').addEventListener('click', () => runExport('wav', 'btn-wav'));
  document.getElementById('btn-ogg').addEventListener('click', () => runExport('ogg', 'btn-ogg'));

  document.getElementById('btn-mix').addEventListener('click', openMixSheet);
  document.getElementById('mix-sheet-close').addEventListener('click', closeMixSheet);
  const mixBackdrop = document.querySelector('#mix-sheet .sheet-backdrop');
  if (mixBackdrop) mixBackdrop.addEventListener('click', closeMixSheet);
  for (const format of ['wav', 'flac', 'ogg']) {
    const btn = document.getElementById('mix-' + format);
    if (btn) btn.addEventListener('click', () => doMix(format));
  }
}

function init() {
  // A rack saved by the last visit comes back as it was; only a first visit
  // starts from the default patch.
  if (!loadRack()) bootstrapPatch();
  initAudio();
  initPatchbay();
  initKeyboard();
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
  wireToolbar();
  startScopeLoop();
  updateSongInfo();
  startAutoSave();

  document.addEventListener('pointerdown', unlockAudio, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMixSheet();
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
  if (app.ctx && app.ctx.state === 'running') unlockAudio();

  setTimeout(() => {
    toast('Tap a port, then a second port, to patch. Rec records into the channel picked with 1–4; Mix saves them all together.');
  }, 900);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
