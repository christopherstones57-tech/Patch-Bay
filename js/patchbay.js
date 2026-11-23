// The patch bay: module cards, ports, patch cables and drag interactions.

import { DEFS } from './modules.js?v=12';
import { app, getModule, removeCable, addCable } from './app.js?v=12';
import { autoConnectModule } from './autopatch.js?v=12';
import { decodeSampleFile } from './decode-audio.js?v=12';

const CARD_W = 215;
const BOARD_PAD = 90;

let rackEl = null;
let boardEl = null;
let svgEl = null;
let layerEl = null;
let tempEl = null;

let drag = null;
let pending = null;
let rafId = 0;

export function initPatchbay() {
  rackEl = document.getElementById('rack');
  boardEl = document.getElementById('board');
  svgEl = document.getElementById('cables');
  layerEl = document.getElementById('cable-layer');
  tempEl = document.getElementById('temp');

  rackEl.addEventListener('scroll', scheduleCables, { passive: true });
  window.addEventListener('resize', scheduleCables);

  boardEl.addEventListener('pointerdown', onPointerDown);
  boardEl.addEventListener('input', onParamInput);
  boardEl.addEventListener('change', onParamInput);
  boardEl.addEventListener('change', onFileChange);
  boardEl.addEventListener('click', onClick);
  svgEl.addEventListener('click', onCableClick);

  app.onCablesChanged = scheduleCables;

  rebuildCards();
  scheduleCables();
}

export function rebuildCards() {
  if (!boardEl) return;
  for (const el of Array.from(boardEl.querySelectorAll('.card'))) el.remove();
  for (const mod of app.state.modules) addCard(mod);
  updateBoardSize();
  updateRackHint();
  // A preset swap or a cleared rack starts a fresh view: keeping the old scroll
  // offset can leave the empty-rack hint or the first card out of sight.
  if (rackEl) {
    rackEl.scrollTop = 0;
    rackEl.scrollLeft = 0;
  }
  scheduleCables();
}

// Shown when the rack holds no modules, e.g. after "Clear rack".
function updateRackHint() {
  if (!boardEl) return;
  const existing = boardEl.querySelector('.rack-empty');
  if (app.state.modules.length > 0) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const el = document.createElement('div');
  el.className = 'rack-empty';
  el.innerHTML =
    '<h2>Empty rack</h2><p>Tap + Add module above to build the rack — modules patch themselves in. Drag between two ports to wire it yourself.</p>';
  boardEl.appendChild(el);
}

