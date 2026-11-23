// The lyric channel -----------------------------------------------------------
//
// The fifth channel is the only one that records audio rather than notes: a
// voice take, captured from the microphone while the four note channels play
// along as a backing. What it holds is the lyric exactly as it was sung — the
// buffer is the frames that arrived, with nothing trimmed, normalised or faded —
// and it is placed on the same timeline as the notes, so it plays back with them
// and is mixed into them on export.
//
// Recording lives here as well as playback, because both sides deal with the
// same audio: a capture that lines the take up with the song's clock, and a
// source that puts it back there. The transport in js/keyboard.js decides when to
// start and stop a take; this file decides how one is captured, kept and played.

import { app, setAudioSession, LYRIC_CHANNEL, MAX_CHANNEL_VOLUME } from './app.js?v=13';
import { openMicrophone } from './sample-recorder.js?v=13';

// The voice joins the mix after the rack's own levelling at this gain, so it sits
// under the patch rather than on top of it. See Engine's rackGain.
const LYRIC_GAIN = 0.6;
// A phone microphone held at arm's length records a quiet take, and a lyric that
// cannot be heard is not much of a lyric. A take below this peak is lifted
// towards it — never more than four times — while the audio that is kept is left
// exactly as it was captured.
const LYRIC_TARGET = 0.8;
const LYRIC_MAX_BOOST = 4;

// How long a stop waits for the audio thread's last block to arrive before the
// take is built from what it already has.
const FLUSH_WAIT_MS = 220;

const WORKLET_NAME = 'lyric-recorder';
const WORKLET_URL = new URL('./lyric-recorder-worklet.js?v=13', import.meta.url).href;

// A lyric take wants the backing out of it. The microphone sits near the phone's
// own speaker, so echo cancellation is asked for — unlike the sample recorder,
// whose voice take has no other sound in the room to keep out. Noise suppression
// and automatic gain stay off, so the voice arrives as it sounded.
export const LYRIC_MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false
};

let capture = null; // { stream, source, node, sink, chunks, start, rate }
let liveNode = null; // { src, gain } for the take being played back
let workletCtx = null;
let workletReady = null;

// Ask for a microphone for the lyric channel. Called straight from the tap that
// started the take, so the browser sees the player's own gesture behind it.
export function requestLyricMic() {
  return openMicrophone(LYRIC_MIC_CONSTRAINTS);
}

// The worklet module is loaded once per context; a replaced context gets its own.
function loadWorklet(ctx) {
  if (!ctx.audioWorklet) return Promise.reject(new Error('No AudioWorklet'));
  if (workletCtx === ctx && workletReady) return workletReady;
  workletCtx = ctx;
  workletReady = ctx.audioWorklet.addModule(WORKLET_URL).catch((e) => {
    workletReady = null;
    workletCtx = null;
    throw e;
  });
  return workletReady;
}

// Build the recorder and join it to the microphone, ready to be told when to
// start. This is separate from beginLyricCapture so the worklet module can be
// loaded — which takes a moment the first time — before the backing and the voice
// are given a shared start time to hit. Resolves false when this browser cannot
// run the recorder; the caller then says so rather than leaving an empty take.
export async function armLyricCapture(stream) {
  const ctx = app.ctx;
  if (!ctx || !stream) return false;
  if (typeof AudioWorkletNode !== 'function') return false;

  dropCapture(capture);
  capture = null;

  try {
    await loadWorklet(ctx);
  } catch (e) {
    console.warn('The lyric recorder is not available', e);
    return false;
  }

  let source = null;
  let node = null;
  let sink = null;
  try {
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    source.connect(node);
    // The recorder has to reach a destination to be pulled by the graph, and
    // nothing it hears may be monitored: the worklet writes no output of its
    // own, so its silent output is all that goes on.
    sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(app.output || ctx.destination);
  } catch (e) {
    console.warn('Could not build the lyric recorder', e);
    try {
      if (source) source.disconnect();
    } catch (err) {
      /* ignore */
    }
    try {
      if (node) node.disconnect();
    } catch (err) {
      /* ignore */
    }
    try {
      if (sink) sink.disconnect();
    } catch (err) {
      /* ignore */
    }
    return false;
  }

  const c = {
    stream,
    source,
    node,
    sink,
    chunks: [],
    start: null, // context time the take really began at
    rate: ctx.sampleRate
  };
  capture = c;

  node.port.onmessage = (e) => {
    if (capture !== c) return;
    const d = e.data;
    if (!d || !d.frames) return;
    if (d.start != null && c.start == null) c.start = d.start;
    c.chunks.push(d.frames);
  };
  return true;
}

