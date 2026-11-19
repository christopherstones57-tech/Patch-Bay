// Builds a live or offline audio graph from the patch state.

import { DEFS } from './modules.js';

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

    this.master = ctx.createGain();
    this.master.gain.value = state.master == null ? 0.8 : state.master;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -4;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 10;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    for (const mod of state.modules) this.addModule(mod);
    for (const cable of state.cables) this.connectCable(cable);

    // Offline graphs never run a JS scheduler loop: everything is scheduled up
    // front for the whole render.
    if (this.offline) {
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
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    } catch (e) {
      this.master.gain.value = v;
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
      this.limiter.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
}
