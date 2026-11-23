// Builds a live or offline audio graph from the patch state.

import { DEFS } from './modules.js?v=13';
import { MAX_CHANNEL_VOLUME } from './app.js?v=13';

// The master loudness stage ---------------------------------------------------
//
// A rack's level is not known before it is played: a module's level is 0.3–0.9,
// and the filter, envelope, amplifier and Output each take their share of it
// again, so an ordinary patch arrives at the master bus peaking at a few
// thousandths of full scale, while a big one can arrive at a tenth.
//
// So the stage reads the rack's own level and lifts it to the top: a drive that
// follows the patch's peak until its peaks sit just under full scale, and then
// a soft top that rounds whatever overshoots the measurement. A fixed drive can
// only ever be right for one patch — high enough for the quietest rack worth
// hearing, it pins every other one to a clipped wall, which is heard as a synth
// that is harsh and too loud inside the app while the phone's speaker gains
// nothing: a constant wall of square edges is the one thing a phone's tiny
// speaker and its protection limiter can least reproduce, so it turns it down
// instead of up. Following the level keeps the waveform whole, so the same peaks
// reach the speaker with the body of the sound still in them.
//
// The top is a WaveShaper rather than a DynamicsCompressor: a curve is only a
// table of numbers, so every browser applies it the same way, where a compressor
// leaves its effect to each browser's own implementation — and here it left the
// synth almost inaudible in Safari.
const TARGET_PEAK = 0.9; // where the patch's peaks are put, before the soft top
const DRIVE_MIN = 1;
const DRIVE_MAX = 1200; // the most lift a barely moving rack is ever given
const DRIVE_START = 200; // before a level has been measured: heard, not slammed
const OFFLINE_DRIVE = 800; // an export renders in one go: one fixed drive
// The rack and the lyric take are both near full scale by the time they meet, so
// while a take plays they are taken down to leave room for the two of them.
const LYRIC_HEADROOM = 0.7;
const LEVEL_FLOOR = 0.0002; // below this the patch is quiet, not quietly played
const PEAK_HOLD_RELEASE = 3; // seconds for the held peak to fall by 1/e
const TAU_DOWN = 0.05; // seconds: a hot patch is backed off quickly
const TAU_UP = 0.7; // seconds: a quieter one is lifted slowly, so a crescendo survives
const LEVEL_TICK = 20; // ms between measurements: shorter than the window read
const CURVE_SOFTNESS = 0.35; // how soon it bends: near a plain gain below this
const CURVE_CEILING = 1; // the rounded top it comes to rest at: full scale
const CLIP_STEPS = 4097; // odd, so the middle of the table is exactly 0

// tanh only approaches 1, so the curve is divided by what it reaches at the
// edge of the table: without that, the top of the range sits 0.06 dB short of
// full scale and the drive never quite fills the last decibel.
const CURVE_TOP = Math.tanh(1 / CURVE_SOFTNESS);

function masterCurve() {
  const curve = new Float32Array(CLIP_STEPS);
  for (let i = 0; i < CLIP_STEPS; i++) {
    const x = (i / (CLIP_STEPS - 1)) * 2 - 1;
    curve[i] = (CURVE_CEILING * Math.tanh(x / CURVE_SOFTNESS)) / CURVE_TOP;
  }
  return curve;
}

// One table for every engine, live and offline: it never changes.
const MASTER_CURVE = masterCurve();

// The ceiling: a plain hard clip at full scale, after the volume knob. Nothing
// above full scale can be carried and nothing below it is touched, so this only
// ever catches a sample that slipped past the soft top, and it adds no gain of
// its own — the level was already set where the speaker reads it as loud.
function railCurve() {
  const curve = new Float32Array(CLIP_STEPS);
  for (let i = 0; i < CLIP_STEPS; i++) {
    const x = (i / (CLIP_STEPS - 1)) * 2 - 1;
    curve[i] = Math.max(-1, Math.min(1, x));
  }
  return curve;
}

const MASTER_RAIL = railCurve();