export function addCard(mod) {
  const def = DEFS[mod.type];
  if (!def || !boardEl) return null;

  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = mod.id;
  el.dataset.type = mod.type;
  el.style.left = Math.round(mod.x) + 'px';
  el.style.top = Math.round(mod.y) + 'px';
  el.style.setProperty('--hue', def.hue);

  const ins = def.inputs.map((p) => portHTML(mod, p, 'in')).join('');
  const outs = def.outputs.map((p) => portHTML(mod, p, 'out')).join('');
  const params = def.params.map((pd) => paramHTML(mod, pd)).join('');

  const sampleUI =
    mod.type === 'sampler'
      ? `<div class="sample-ui">
           <button class="load-sample" type="button">Load sample</button>
           <span class="sample-name">${escapeHtml(
             (mod.data && mod.data.name) || 'no sample'
           )}</span>
           <span class="sample-formats">WAV · FLAC · Ogg</span>
           <input class="sample-file" type="file" hidden>
         </div>`
      : '';

  const scopeUI =
    mod.type === 'scope' ? '<canvas class="scope" width="176" height="56"></canvas>' : '';

  el.innerHTML = `
    <div class="card-head">
      <span class="dot"></span>
      <span class="tag">${def.name}</span>
      <button class="del" type="button" aria-label="Remove module">&times;</button>
    </div>
    <div class="card-body">
      <div class="col ins">${ins}</div>
      <div class="params">${params}${sampleUI}${scopeUI}</div>
      <div class="col outs">${outs}</div>
    </div>
  `;

  boardEl.appendChild(el);
  updateBoardSize();
  updateRackHint();
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

// Refresh the sample name shown on a Sampler card after its data changes.
export function updateSampleName(id) {
  if (!boardEl) return;
  const mod = getModule(id);
  const card = boardEl.querySelector(`.card[data-id="${id}"]`);
  if (!mod || !card) return;
  const nameEl = card.querySelector('.sample-name');
  if (nameEl) nameEl.textContent = (mod.data && mod.data.name) || 'no sample';
}

// Put one control on a card back to the value its module's params now hold, for
// a change this page made itself rather than one the player dragged — the
// Sampler's root note and loop, say, when a fresh take is loaded.
export function updateParamControl(id, key) {
  if (!boardEl) return;
  const mod = getModule(id);
  const card = boardEl.querySelector(`.card[data-id="${id}"]`);
  if (!mod || !card) return;
  const def = DEFS[mod.type];
  const pd = def && def.params.find((p) => p.key === key);
  if (!pd) return;

  const value = mod.params[key];
  const el = card.querySelector(`.p[data-key="${key}"]`);
  if (el) {
    if (pd.type === 'toggle') el.checked = !!value;
    else if (pd.type === 'select') el.value = String(value);
    else if (pd.type === 'logrange') el.value = String(valueToSlider(value, pd));
    else el.value = String(value);
  }
  const label = card.querySelector(`.val[data-val="${key}"]`);
  if (label) label.textContent = formatValue(pd, value);
}

function portHTML(mod, p, role) {
  return `<div class="port ${role} kind-${p.kind}" data-id="${mod.id}" data-port="${p.id}" data-role="${role}"><span>${p.label}</span></div>`;
}

function valueToSlider(v, pd) {
  if (pd.type !== 'logrange') return v;
  const min = pd.min;
  const max = pd.max;
  const t = Math.log(Math.max(min, v) / min) / Math.log(max / min);
  return Math.round(Math.min(1, Math.max(0, t)) * 1000);
}

function sliderToValue(t, pd) {
  if (pd.type !== 'logrange') return t;
  return pd.min * Math.pow(pd.max / pd.min, t / 1000);
}

function formatValue(pd, v) {
  if (pd.type === 'select' || pd.type === 'toggle') return '';
  const unit = pd.unit || '';
  let s;
  if (pd.step && pd.step >= 1) {
    s = String(Math.round(v));
  } else if (unit === 'hz') {
    s = v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v < 100 ? v.toFixed(1) : String(Math.round(v));
  } else if (unit === 's') {
    s = v.toFixed(2);
  } else if (unit === 'ct' || unit === 'dB') {
    s = String(Math.round(v));
  } else {
    s = Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2);
  }
  return s + unit;
}

function paramHTML(mod, pd) {
  const val = mod.params[pd.key];

  if (pd.type === 'select') {
    const opts = pd.options
      .map(
        ([v, l]) =>
          `<option value="${v}"${String(val) === String(v) ? ' selected' : ''}>${l}</option>`
      )
      .join('');
    return `<div class="param"><label>${pd.label}</label><select class="p" data-key="${pd.key}" data-ptype="select">${opts}</select></div>`;
  }

  if (pd.type === 'toggle') {
    return `<div class="param toggle"><label>${pd.label}</label><input class="p" type="checkbox" data-key="${pd.key}" data-ptype="toggle"${val ? ' checked' : ''}></div>`;
  }

  const isLog = pd.type === 'logrange';
  const min = isLog ? 0 : pd.min;
  const max = isLog ? 1000 : pd.max;
  const step = isLog ? 1 : pd.step || 0.01;
  const sliderVal = isLog ? valueToSlider(val, pd) : val;

  return `<div class="param">
    <label>${pd.label} <span class="val" data-val="${pd.key}">${formatValue(pd, val)}</span></label>
    <input class="p" type="range" data-key="${pd.key}" data-ptype="${isLog ? 'logrange' : 'range'}"
      min="${min}" max="${max}" step="${step}" value="${sliderVal}">
  </div>`;
}

// Parameter editing ---------------------------------------------------------

function onParamInput(e) {
  const el = e.target;
  if (!el.classList || !el.classList.contains('p')) return;
  const card = el.closest('.card');
  if (!card) return;
  const mod = getModule(card.dataset.id);
  if (!mod) return;
  const def = DEFS[mod.type];
  const key = el.dataset.key;
  const pd = def.params.find((p) => p.key === key);
  if (!pd) return;

  const kind = el.dataset.ptype;
  let value;
  if (kind === 'toggle') value = el.checked;
  else if (kind === 'select') value = el.value;
  else if (kind === 'logrange') value = sliderToValue(parseFloat(el.value), pd);
  else value = parseFloat(el.value);

  mod.params[key] = value;
  if (app.engine) app.engine.setParam(mod.id, key, value);

  const label = card.querySelector(`.val[data-val="${key}"]`);
  if (label) label.textContent = formatValue(pd, value);
}

