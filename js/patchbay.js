// The patch bay: module cards, ports, patch cables and drag interactions.

import { DEFS } from './modules.js';
import { app, getModule, removeCable, addCable } from './app.js';
import { autoConnectModule } from './autopatch.js';
import { decodeSampleFile } from './decode-audio.js';

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

// Scrolls the rack so a module card is on screen (used after adding one).
export function revealModule(id) {
  if (!boardEl || !rackEl) return;
  const card = boardEl.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
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