export class Engine {
  constructor(ctx, state, opts = {}) {
    this.ctx = ctx;
    this.state = state;
    this.offline = !!opts.offline;
    this.duration = opts.duration || 60;
    this.bpm = state.bpm || 120;
    this.nodes = new Map();
    this.connections = new Map();
    this.schedulers = [];
    this.noiseCache = new Map();
    this._timer = null;

    // Where the sound leaves the graph: the speakers of the context, or the
    // page's own route into them (see js/output-route.js). The level loop
    // listens to the patch bus and needs a path to here as well, to be run.
    this.out = opts.out || ctx.destination;

    // The patch bus: every module's output and the scope meet here. It stays at
    // a fixed unity gain and is never the volume knob, so the player's volume
    // can sit after the limiter. Fed by the volume instead, the limiter would
    // simply hand the gain back, and the knob would do nothing over most of its
    // travel.
    this.master = ctx.createGain();
    this.master.gain.value = 1;

    // The drive into the soft top: set from the patch's own measured peak, so
    // it turns a patch's few thousandths of full scale into a speaker's worth
    // of level without squashing a patch that was already there.
    this.drive = ctx.createGain();
    this.drive.gain.value = this.offline ? OFFLINE_DRIVE : DRIVE_START;
    this._driveTarget = this.drive.gain.value;
    this._driveMeasured = false;

    // A WaveShaper with the soft-clip curve, not a compressor: what the graph
    // does is fixed by the table, so no browser can quietly turn it down. It is
    // a top rather than a wall — only the peaks the drive lifts past it bend.
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = MASTER_CURVE;
    this.limiter.oversample = '4x';

    // The player's volume: after the limiter, so turning it down is never
    // undone upstream.
    this.volume = ctx.createGain();
    this.volume.gain.value = state.master == null ? 1 : state.master;

    // The ceiling: full scale and no more, so nothing can pass the format even
    // if the knob and a peak line up.
    this.rail = ctx.createWaveShaper();
    this.rail.curve = MASTER_RAIL;
    this.rail.oversample = '4x';

    // Where the lyric channel joins the mix -----------------------------------
    //
    // The voice take is recorded audio, not notes, so it never passes through
    // the drive: that stage exists to lift a quiet patch to full scale, and a
    // voice arriving at it would be pushed far past the soft top and squashed
    // flat. It joins after the rack's own levelling instead, at the volume knob,
    // at the level it was captured at — so the lyrics sit in the mix rather than
    // being reshaped by it, and the player's Vol still governs them both.
    //
    // The rack already rests at its own ceiling there, so while a take plays the
    // rack is taken down by LYRIC_HEADROOM; the two then sum under the rail
    // rather than clipping the loudest syllable against it.
    this.rackGain = ctx.createGain();
    this.rackGain.gain.value = 1;

    // The channel knob the live rack plays under: the level of the channel Rec
    // is set to, so a part is heard while it is recorded at the level it will
    // play back at. It sits after the rack's own levelling and before the
    // player's volume, so a lyric take — which joins at the volume — is left to
    // its own knob instead. A recorded channel's own graph leaves this at 1 and
    // is trimmed as its voice joins the bus.
    this.trim = ctx.createGain();
    this.trim.gain.value = 1;

    // What the level loop keeps between measurements.
    this._levels = null;
    this._levelTimer = null;
    this._levelLast = 0;
    this._levelPeak = 0;

    this.master.connect(this.drive);
    this.drive.connect(this.limiter);
    this.limiter.connect(this.rackGain);
    this.rackGain.connect(this.trim);
    this.trim.connect(this.volume);
    this.volume.connect(this.rail);
    this.rail.connect(this.out);

    for (const mod of state.modules) this.addModule(mod);
    for (const cable of state.cables) this.connectCable(cable);

    // Offline graphs never run a JS scheduler loop: everything is scheduled up
    // front for the whole render. A graph built to play a recorded channel turns
    // this off — the take holds the notes that were recorded, and a sequencer
    // running a pattern of its own would add a part nobody played.
    if (this.offline && opts.schedulers !== false) {
      for (const s of this.schedulers) {
        try {
          s.schedule(0, this.duration);
        } catch (e) {
          console.warn('scheduler failed', e);
        }
      }
    }
  }

  addScheduler(s) {
    this.schedulers.push(s);
  }