function onClick(e) {
  const del = e.target.closest('.del');
  if (del) {
    const card = del.closest('.card');
    if (card) deleteModule(card.dataset.id);
    return;
  }
  const load = e.target.closest('.load-sample');
  if (load) {
    const card = load.closest('.card');
    const input = card && card.querySelector('.sample-file');
    if (input) input.click();
  }
}

async function onFileChange(e) {
  const el = e.target;
  if (!el.classList || !el.classList.contains('sample-file')) return;
  const card = el.closest('.card');
  if (!card) return;
  const mod = getModule(card.dataset.id);
  const file = el.files && el.files[0];
  if (!mod || !file) return;
  if (!app.ctx) {
    app.toast('Start the audio first');
    return;
  }

  const nameEl = card.querySelector('.sample-name');
  const previousName = nameEl ? nameEl.textContent : 'no sample';
  if (nameEl) nameEl.textContent = 'decoding…';

  try {
    const raw = await file.arrayBuffer();
    const buffer = await decodeSampleFile(app.ctx, raw, file.name);
    mod.data = mod.data || {};
    mod.data.buffer = buffer;
    mod.data.name = file.name;
    if (nameEl) nameEl.textContent = file.name;

    // Attach the sample to the patch so notes from the keyboard play it.
    const connected = app.state.cables.some((c) => c.from.id === mod.id);
    if (!connected) autoConnectModule(mod);
    scheduleCables();
    app.toast('Sample loaded — it now follows the keyboard');
  } catch (err) {
    console.error(err);
    if (nameEl) nameEl.textContent = previousName || 'no sample';
    app.toast(err && err.message ? err.message : 'Could not decode that audio file');
  } finally {
    el.value = '';
  }
}

// A brief glow so a card is easy to spot after the rack has scrolled to it —
// the module a Patch view tap jumped to, or one that was just added.
function flashCard(card) {
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1400);
}

// Scrolls the rack so a module card is on screen (used after adding one).
export function revealModule(id) {
  if (!boardEl || !rackEl) return;
  const card = boardEl.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
  flashCard(card);
  const top = Math.max(0, card.offsetTop - 16);
  const left = Math.max(0, card.offsetLeft - 16);
  if (typeof rackEl.scrollTo === 'function') {
    try {
      rackEl.scrollTo({ top, left, behavior: 'smooth' });
      return;
    } catch (e) {
      /* fall through to assigning directly */
    }
  }
  rackEl.scrollTop = top;
  rackEl.scrollLeft = left;
}

export function deleteModule(id) {
  // The Output is the only module that reaches the speakers, so removing the
  // last one would leave the whole rack silent with nothing to say why. Keep it
  // and say so instead.
  const mod = app.state.modules.find((m) => m.id === id);
  if (mod && mod.type === 'output') {
    const otherOutputs = app.state.modules.filter((m) => m.id !== id && m.type === 'output');
    if (!otherOutputs.length) {
      app.toast('A rack needs its Output — it is the only module that reaches the speakers');
      return;
    }
  }
  for (const c of app.state.cables.filter((c) => c.from.id === id || c.to.id === id)) {
    removeCable(c.id);
  }
  if (app.engine) app.engine.removeModule(id);
  const i = app.state.modules.findIndex((m) => m.id === id);
  if (i >= 0) app.state.modules.splice(i, 1);
  const card = boardEl.querySelector(`.card[data-id="${id}"]`);
  if (card) card.remove();
  updateBoardSize();
  updateRackHint();
  scheduleCables();
}

// Layout --------------------------------------------------------------------

function updateBoardSize() {
  if (!boardEl) return;
  let w = 860;
  let h = 620;
  for (const m of app.state.modules) {
    w = Math.max(w, m.x + CARD_W + BOARD_PAD);
    h = Math.max(h, m.y + 380);
  }
  boardEl.style.width = w + 'px';
  boardEl.style.height = h + 'px';
  if (svgEl) {
    svgEl.setAttribute('width', w);
    svgEl.setAttribute('height', h);
    svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
}

// Cables --------------------------------------------------------------------

export function scheduleCables() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    renderCables();
  });
}

