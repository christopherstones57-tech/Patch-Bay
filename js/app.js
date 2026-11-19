// Shared application state and small helpers used by every UI module.

// Each channel holds its own take of note events, so four parts can be recorded
// one after another and mixed down together.
export const CHANNEL_COUNT = 4;

export const app = {
  ctx: null,
  engine: null,
  state: {
    bpm: 120,
    master: 0.8,
    modules: [], // { id, type, x, y, params: {}, data: {} }
    cables: []   // { id, from: { id, port }, to: { id, port } }
  },
  song: {
    channels: [[], [], [], []], // one take per channel: { midi, start, end, vel }
    channel: 0,                 // the channel new notes are recorded to
    events: [],                 // the take of `channel`, what Rec writes to
    recording: false,
    recStart: 0,
    loop: false,
    playing: false
  },
  keyBase: 48,    // MIDI note of the lowest key
  nextId: 1,
  toast: () => {},
  onCablesChanged: null
};

app.song.events = app.song.channels[app.song.channel];

export function uid(prefix) {
  return prefix + app.nextId++;
}

export function getModule(id) {
  return app.state.modules.find((m) => m.id === id) || null;
}

export function addCable(fromId, fromPort, toId, toPort) {
  const cables = app.state.cables;
  if (
    cables.some(
      (c) =>
        c.from.id === fromId &&
        c.from.port === fromPort &&
        c.to.id === toId &&
        c.to.port === toPort
    )
  ) {
    return null;
  }
  const cable = {
    id: uid('c'),
    from: { id: fromId, port: fromPort },
    to: { id: toId, port: toPort }
  };
  cables.push(cable);
  if (app.engine) app.engine.connectCable(cable);
  return cable;
}

export function removeCable(id) {
  const i = app.state.cables.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [cable] = app.state.cables.splice(i, 1);
  if (app.engine) app.engine.disconnectCable(cable);
}

export function removeAllCables() {
  for (const c of app.state.cables.slice()) removeCable(c.id);
}

// Channels -------------------------------------------------------------------

export function setChannel(i) {
  if (!(i >= 0 && i < CHANNEL_COUNT)) return;
  app.song.channel = i;
  app.song.events = app.song.channels[i];
}

export function clearChannel(i) {
  const list = app.song.channels[i];
  if (list) list.length = 0;
}

export function clearAllChannels() {
  for (let i = 0; i < CHANNEL_COUNT; i++) clearChannel(i);
  app.song.events = app.song.channels[app.song.channel];
}

// Every channel on one timeline, for playing back and for mixing down. Pass a
// channel index to leave it out — the take that is being recorded.
export function mixEvents(exclude = -1) {
  const out = [];
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    if (i === exclude) continue;
    for (const ev of app.song.channels[i]) out.push(ev);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export function songLength(events = app.song.events) {
  let end = 0;
  for (const e of events) {
    const e2 = e.end == null ? e.start + 0.3 : e.end;
    if (e2 > end) end = e2;
  }
  return Math.max(end, 0.5);
}