  startSchedulers() {
    if (this.offline || this._timer) return;
    this.startLevelLoop();
    const tick = () => {
      const now = this.ctx.currentTime;
      const until = now + 0.25;
      for (const s of this.schedulers) {
        try {
          s.schedule(now, until);
        } catch (e) {
          /* ignore a broken scheduler */
        }
      }
    };
    tick();
    this._timer = setInterval(tick, 80);
  }

  stopSchedulers() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.stopLevelLoop();
  }

  // The level loop: it measures what the patch is putting on the master bus and
  // moves the drive so those peaks land at TARGET_PEAK. It measures before the
  // drive, so it never chases its own gain, and it holds on to the loudest peak
  // for a while — a decaying note must not be lifted again as it falls, or the
  // tail would swell instead of dying away.
  startLevelLoop() {
    if (this.offline || this._levels) return;
    const ctx = this.ctx;
    let analyser;
    let sink;
    let buffer;
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      buffer = new Float32Array(analyser.fftSize);
      // An analyser with no path to the speakers may never run, so it hangs off
      // a silent gain the way the meter's and the visualiser's do.
      sink = ctx.createGain();
      sink.gain.value = 0;
      this.master.connect(analyser);
      analyser.connect(sink);
      sink.connect(this.out);
    } catch (e) {
      this._levels = null;
      return;
    }
    this._levels = { analyser, sink, buffer };
    this._levelLast = 0;
    this._levelPeak = 0;
    const tick = () => this.measureLevel();
    tick();
    this._levelTimer = setInterval(tick, LEVEL_TICK);
  }

  measureLevel() {
    const levels = this._levels;
    if (!levels) return;
    const nowMs = typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
    const dt = this._levelLast ? Math.min(0.5, (nowMs - this._levelLast) / 1000) : 0;
    this._levelLast = nowMs;

    let peak = 0;
    try {
      levels.analyser.getFloatTimeDomainData(levels.buffer);
    } catch (e) {
      return;
    }
    const buffer = levels.buffer;
    for (let i = 0; i < buffer.length; i++) {
      const v = buffer[i] < 0 ? -buffer[i] : buffer[i];
      if (v > peak) peak = v;
    }

    // The held peak rises at once and falls slowly. Silence says nothing about
    // how loud the patch is, so a pause must not run the drive up to full and
    // slam the next note into it.
    if (peak > this._levelPeak) this._levelPeak = peak;
    else this._levelPeak *= Math.exp(-dt / PEAK_HOLD_RELEASE);
    if (this._levelPeak < LEVEL_FLOOR) this._levelPeak = 0;
    if (!this._levelPeak) return;

    const want = Math.max(
      DRIVE_MIN,
      Math.min(DRIVE_MAX, TARGET_PEAK / this._levelPeak)
    );
    if (!isFinite(want)) return;

    // The first measurement jumps straight to the level rather than easing
    // towards it: the first note played on a fresh engine should be heard at the
    // same level as every one after it.
    const tau = want < this._driveTarget ? TAU_DOWN : TAU_UP;
    this._driveTarget = want;
    try {
      if (!this._driveMeasured) this.drive.gain.setValueAtTime(want, this.ctx.currentTime);
      else this.drive.gain.setTargetAtTime(want, this.ctx.currentTime, tau);
    } catch (e) {
      this.drive.gain.value = want;
    }
    this._driveMeasured = true;
  }

  stopLevelLoop() {
    if (this._levelTimer) clearInterval(this._levelTimer);
    this._levelTimer = null;
    const levels = this._levels;
    this._levels = null;
    this._levelPeak = 0;
    this._driveMeasured = false;
    if (!levels) return;
    try {
      this.master.disconnect(levels.analyser);
      levels.analyser.disconnect();
      levels.sink.disconnect();
    } catch (e) {
      /* already gone */
    }
  }

  getNoise(color) {
    if (this.noiseCache.has(color)) return this.noiseCache.get(color);
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (color === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    this.noiseCache.set(color, buf);
    return buf;
  }

  addModule(mod) {
    const def = DEFS[mod.type];
    if (!def) return;
    try {
      const rt = def.create(this, mod);
      this.nodes.set(mod.id, rt);
    } catch (e) {
      console.error('Could not create module', mod.type, e);
    }
  }

  removeModule(id) {
    for (const [cid, conn] of Array.from(this.connections.entries())) {
      if (conn.fromId !== id && conn.toId !== id) continue;
      try {
        conn.src.disconnect(conn.dst);
      } catch (e) {
        /* already gone */
      }
      this.connections.delete(cid);
    }
    const rt = this.nodes.get(id);
    if (!rt) return;
    try {
      if (rt.dispose) rt.dispose();
    } catch (e) {
      /* ignore */
    }
    this.nodes.delete(id);
  }

  connectCable(cable) {
    const a = this.nodes.get(cable.from.id);
    const b = this.nodes.get(cable.to.id);
    if (!a || !b || !a.outputs || !b.inputs) return;
    const src = a.outputs[cable.from.port];
    const dst = b.inputs[cable.to.port];
    if (!src || !dst) return;
    try {
      src.connect(dst);
      this.connections.set(cable.id, {
        src,
        dst,
        fromId: cable.from.id,
        toId: cable.to.id
      });
    } catch (e) {
      console.warn('Patch cable failed', e);
    }
  }

  disconnectCable(cable) {
    const conn = this.connections.get(cable.id);
    if (!conn) return;
    try {
      conn.src.disconnect(conn.dst);
    } catch (e) {
      /* already gone */
    }
    this.connections.delete(cable.id);
  }

  setParam(id, key, value) {
    const rt = this.nodes.get(id);
    if (rt && rt.setParam) {
      try {
        rt.setParam(key, value);
      } catch (e) {
        console.warn('setParam failed', key, e);
      }
    }
  }

  setBpm(v) {
    this.bpm = v;
  }

  setMaster(v) {
    this.state.master = v;
    try {
      this.volume.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    } catch (e) {
      this.volume.gain.value = v;
    }
  }

  // Make room for the lyric take, or give the rack its own level back when the
  // take stops. An offline render has no time to ease across: its graph is set
  // once and rendered, so the gain is simply put where it belongs.
  setLyricHeadroom(on) {
    const target = on ? LYRIC_HEADROOM : 1;
    try {
      if (this.offline) this.rackGain.gain.value = target;
      else this.rackGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    } catch (e) {
      try {
        this.rackGain.gain.value = target;
      } catch (err) {
        /* ignore */
      }
    }
  }

  // The live rack's channel level, moved by the knob of the channel Rec is set
  // to. The lyric take joins after this stage, so it is not touched by it.
  setTrim(v) {
    const n = Number(v);
    const value = Number.isFinite(n) ? Math.max(0, Math.min(MAX_CHANNEL_VOLUME, n)) : 1;
    try {
      this.trim.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    } catch (e) {
      this.trim.gain.value = value;
    }
  }

  noteOn(midi, time, vel = 0.85) {
    for (const rt of this.nodes.values()) {
      if (rt.noteOn) {
        try {
          rt.noteOn(midi, time, vel);
        } catch (e) {
          console.warn('noteOn failed', e);
        }
      }
    }
  }

  noteOff(midi, time) {
    for (const rt of this.nodes.values()) {
      if (rt.noteOff) {
        try {
          rt.noteOff(midi, time);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  allNotesOff(time) {
    const t = time == null ? this.ctx.currentTime : time;
    for (let m = 0; m < 128; m++) this.noteOff(m, t);
  }

  getRuntime(id) {
    return this.nodes.get(id) || null;
  }

  dispose() {
    this.stopSchedulers();
    for (const c of Array.from(this.connections.keys())) {
      const cable = this.state.cables.find((x) => x.id === c);
      if (cable) this.disconnectCable(cable);
    }
    for (const rt of this.nodes.values()) {
      try {
        if (rt.dispose) rt.dispose();
      } catch (e) {
        /* ignore */
      }
    }
    this.nodes.clear();
    try {
      this.master.disconnect();
      this.drive.disconnect();
      this.limiter.disconnect();
      this.rackGain.disconnect();
      this.trim.disconnect();
      this.volume.disconnect();
      this.rail.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
}