function findPort(id, port, role) {
  return boardEl
    ? boardEl.querySelector(`.port[data-id="${id}"][data-port="${port}"][data-role="${role}"]`)
    : null;
}

function portCenter(el) {
  const b = boardEl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2 - b.left,
    y: r.top + r.height / 2 - b.top
  };
}

function bez(p1, p2) {
  const dx = Math.max(45, Math.abs(p2.x - p1.x) * 0.45);
  return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
}

function renderCables() {
  if (!boardEl || !layerEl) return;
  let html = '';
  for (const c of app.state.cables) {
    const outEl = findPort(c.from.id, c.from.port, 'out');
    const inEl = findPort(c.to.id, c.to.port, 'in');
    if (!outEl || !inEl) continue;
    const p1 = portCenter(outEl);
    const p2 = portCenter(inEl);
    const mod = getModule(c.from.id);
    const hue = mod && DEFS[mod.type] ? DEFS[mod.type].hue : 210;
    html += `<path class="cable" data-id="${c.id}" style="stroke:hsl(${hue} 85% 62%)" d="${bez(p1, p2)}" />`;
  }
  layerEl.innerHTML = html;
}

// Patch view ----------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAP_MIN_ZOOM = 0.5;
const MAP_MAX_ZOOM = 6;
const MAP_TAP_SLOP = 8;
// How far past the edge of the map a drag may go, as a share of the view, so
// the map can be nudged about even before it has been zoomed in.
const MAP_SLACK = 0.15;

let mapSvg = null;
let mapLayer = null;
let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;
let mapGesture = null;
let mapOnPick = null;
const mapPointers = new Map();

