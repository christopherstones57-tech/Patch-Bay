// Every visit starts from a clean room ---------------------------------------
//
// Nothing about a session is carried over: a reload — or a browser iOS closes
// because it would not answer a request it was shown — opens on the default rack
// with every module at its original settings, the five channels empty, their
// knobs at 0 dB, the song stopped, Rec on channel 1 and the keyboard at its
// middle octave. What is written on the device on purpose — the player's own
// presets — stays; a rack, a take or a mix does not.
//
// The cleaning below is what a preset or a song file goes through on its way in:
// only settings the current build knows are kept, so a file from another visit
// cannot leave a module with a missing or stale parameter.

import { app, CHANNEL_COUNT, NOTE_CHANNEL_COUNT } from './app.js?v=12';
import { DEFS, defaultParams } from './modules.js?v=12';

const KEY = 'patchbay.rack.v1';

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

// Ids come from a counter that starts again when the page is reloaded or a
// preset is loaded, so it has to begin after the highest id the rack holds.
export function noteIds(modules, cables) {
  let maxId = 0;
  for (const m of modules) maxId = Math.max(maxId, idNumber(m.id));
  for (const c of cables) maxId = Math.max(maxId, idNumber(c.id));
  app.nextId = Math.max(app.nextId, maxId + 1);
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

export function cleanModule(m, seen) {
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

export function cleanCable(c, byId) {
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

export function cleanEvents(list) {
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

// A channel's own rack, saved with the take so the channel can be played back
// and mixed down through the sound it was recorded with. Only what a rack is —
// modules, settings and cables — is written down; a Sampler's sample is an
// AudioBuffer and cannot be, so that channel comes back with its patch and no
// sample, the same as the rack's own Sampler does.
export function cleanRack(saved) {
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.modules)) return null;
  try {
    const seen = new Set();
    const modules = saved.modules.map((m) => cleanModule(m, seen)).filter(Boolean);
    if (!modules.length) return null;
    const byId = new Map(modules.map((m) => [m.id, m]));
    return {
      bpm: clamp(number(saved.bpm, 120), 40, 240),
      master: clamp(number(saved.master, 1), 0, 1),
      modules,
      cables: (Array.isArray(saved.cables) ? saved.cables : [])
        .map((c) => cleanCable(c, byId))
        .filter(Boolean)
    };
  } catch (e) {
    return null;
  }
}

// Read what the last visit left behind. Nothing is ever kept between visits now,
// so this only puts the in-memory song back to its first-visit state — the five
// channels empty, their knobs at 0 dB, no loop, Rec on channel 1, the keyboard
// at its middle octave — and clears anything an older build had written down.
// Returns false, as there is no session to restore.
export function loadRack() {
  app.song.channels = [];
  for (let i = 0; i < CHANNEL_COUNT; i++) app.song.channels.push([]);

  app.song.racks = [];
  for (let i = 0; i < NOTE_CHANNEL_COUNT; i++) app.song.racks.push(null);

  app.song.volumes = [];
  for (let i = 0; i < CHANNEL_COUNT; i++) app.song.volumes.push(1);

  app.song.channel = 0;
  app.song.events = app.song.channels[0];
  app.song.loop = false;
  app.song.playing = false;
  // The click is on and Quantize is off, the way a first visit finds them: a
  // take is counted in, and its timing is kept as it was played.
  app.song.click = true;
  app.song.quantize = false;
  app.song.recording = false;
  app.song.lyricRecording = false;
  app.song.lyrics = null;
  app.song.name = '';
  app.keyBase = 48;

  forgetSession();
  return false;
}

// Forget whatever an older build left on the device. Kept under the name the
// paths that used to write the session down call — a song import, the Default
// rack button — so they clear it too rather than filling it again.
export function saveRack() {
  forgetSession();
}

// There is nothing being kept between visits, so there is no timer to start.
export function startAutoSave() {
  forgetSession();
  return null;
}

function forgetSession() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    /* no storage: nothing was kept anyway */
  }
}
