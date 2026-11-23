// Shared application state and small helpers used by every UI module.

// Each channel holds its own take, so the parts can be recorded one after
// another and mixed down together. The first four hold note events; the fifth is
// the lyric channel, which holds recorded audio instead — a voice take — so it
// keeps itself for playback while the other four stay notes.
export const NOTE_CHANNEL_COUNT = 4;
export const LYRIC_CHANNEL = NOTE_CHANNEL_COUNT;
export const CHANNEL_COUNT = NOTE_CHANNEL_COUNT + 1;

// The most a channel's volume knob can lift its part: twice the level it was
// recorded at, +6 dB. A channel can therefore be brought up in a mix as well as
// taken down — a quiet take or a soft voice can be made to sit in the song
// rather than only ever be pulled back — while the knob still leaves a whole
// 60 dB below unity for tucking a part under the rest.
export const MAX_CHANNEL_VOLUME = 2;

export const app = {
  ctx: null,
  engine: null,
  // Where the live graph's output goes: the page's own route into the speakers,
  // so a phone plays it on the loud media session. See js/output-route.js.
  output: null,
  state: {
    bpm: 120,
    master: 1,
    modules: [], // { id, type, x, y, params: {}, data: {} }
    cables: []   // { id, from: { id, port }, to: { id, port } }
  },
  song: {
    // One take per channel. The lyric channel's own list stays empty: its take
    // is audio, kept in `lyrics` below, so it survives the note channels being
    // cleared and retaken.
    channels: [[], [], [], [], []], // { midi, start, end, vel }
    // The rack each note channel was recorded with, taken when its take started:
    // { bpm, master, modules, cables }. A take played back or mixed down goes
    // through its own snapshot, so channel 1 keeps its sample while channel 2
    // keeps the default patch and channel 3 keeps the effects it was made with.
    // See js/voices.js.
    racks: [null, null, null, null],
    // One playback level per channel, set by the five knobs above the keyboard:
    // the note channels are trimmed where they join the voice bus, and the lyric
    // take on its way into the rack's volume. A part is heard at its knob while
    // it plays, so the mix can be balanced without stopping it. 1 is unity — the
    // level a part was recorded at — and the top of a knob's turn is
    // MAX_CHANNEL_VOLUME, +6 dB above it.
    volumes: [1, 1, 1, 1, 1],
    // The song's name, typed at the top of the app or in the Mix sheet: it is
    // what the files it is exported as are called — <name>.wav, <name>.flac,
    // <name>.ogg and <name>.json. Empty until the player names it, and every
    // export keeps its plain default name while it is.
    name: '',
    channel: 0,                 // the channel new notes are recorded to
    events: [],                 // the take of `channel`, what Rec writes to
    recording: false,
    recStart: 0,
    loop: false,
    playing: false,
    // How a take is timed: `click` counts a bar in and keeps the beat under the
    // take; `quantize` snaps a finished take to the sixteenth. Both are switchable
    // from the transport, and both are back at their first-visit state on every
    // load, like the rest of the session.
    click: true,
    quantize: false,
    // The lyric take: { buffer, offset, duration, peak, recordedAt }. The buffer
    // is the voice exactly as it was captured — nothing trims, normalises or
    // fades it — and `offset` places it on the same timeline as the notes.
    lyrics: null,
    lyricRecording: false       // a lyric take is running, not a note take
  },
  keyBase: 48,    // MIDI note of the lowest key
  nextId: 1,
  toast: () => {},
  onCablesChanged: null
};

app.song.events = app.song.channels[app.song.channel];

// What kind of audio the page says it is making -------------------------------
//
// On iOS the Audio Session type picks the system session the page's sound plays
// in. "playback" is full-volume music out of the speaker; a page that never asks
// for it can be put in the ambient session, mixed down under other audio and
// following the silent switch, which reads back as the synth having no volume at
// all. Everywhere else, and in a browser without the API, setting it does
// nothing.
//
// The last type the page asked for is kept here, so a re-assertion after an
// interruption asks for that one and never undoes a recording session mid-take.
let audioSessionType = 'playback';

export function setAudioSession(type) {
  audioSessionType = type;
  try {
    const session = typeof navigator === 'undefined' ? null : navigator.audioSession;
    if (session) session.type = type;
  } catch (e) {
    /* no Audio Session API, or a browser that refuses the type */
  }
}

export function getAudioSessionType() {
  return audioSessionType;
}

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
  // A cleared take takes its rack with it: the next recording of that channel
  // is made with whatever the rack is at the time, not the one before.
  if (app.song.racks[i] !== undefined) app.song.racks[i] = null;
}

export function clearAllChannels() {
  for (let i = 0; i < CHANNEL_COUNT; i++) clearChannel(i);
  // The lyric channel's take is audio rather than notes, so it is let go here
  // rather than in the loop above; Clear song empties all five channels.
  app.song.lyrics = null;
  app.song.events = app.song.channels[app.song.channel];
}

// Every note channel on one timeline, for playing back and for mixing down.
// Pass a note channel index to leave it out — the take that is being recorded.
// The lyric channel is not a list of notes: it is mixed in on its own, in
// js/lyrics.js.
export function mixEvents(exclude = -1) {
  const out = [];
  for (let i = 0; i < NOTE_CHANNEL_COUNT; i++) {
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

// Whether the lyric channel holds a take. It is audio, so it is checked on its
// own rather than by counting notes.
export function hasLyrics() {
  const take = app.song.lyrics;
  return !!(take && take.buffer);
}

// Where the lyric take stops on the shared timeline, in seconds. The song is as
// long as whichever runs on longer — the notes or the voice.
export function lyricEnd() {
  const take = app.song.lyrics;
  if (!take || !take.buffer) return 0;
  return (take.offset || 0) + take.buffer.duration;
}