// Tell the recorder when on the context's clock the take begins. Called before
// the backing is started, with a moment between the message and the start time,
// so the first frame kept is the frame the notes start on.
export function beginLyricCapture(startAt) {
  const c = capture;
  if (!c) return false;
  try {
    c.node.port.postMessage({ record: true, start: startAt });
  } catch (e) {
    dropCapture(c);
    capture = null;
    return false;
  }
  return true;
}

// Stop the take and hand back what it holds: { buffer, offset, duration, peak,
// recordedAt }, or null when nothing was picked up. The buffer is the captured
// frames as they arrived — no trimming, no normalising, no fade.
export function stopLyricCapture() {
  const c = capture;
  if (!c) return Promise.resolve(null);
  capture = null;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const take = buildTake(c);
      dropCapture(c);
      resolve(take);
    };

    c.node.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.frames) {
        if (d.start != null && c.start == null) c.start = d.start;
        c.chunks.push(d.frames);
      }
      if (d.done) finish();
    };

    timer = setTimeout(finish, FLUSH_WAIT_MS);

    try {
      c.node.port.postMessage({ record: false });
    } catch (e) {
      finish();
    }
  });
}

// Let go of a microphone stream and put the page back in its full-volume playback
// session: recording is its own session, and the synth left in it is quiet and
// routed the way a phone call would be.
export function stopLyricStream(stream) {
  if (stream) {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      /* ignore */
    }
  }
  setAudioSession('playback');
}

function dropCapture(c) {
  if (!c) return;
  try {
    c.source.disconnect();
  } catch (e) {
    /* ignore */
  }
  try {
    c.node.port.onmessage = null;
    c.node.disconnect();
  } catch (e) {
    /* ignore */
  }
  try {
    c.sink.disconnect();
  } catch (e) {
    /* ignore */
  }
  stopLyricStream(c.stream);
}

function buildTake(c) {
  const ctx = app.ctx;
  if (!ctx || !c || !c.chunks.length) return null;

  let total = 0;
  for (const ch of c.chunks) total += ch.length;
  if (!total) return null;

  let buffer;
  try {
    buffer = ctx.createBuffer(1, total, c.rate);
  } catch (e) {
    return null;
  }

  const data = buffer.getChannelData(0);
  let off = 0;
  let peak = 0;
  for (const ch of c.chunks) {
    data.set(ch, off);
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
    off += ch.length;
  }
  c.chunks = [];

  // Where the take sits on the song's timeline: the moment the audio thread says
  // it really began, measured from the moment recording was asked for.
  const recStart = Number(app.song.recStart) || 0;
  const start = c.start == null ? recStart : c.start;

  return {
    buffer,
    offset: Math.max(0, start - recStart),
    duration: buffer.duration,
    peak,
    recordedAt: Date.now()
  };
}

// Mixing the take in ---------------------------------------------------------

// A quiet take is lifted towards a level that can be heard under the patch, and
// a take that is already there is left alone. The audio that is kept is never
// changed; this is only the gain it is mixed at.
function mixGainFor(take) {
  const peak = take && take.peak;
  let boost = 1;
  if (peak && peak > 0.0005) {
    boost = Math.min(LYRIC_MAX_BOOST, Math.max(1, LYRIC_TARGET / peak));
  }
  return LYRIC_GAIN * boost;
}

