// Keeping the rack across a reload.
//
// The state lives in memory only: a page that is reloaded, or a browser that iOS
// closes because it would not answer a request it was shown, starts again from an
// empty room. So the rack, its cables and the recorded channels are written down
// as they go and read back on the next load. A sample is the one thing that cannot
// be written down — an AudioBuffer is not text — so a Sampler comes back with its
// settings and no sample, which is what its card then reads.

import { app, CHANNEL_COUNT } from './app.js';
import { DEFS, defaultParams } from './modules.js';

const KEY = 'patchbay.rack.v1';
const SAVE_MS = 2000;

function number(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function idNumber(id) {
  const n = Number(String(id).replace(/\D/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Start from what the module's definition asks for and let the saved values
// overwrite only the parameters it still has, so a rack saved by an older build
// cannot leave a module with a missing or stale parameter.
function cleanParams(type, saved) {
  const def = DEFS[type];
  const params = defaultParams(type);
  if (!def) return params;
  for (const pd of def.params) {
    const v = saved && saved[pd.key];
    if (v == null) continue;
    if (pd.type === 'toggle') params[pd.key] = !!v;
    else if (pd.type === 'select') params[pd.key] = String(v);
    else params[pd.key] = number(v, params[pd.key]);
  }
  return params;
}

function cleanModule(m, seen) {
  if (!m || typeof m !== 'object') return null;
  const type = String(m.type);
  if (!DEFS[type]) return null;
  const id = String(m.id || '');
  if (!id || seen.has(id)) return null;
  seen.add(id);
  return {
    id,
    type,
    x: Math.max(0, number(m.x, 30)),
    y: Math.max(0, number(m.y, 30)),
    params: cleanParams(type, m.params),
    data: {}
  };
}

function cleanCable(c, byId) {
  if (!c || !c.from || !c.to) return null;
  const from = byId.get(String(c.from.id));
  const to = byId.get(String(c.to.id));
  if (!from || !to) return null;
  const fromPort = String(c.from.port);
  const toPort = String(c.to.port);
  if (!DEFS[from.type].outputs.some((p) => p.id === fromPort)) return null;
  if (!DEFS[to.type].inputs.some((p) => p.id === toPort)) return null;
  return {
    id: String(c.id),
    from: { id: from.id, port: fromPort },
    to: { id: to.id, port: toPort }
  };
}

function cleanEvents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || !Number.isFinite(Number(e.midi)) || !Number.isFinite(Number(e.start))) {
      continue;
    }
    out.push({
      midi: Math.round(number(e.midi, 60)),
      start: Math.max(0, number(e.start, 0)),
      end: e.end == null ? null : Math.max(0, number(e.end, 0)),
      vel: clamp(number(e.vel, 0.85), 0.01, 1)
    });
  }
  return out;
}

// Read a saved rack back into the app. Returns true when there was one to read,
// and false for anything unreadable, so the default rack is built instead.
export function loadRack() {
  let saved = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    saved = JSON.parse(raw);
  } catch (e) {
    return false;
  }
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.modules)) return false;

  try {
    const seen = new Set();
    const modules = saved.modules.map((m) => cleanModule(m, seen)).filter(Boolean);
    const byId = new Map(modules.map((m) => [m.id, m]));

    app.state.modules = modules;
    app.state.cables = (Array.isArray(saved.cables) ? saved.cables : [])
      .map((c) => cleanCable(c, byId))
      .filter(Boolean);

    app.state.bpm = clamp(number(saved.bpm, app.state.bpm), 40, 240);
    app.state.master = clamp(number(saved.master, app.state.master), 0, 1);
    app.keyBase = clamp(number(saved.keyBase, app.keyBase), 12, 72);

    const channel = clamp(Math.round(number(saved.channel, 0)), 0, CHANNEL_COUNT - 1);
    const channels = [];
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      channels.push(cleanEvents((Array.isArray(saved.channels) ? saved.channels : [])[i]));
    }
    app.song.channels = channels;
    app.song.channel = channel;
    app.song.events = channels[channel];
    app.song.loop = !!saved.loop;

    // Ids come from a counter that starts at 1 again on a reload, so it has to
    // begin after the highest id the restored rack holds.
    let maxId = 0;
    for (const m of modules) maxId = Math.max(maxId, idNumber(m.id));
    for (const c of app.state.cables) maxId = Math.max(maxId, idNumber(c.id));
    app.nextId = Math.max(app.nextId, maxId + 1);

    return true;
  } catch (e) {
    return false;
  }
}

// Write the state down. Cheap enough for a timer: a rack is a few kilobytes and
// nothing here is audio.
export function saveRack() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        bpm: app.state.bpm,
        master: app.state.master,
        keyBase: app.keyBase,
        channel: app.song.channel,
        loop: app.song.loop,
        modules: app.state.modules.map((m) => ({
          id: m.id,
          type: m.type,
          x: m.x,
          y: m.y,
          params: m.params
        })),
        cables: app.state.cables,
        channels: app.song.channels
      })
    );
  } catch (e) {
    /* no storage, or no room: the rack simply does not survive a reload */
  }
}

export function startAutoSave(ms = SAVE_MS) {
  saveRack();
  // A phone can hide the page at any moment; writing once more on the way out
  // keeps the last notes of a take.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveRack();
  });
  return setInterval(saveRack, ms);
}