function clampNum(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

// Everything the map draws lives in one <g>, so panning and zooming is a single
// transform on it and the drawing itself never has to be redone.
function mapLayerEl(svg) {
  let layer = svg.querySelector('.map-layer');
  if (!layer) {
    layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('class', 'map-layer');
    svg.appendChild(layer);
  }
  return layer;
}

function mapViewBox() {
  if (!mapSvg) return null;
  const parts = (mapSvg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [x, y, w, h] = parts;
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h, right: x + w, bottom: y + h };
}

// Where a finger is in the map's own coordinates. The viewBox can be letterboxed
// on a screen of another shape, so ask the SVG rather than scaling by hand.
function mapPointFromClient(clientX, clientY) {
  if (!mapSvg) return { x: 0, y: 0 };
  const screen = mapSvg.getScreenCTM();
  if (!screen) return { x: 0, y: 0 };
  const p = new DOMPoint(clientX, clientY).matrixTransform(screen.inverse());
  return { x: p.x, y: p.y };
}

// Keep the map over the view: zoomed in, its edges may not come inside the
// view; zoomed out, the whole map stays within it.
function clampMapPan() {
  const vb = mapViewBox();
  if (!vb) return;
  const slackX = vb.w * MAP_SLACK;
  const slackY = vb.h * MAP_SLACK;
  const ax = vb.x * (1 - mapZoom);
  const bx = vb.right * (1 - mapZoom);
  const ay = vb.y * (1 - mapZoom);
  const by = vb.bottom * (1 - mapZoom);
  mapPanX = clampNum(mapPanX, Math.min(ax, bx) - slackX, Math.max(ax, bx) + slackX);
  mapPanY = clampNum(mapPanY, Math.min(ay, by) - slackY, Math.max(ay, by) + slackY);
}

function applyMapTransform() {
  if (!mapLayer) return;
  mapLayer.setAttribute(
    'transform',
    'translate(' + mapPanX.toFixed(2) + ' ' + mapPanY.toFixed(2) + ') scale(' + mapZoom.toFixed(4) + ')'
  );
}

// Zoom, keeping whatever is under the anchor point where it is.
function setMapZoom(zoom, anchor) {
  const vb = mapViewBox();
  if (!vb) return;
  const next = clampNum(zoom, MAP_MIN_ZOOM, MAP_MAX_ZOOM);
  if (Math.abs(next - mapZoom) < 0.0001) return;
  const a = anchor || { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
  const cx = (a.x - mapPanX) / mapZoom;
  const cy = (a.y - mapPanY) / mapZoom;
  mapZoom = next;
  mapPanX = a.x - cx * next;
  mapPanY = a.y - cy * next;
  clampMapPan();
  applyMapTransform();
}

// Put the whole patch back on screen at once, as the view opens.
export function fitPatchMap() {
  mapZoom = 1;
  mapPanX = 0;
  mapPanY = 0;
  // A fresh view starts with no half-finished gesture from the last one.
  mapPointers.clear();
  mapGesture = null;
  if (mapSvg) mapSvg.classList.remove('grabbing');
  applyMapTransform();
}

export function zoomPatchMap(factor) {
  setMapZoom(mapZoom * factor, null);
}

// A full-screen map of the whole patch: every card, its ports and every cable,
// fitted to the screen. It is measured from the live cards, so the map matches
// the rack however the cards are arranged. Returns what the map holds.
export function renderPatchMap(svg) {
  if (!svg || !boardEl) return { modules: 0, cables: 0 };

  const PAD = 46;
  const boxes = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const card of boardEl.querySelectorAll('.card')) {
    const mod = getModule(card.dataset.id);
    if (!mod || !DEFS[mod.type]) continue;
    const x = card.offsetLeft;
    const y = card.offsetTop;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    if (!w || !h) continue;
    boxes.push({ mod, def: DEFS[mod.type], x, y, w, h, el: card });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  // An empty rack still gets a frame, so the view is never a blank screen.
  if (!boxes.length) {
    minX = 24;
    minY = 24;
    maxX = 616;
    maxY = 384;
  } else {
    minX -= PAD;
    minY -= PAD;
    maxX += PAD;
    maxY += PAD;
  }

  svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Cables first, so the cards sit on top of them, as in the rack.
  let markup = '';
  let cables = 0;
  for (const c of app.state.cables) {
    const outEl = findPort(c.from.id, c.from.port, 'out');
    const inEl = findPort(c.to.id, c.to.port, 'in');
    if (!outEl || !inEl) continue;
    const p1 = portCenter(outEl);
    const p2 = portCenter(inEl);
    const mod = getModule(c.from.id);
    const hue = mod && DEFS[mod.type] ? DEFS[mod.type].hue : 210;
    cables++;
    markup += `<path class="map-cable" style="stroke:hsl(${hue} 85% 62%)" d="${bez(p1, p2)}" />`;
  }

  for (const box of boxes) {
    const hue = box.def.hue;
    markup +=
      `<g class="map-module" data-module="${box.mod.id}">` +
      `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="14" ` +
      `style="fill:hsl(${hue} 30% 14%);stroke:hsl(${hue} 42% 34%)" />` +
      `<text class="map-name" x="${box.x + 18}" y="${box.y + 34}" ` +
      `style="fill:hsl(${hue} 72% 82%)">${escapeHtml(box.def.name.toUpperCase())}</text>`;

    for (const portEl of box.el.querySelectorAll('.port')) {
      const p = portCenter(portEl);
      const cv = portEl.classList.contains('kind-cv');
      const dash = cv ? ' stroke-dasharray="4.5 4.5"' : '';
      markup +=
        `<circle cx="${Math.round(p.x)}" cy="${Math.round(p.y)}" r="8" ` +
        `style="fill:#0a0d13;stroke:hsl(${hue} ${cv ? '40% 70%' : '70% 55%'})"${dash} />`;
    }

    markup += '</g>';
  }

  mapSvg = svg;
  mapLayer = mapLayerEl(svg);
  mapLayer.innerHTML = markup;
  fitPatchMap();
  return { modules: boxes.length, cables };
}

// Moving around: one finger drags the map, two pinch it, the wheel zooms it on
// a computer, and Fit puts the whole patch back on screen. A tap that does not
// drag jumps to the module's card instead.
function onMapPointerDown(e) {
  if (!mapSvg) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();

  try {
    mapSvg.setPointerCapture(e.pointerId);
  } catch (err) {
    // A pointer that is already gone cannot be captured; dragging still works.
  }

  const point = { x: e.clientX, y: e.clientY };
  mapPointers.set(e.pointerId, point);

  if (mapPointers.size === 1) {
    const el = e.target && e.target.closest ? e.target.closest('.map-module') : null;
    mapGesture = {
      kind: 'pan',
      pick: el ? el.getAttribute('data-module') : null,
      moved: 0
    };
    mapSvg.classList.add('grabbing');
  } else if (mapPointers.size === 2) {
    const [a, b] = Array.from(mapPointers.values());
    mapGesture = {
      kind: 'pinch',
      pick: null,
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    };
    mapSvg.classList.add('grabbing');
  }
}

function onMapPointerMove(e) {
  if (!mapPointers.has(e.pointerId) || !mapGesture) return;

  const prev = mapPointers.get(e.pointerId);
  const now = { x: e.clientX, y: e.clientY };
  mapPointers.set(e.pointerId, now);

  if (mapGesture.kind === 'pan') {
    const from = mapPointFromClient(prev.x, prev.y);
    const to = mapPointFromClient(now.x, now.y);
    mapPanX += to.x - from.x;
    mapPanY += to.y - from.y;
    mapGesture.moved += Math.hypot(now.x - prev.x, now.y - prev.y);
    clampMapPan();
    applyMapTransform();
    return;
  }

  if (mapGesture.kind === 'pinch' && mapPointers.size >= 2) {
    const [a, b] = Array.from(mapPointers.values());
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    // Slide with the midpoint first, then zoom around it, so the two fingers
    // keep hold of the same part of the patch as they spread or close.
    const from = mapPointFromClient(mapGesture.center.x, mapGesture.center.y);
    const to = mapPointFromClient(center.x, center.y);
    mapPanX += to.x - from.x;
    mapPanY += to.y - from.y;
    clampMapPan();
    applyMapTransform();

    const factor = dist / mapGesture.dist;
    mapGesture.dist = dist;
    mapGesture.center = center;
    setMapZoom(mapZoom * factor, mapPointFromClient(center.x, center.y));
  }
}

function onMapPointerUp(e) {
  if (!mapPointers.has(e.pointerId)) return;
  mapPointers.delete(e.pointerId);

  try {
    if (mapSvg && mapSvg.hasPointerCapture && mapSvg.hasPointerCapture(e.pointerId)) {
      mapSvg.releasePointerCapture(e.pointerId);
    }
  } catch (err) {
    // The capture went with the pointer.
  }

  const gesture = mapGesture;
  if (!gesture) return;

  if (mapPointers.size === 0) {
    mapGesture = null;
    if (mapSvg) mapSvg.classList.remove('grabbing');
    if (e.type === 'pointerup' && gesture.kind === 'pan' && gesture.moved <= MAP_TAP_SLOP && gesture.pick) {
      const pick = gesture.pick;
      if (mapOnPick) mapOnPick(pick);
    }
    return;
  }

  // One finger came off a pinch: carry on panning with the one left.
  if (mapPointers.size === 1) {
    mapGesture = { kind: 'pan', pick: null, moved: Infinity };
    return;
  }

  // Still two or more down: measure the pinch again from the fingers that are
  // left, so a finger joining or leaving does not make the map jump.
  if (mapGesture.kind === 'pinch' && mapPointers.size >= 2) {
    const [a, b] = Array.from(mapPointers.values());
    mapGesture.dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    mapGesture.center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}

function onMapWheel(e) {
  if (!mapSvg) return;
  e.preventDefault();
  const anchor = mapPointFromClient(e.clientX, e.clientY);
  setMapZoom(mapZoom * Math.exp(-e.deltaY * 0.0015), anchor);
}

// Wire the map once. onPick gets a module id when its box is tapped.
export function initPatchMap(onPick) {
  const svg = document.getElementById('patch-map');
  if (!svg) return;
  mapSvg = svg;
  mapLayer = mapLayerEl(svg);
  mapOnPick = typeof onPick === 'function' ? onPick : null;
  svg.addEventListener('pointerdown', onMapPointerDown);
  svg.addEventListener('pointermove', onMapPointerMove);
  svg.addEventListener('pointerup', onMapPointerUp);
  svg.addEventListener('pointercancel', onMapPointerUp);
  svg.addEventListener('wheel', onMapWheel, { passive: false });
}

function onCableClick(e) {
  const p = e.target.closest('path.cable');
  if (!p) return;
  removeCable(p.dataset.id);
  scheduleCables();
}

function drawTemp(p1, p2) {
  if (!tempEl) return;
  tempEl.setAttribute('d', bez(p1, p2));
  tempEl.style.display = 'block';
}

function clearTemp() {
  if (!tempEl) return;
  tempEl.setAttribute('d', '');
  tempEl.style.display = 'none';
}

function readPort(el) {
  return {
    id: el.dataset.id,
    port: el.dataset.port,
    role: el.dataset.role,
    el
  };
}

function setPending(info) {
  clearPending();
  pending = info;
  if (info && info.el) info.el.classList.add('pending');
}

function clearPending() {
  if (pending && pending.el) pending.el.classList.remove('pending');
  pending = null;
}

function tryConnect(a, b) {
  if (!a || !b) return false;
  if (a.id === b.id && a.port === b.port) return false;
  if (a.role === b.role) return false;
  const out = a.role === 'out' ? a : b;
  const inp = a.role === 'in' ? a : b;
  return !!addCable(out.id, out.port, inp.id, inp.port);
}

// Pointer handling ----------------------------------------------------------

function onPointerDown(e) {
  const portEl = e.target.closest('.port');
  const headEl = e.target.closest('.card-head');

  if (portEl) {
    e.preventDefault();
    beginPort(portEl, e);
    return;
  }
  // Tapping anything that is not a port drops a half-made cable.
  clearPending();
  if (headEl && !e.target.closest('.del')) {
    e.preventDefault();
    beginCardDrag(headEl.closest('.card'), e);
  }
}

function beginCardDrag(cardEl, e) {
  const mod = getModule(cardEl.dataset.id);
  if (!mod) return;
  clearPending();
  drag = {
    kind: 'card',
    mod,
    el: cardEl,
    startX: e.clientX,
    startY: e.clientY,
    ox: mod.x,
    oy: mod.y
  };
  cardEl.classList.add('dragging');
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function beginPort(portEl, e) {
  const info = readPort(portEl);

  if (pending) {
    if (tryConnect(pending, info)) {
      clearPending();
      scheduleCables();
      return;
    }
    if (pending.id === info.id && pending.port === info.port) {
      clearPending();
      return;
    }
  }

  setPending(info);
  drag = {
    kind: 'cable',
    from: info,
    fromEl: portEl,
    startX: e.clientX,
    startY: e.clientY,
    moved: false
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function onPointerMove(e) {
  if (!drag) return;

  if (drag.kind === 'card') {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const nx = Math.max(0, Math.round((drag.ox + dx) / 5) * 5);
    const ny = Math.max(0, Math.round((drag.oy + dy) / 5) * 5);
    drag.mod.x = nx;
    drag.mod.y = ny;
    drag.el.style.left = nx + 'px';
    drag.el.style.top = ny + 'px';
    updateBoardSize();
    scheduleCables();
  } else if (drag.kind === 'cable') {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 8) drag.moved = true;
    const rect = boardEl.getBoundingClientRect();
    drawTemp(portCenter(drag.fromEl), {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    });
  }
}

function onPointerUp(e) {
  if (!drag) return;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);

  if (drag.kind === 'card') {
    drag.el.classList.remove('dragging');
    scheduleCables();
  } else if (drag.kind === 'cable') {
    clearTemp();
    const target = targetPortUnder(e.clientX, e.clientY);
    if (target && tryConnect(drag.from, readPort(target))) {
      clearPending();
      scheduleCables();
    } else if (!drag.moved) {
      // Keep the port armed so a second tap completes the cable.
    } else {
      clearPending();
    }
  }
  drag = null;
}

function targetPortUnder(x, y) {
  const hit = document.elementFromPoint(x, y);
  return hit && hit.closest ? hit.closest('.port') : null;
}

// Scope drawing -------------------------------------------------------------

export function startScopeLoop() {
  const draw = () => {
    if (boardEl && app.engine) {
      const cards = boardEl.querySelectorAll('.card[data-type="scope"]');
      for (const card of cards) {
        const canvas = card.querySelector('canvas.scope');
        if (!canvas) continue;
        const rt = app.engine.getRuntime(card.dataset.id);
        const an = rt && rt.analyser;
        if (!an) continue;
        const g = canvas.getContext('2d');
        if (!g) continue;
        const w = canvas.width;
        const h = canvas.height;
        const data = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(data);
        g.clearRect(0, 0, w, h);
        g.strokeStyle = '#5ce1e6';
        g.lineWidth = 1.5;
        g.beginPath();
        for (let i = 0; i < w; i++) {
          const v = data[Math.floor((i / w) * data.length)] || 0;
          const y = h / 2 - v * (h / 2 - 2);
          if (i === 0) g.moveTo(i, y);
          else g.lineTo(i, y);
        }
        g.stroke();
      }
    }
    requestAnimationFrame(draw);
  };
  draw();
}