// The channel's own level, as the fifth knob above the keyboard sets it.
function channelVolume() {
  const v = app.song.volumes ? app.song.volumes[LYRIC_CHANNEL] : 1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_CHANNEL_VOLUME, n)) : 1;
}

// Put the lyric take into a graph — the live one or an export's — starting at
// `startAt` on that context's clock, at its place on the song's timeline. `into`
// is either an engine (the take joins at its volume knob, after the rack's own
// levelling) or a node to join directly. `volume` is the channel's knob; the
// live take keeps a handle on its own so a move while it plays is heard at once.
// Returns the nodes so a live take can be stopped again, or null when there is
// nothing to play.
export function mixLyricsInto(ctx, into, startAt, volume = 1) {
  const take = app.song.lyrics;
  if (!take || !take.buffer || !ctx || !into) return null;

  // At the volume knob, after the rack's own levelling: the voice keeps its
  // recorded shape instead of being driven to full scale by a stage meant for a
  // quiet patch, and the Vol control takes it down with everything else.
  const dest = into.volume || into;
  if (!dest || !dest.connect) return null;

  try {
    const src = ctx.createBufferSource();
    src.buffer = take.buffer;
    const gain = ctx.createGain();
    gain.gain.value = mixGainFor(take);
    // The channel's knob on its way to the rack, so the lyrics can be balanced
    // against the four note parts.
    const trim = ctx.createGain();
    trim.gain.value = Number.isFinite(Number(volume))
      ? Math.max(0, Math.min(MAX_CHANNEL_VOLUME, Number(volume)))
      : 1;
    src.connect(gain);
    gain.connect(trim);
    trim.connect(dest);
    // A take later than the point playback started by more than the clock has
    // already run is placed where it belongs; one that is already behind it
    // starts at once.
    const when = Math.max(ctx.currentTime, (startAt || 0) + (take.offset || 0));
    src.start(when);
    return { src, gain, trim };
  } catch (e) {
    console.warn('Could not play the lyrics', e);
    return null;
  }
}

// Move the lyric knob under a take that is already playing.
export function setLyricVolume(v) {
  const node = liveNode;
  if (!node || !node.trim || !app.ctx) return;
  const n = Number(v);
  const value = Number.isFinite(n) ? Math.max(0, Math.min(MAX_CHANNEL_VOLUME, n)) : 1;
  try {
    node.trim.gain.setTargetAtTime(value, app.ctx.currentTime, 0.02);
  } catch (e) {
    node.trim.gain.value = value;
  }
}

// Play the lyric take with the notes, from `startAt` on the live context's clock.
export function playLyrics(startAt) {
  // The take already playing is replaced without letting go of the headroom it
  // asked for, so a loop or a second run does not dip the rack on the way in.
  dropLiveSource();
  const engine = app.engine;
  if (!engine || !app.ctx) return;
  const node = mixLyricsInto(app.ctx, engine, startAt, channelVolume());
  liveNode = node;
  if (node && engine.setLyricHeadroom) engine.setLyricHeadroom(true);
}

// Stop the take that is playing and give the rack its own level back.
export function stopLyrics() {
  dropLiveSource();
  const engine = app.engine;
  if (engine && engine.setLyricHeadroom) engine.setLyricHeadroom(false);
}

function dropLiveSource() {
  const node = liveNode;
  liveNode = null;
  if (!node) return;
  try {
    node.src.stop();
  } catch (e) {
    /* already ended */
  }
  try {
    node.src.disconnect();
  } catch (e) {
    /* ignore */
  }
  try {
    node.gain.disconnect();
  } catch (e) {
    /* ignore */
  }
  try {
    if (node.trim) node.trim.disconnect();
  } catch (e) {
    /* ignore */
  }
}
