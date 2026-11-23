// Each recorded channel keeps the rack it was recorded with ------------------
//
// A take is only half a recording: the sound that made it — the modules, their
// settings and the cables between them — is the other half. So a snapshot of the
// rack is taken when a take starts and kept with its channel, and playback and
// export build one graph per channel from that channel's own snapshot. Channel 1
// recorded on a Sampler keeps its sample, channel 2 recorded on the default
// patch keeps that patch, and a channel recorded on a rack of its own keeps its
// effects — all at once, and unchanged by whatever the rack is now.
//
// The snapshot is of the rack, not of its sound: a Sampler's loaded sample is an
// AudioBuffer, so the snapshot holds on to the very buffer the channel was
// recorded with (a shallow copy of the module's data). The buffer is never
// changed in place, so a sample loaded later lands on the live module and leaves
// the recorded channel as it was. A snapshot written down and read back after a
// reload has no buffer to bring back — the sample is the one thing that lives
// only as long as the page — so a Sampler channel plays silent until a sample is
// loaded into it again.

import { app, NOTE_CHANNEL_COUNT, MAX_CHANNEL_VOLUME } from './app.js?v=12';
import { Engine } from './engine.js?v=12';

// The rack as it stands this moment, deep enough to be played on its own.
export function snapshotRack() {
  return {
    bpm: app.state.bpm,
    master: app.state.master,
    modules: app.state.modules.map((m) => ({
      id: m.id,
      type: m.type,
      x: m.x,
      y: m.y,
      params: { ...m.params },
      // A shallow copy keeps whatever a module is holding — a Sampler's sample —
      // by reference, while later changes to the live module stay on the live
      // module.
      data: { ...(m.data || {}) }
    })),
    cables: app.state.cables.map((c) => ({
      id: c.id,
      from: { id: c.from.id, port: c.from.port },
      to: { id: c.to.id, port: c.to.port }
    }))
  };
}

// The rack a channel plays through: the one it was recorded with, or — for a
// take made before the channel kept its rack — the rack as it is now.
export function rackFor(channel) {
  return app.song.racks[channel] || snapshotRack();
}

// Where every channel's voice is summed before it reaches the speakers. It lives
// for as long as the AudioContext, so the Ogg capture, the visualiser and the
// meter can all listen to the same point whether or not anything is playing.
let bus = null;
let busCtx = null;

export function voiceBus() {
  const ctx = app.ctx;
  if (!ctx) return null;
  if (busCtx !== ctx || !bus) {
    try {
      if (bus) bus.disconnect();
    } catch (e) {
      /* already gone */
    }
    bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(app.output || ctx.destination);
    busCtx = ctx;
  }
  return bus;
}

// Per-channel knobs ----------------------------------------------------------
//
// The five knobs above the keyboard set one level per channel. A channel that is
// playing is trimmed at the gain that feeds the voice bus, so turning a knob is
// heard at once; and the live rack itself plays under the knob of the channel
// Rec is set to, so a part is heard while it is recorded at the level it will
// play back at. The lyric take is trimmed in js/lyrics.js.
let liveParts = new Map(); // channel index → { gain, share }

function volumeAt(i) {
  const v = app.song.volumes ? app.song.volumes[i] : 1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_CHANNEL_VOLUME, n)) : 1;
}

export function channelVolume(i) {
  return volumeAt(i);
}

// The live rack under the knob of the channel Rec is set to. The lyric channel
// governs its own take instead, so selecting it leaves the synth where it is.
export function applyLiveChannel(i) {
  if (!app.engine || !app.engine.setTrim) return;
  if (!(i >= 0 && i < NOTE_CHANNEL_COUNT)) return;
  app.engine.setTrim(channelVolume(i));
}

// Turn one channel's knob: the channel while it plays (its own gain feeds the
// voice bus), and the lyric take through js/lyrics.js.
export function setChannelVolume(i, v) {
  const n = Number(v);
  const value = Number.isFinite(n) ? Math.max(0, Math.min(MAX_CHANNEL_VOLUME, n)) : 1;
  const entry = liveParts.get(i);
  if (!entry || !app.ctx) return;
  try {
    entry.gain.gain.setTargetAtTime(entry.share * value, app.ctx.currentTime, 0.02);
  } catch (e) {
    entry.gain.gain.value = entry.share * value;
  }
}

// Build one engine per channel that holds notes, playing through that channel's
// own snapshot, and return the groups the transport schedules and a way to let
// them go again. `channels` are note channel indices.
export function openVoices(channels) {
  const list = channels.filter((i) => (app.song.channels[i] || []).length);
  if (!list.length || !app.ctx) return { groups: [], dispose() {} };

  const ctx = app.ctx;
  const dest = voiceBus();
  // An equal-gain mix: every part is levelled to its own ceiling by its engine,
  // so they are taken down together to leave the speakers one part's worth.
  const share = 1 / list.length;
  const groups = [];
  const built = [];

  for (const i of list) {
    const gain = ctx.createGain();
    gain.gain.value = share * channelVolume(i);
    gain.connect(dest);
    // Kept by channel, so that channel's knob can move this very gain while it
    // plays.
    const part = { gain, share };
    liveParts.set(i, part);

    const engine = new Engine(ctx, rackFor(i), { out: gain });
    // The rack's own levelling follows what it is playing, so a quiet patch and a
    // loud one both arrive at the mix at the same level. Its sequencers and LFO
    // schedulers are deliberately left stopped: the take holds the notes that
    // were recorded, and a channel playing a pattern of its own on top of them
    // would be a part nobody recorded.
    try {
      engine.startLevelLoop();
    } catch (e) {
      /* the channel still plays, at the drive it started with */
    }

    groups.push({ engine, events: app.song.channels[i] });
    built.push({ i, part, engine, gain });
  }

  return {
    groups,
    dispose() {
      for (const b of built) {
        try {
          b.engine.dispose();
        } catch (e) {
          /* ignore */
        }
        try {
          b.gain.disconnect();
        } catch (e) {
          /* ignore */
        }
        // Only this playback's entry: a later one may already hold the channel.
        if (liveParts.get(b.i) === b.part) liveParts.delete(b.i);
      }
    }
  };
}
