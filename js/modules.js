// The module library.
//
// Each definition carries what the UI needs (name, colour, parameters, patch
// ports) and a `create(engine, mod)` factory that builds the Web Audio nodes
// for one instance. Factories work in a live AudioContext and in an
// OfflineAudioContext, which is what makes WAV rendering possible.
//
// Convention for control signals (CV): 1.0 means one octave. Pitch inputs
// multiply the incoming signal by 1200 and add it to an oscillator's detune,
// so CV patches stay musical instead of linear in Hz.

export function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function safeTime(t) {
  return t > 0 ? t : 0;
}

// Keep a scheduled frequency inside the audible range: an exponential ramp
// cannot start or end at zero, and anything past the top aliases.
function clampHz(hz) {
  return Math.max(20, Math.min(18000, hz));
}

// Freeze an automation curve at `time` so a release ramp can start from
// wherever the envelope actually is.
function holdAt(param, time) {
  const t = safeTime(time);
  if (typeof param.cancelAndHoldAtTime === 'function') {
    try {
      param.cancelAndHoldAtTime(t);
      return;
    } catch (e) {
      /* fall through */
    }
  }
  try {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
  } catch (e) {
    /* ignore */
  }
}

let TANH = null;
function tanhCurve() {
  if (TANH) return TANH;
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 3.2);
  }
  TANH = c;
  return c;
}

function foldCurve(amount) {
  const n = 2048;
  const c = new Float32Array(n);
  const k = 1 + Math.max(0, Math.min(1, amount)) * 7;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.sin(x * Math.PI * k);
  }
  return c;
}

// A full-wave rectifier: the negative half of the wave is folded up onto the
// positive one, which puts an octave above the input into the signal.
let RECT = null;
function rectCurve() {
  if (RECT) return RECT;
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.abs(x);
  }
  RECT = c;
  return c;
}

// The scales the Turing sequencer picks its notes from, in semitones.
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  penta: [0, 3, 5, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

// One bar of steps for the Trance Gate: 1 opens the gate, 0 closes it.
const TRANCE_PATTERNS = {
  offbeat: [0, 1, 0, 1, 0, 1, 0, 1],
  pulse: [1, 0, 1, 1, 0, 1, 1, 0],
  trance: [1, 1, 0, 1, 1, 0, 1, 0]
};

function impulseBuffer(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * Math.max(0.1, seconds)));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
    }
  }
  return buf;
}

// Wave building -------------------------------------------------------------
//
// Pulse and Wavetable have more shapes than the browser's built-in oscillator
// types, so they are built from Fourier coefficients instead. PeriodicWave is
// band-limited by the browser as the pitch rises, which keeps them clean.

// Harmonic amplitudes (harmonics 1..16) for the Wavetable oscillator.
const WAVETABLES = {
  organ: [1, 0.6, 0.45, 0.3, 0.22, 0.16, 0.12, 0.09, 0.07, 0.05, 0.04, 0.03, 0.02, 0.02, 0.01, 0.01],
  vocal: [1, 0.12, 0.62, 0.08, 0.4, 0.05, 0.22, 0.06, 0.12, 0.04, 0.06, 0.03, 0.04, 0.02, 0.02, 0.01],
  reed: [1, 0.7, 0.55, 0.5, 0.42, 0.38, 0.32, 0.28, 0.24, 0.2, 0.18, 0.16, 0.14, 0.12, 0.1, 0.09],
  glass: [1, 0, 0.5, 0.05, 0, 0.35, 0.1, 0, 0.25, 0.06, 0, 0.16, 0.04, 0, 0.1, 0.02],
  hollow: [1, 0, 0.35, 0, 0.18, 0, 0.11, 0, 0.08, 0, 0.05, 0, 0.04, 0, 0.03, 0]
};

function harmonicWave(ctx, table, bright) {
  const amps = WAVETABLES[table] || WAVETABLES.organ;
  const n = amps.length;
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  // Bright at 1 keeps the table as designed; lower rolls the top end away.
  const tilt = 2 * (1 - Math.max(0, Math.min(1, bright)));
  for (let h = 1; h <= n; h++) {
    imag[h] = (amps[h - 1] || 0) * Math.pow(h, -tilt);
  }
  return ctx.createPeriodicWave(real, imag);
}

// Fourier series of a band-limited pulse wave at a given duty cycle, with its
// DC offset left out so the signal stays centred.
function pulseWave(ctx, width) {
  const duty = Math.max(0.05, Math.min(0.95, width));
  const n = 96;
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  for (let h = 1; h <= n; h++) {
    const a = 2 / (h * Math.PI);
    const k = 2 * Math.PI * h * duty;
    real[h] = a * Math.sin(k);
    imag[h] = a * (1 - Math.cos(k));
  }
  return ctx.createPeriodicWave(real, imag);
}

// An additive tone: the first N harmonics, tilted in level and balanced between
// odd and even, which is where an organ's stops and a bell's ring come from.
// Bright at 3 leaves every harmonic as loud as the first; lower rolls the top
// away.
function additiveWave(ctx, partials, bright, even) {
  const n = Math.max(1, Math.min(32, Math.round(partials)));
  const tilt = Math.max(-3, Math.min(0, bright - 3));
  const ev = Math.max(0, Math.min(1, even));
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  for (let h = 1; h <= n; h++) {
    const balance = h % 2 === 1 ? 1 : ev;
    imag[h] = balance * Math.pow(h, tilt);
  }
  return ctx.createPeriodicWave(real, imag);
}

// A waveform the browser has no oscillator for, worked out from a formula over
// one cycle and turned into harmonics: a PeriodicWave then plays it, band
// limited by the browser as the pitch rises, which keeps it clean.
function shapeWave(ctx, shape, harmonics = 48, samples = 512) {
  const y = new Float32Array(samples);
  for (let i = 0; i < samples; i++) y[i] = shape(i / samples);
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let h = 1; h <= harmonics; h++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < samples; i++) {
      const a = (2 * Math.PI * h * i) / samples;
      re += y[i] * Math.cos(a);
      im += y[i] * Math.sin(a);
    }
    real[h] = (2 * re) / samples;
    imag[h] = (2 * im) / samples;
  }
  return ctx.createPeriodicWave(real, imag);
}

// Hard sync: the slave saw restarts every time the master cycle does, so one
// cycle is a saw at Ratio times the pitch, cut short and restarted. Low ratios
// growl, high ones scream.
function syncWave(ctx, ratio) {
  const r = Math.max(1, Math.min(8, ratio));
  return shapeWave(ctx, (x) => 2 * ((x * r) % 1) - 1);
}

// Formant frequencies (Hz) for the Vox oscillator's vowels.
const VOWELS = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240]
};

const VOWEL_GAINS = [1, 0.7, 0.5];

// Parameter shorthand -------------------------------------------------------

const R = (key, label, min, max, def, step = 0.01, unit = '') => ({
  key, label, type: 'range', min, max, def, step, unit
});
const L = (key, label, min, max, def, unit = '') => ({
  key, label, type: 'logrange', min, max, def, unit
});
const SEL = (key, label, options, def) => ({
  key, label, type: 'select', options, def
});
const TOG = (key, label, def) => ({ key, label, type: 'toggle', def });

export const DEFS = {
  vco: {
    name: 'VCO',
    hue: 205,
    params: [
      SEL('wave', 'Wave', [
        ['sawtooth', 'Saw'],
        ['square', 'Square'],
        ['triangle', 'Tri'],
        ['sine', 'Sine']
      ], 'sawtooth'),
      R('octave', 'Octave', -2, 2, 0, 1),
      R('fine', 'Fine', -100, 100, 0, 1, 'ct'),
      R('level', 'Level', 0, 1, 0.8),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      osc.frequency.value = midiToFreq(60);
      const out = ctx.createGain();
      out.gain.value = p.level;
      osc.connect(out);
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;
      pitchIn.connect(osc.detune);
      osc.detune.value = (p.octave | 0) * 1200 + (p.fine || 0);
      osc.start();

      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'wave') osc.type = p.wave;
          else if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.01);
          else if (key === 'pitchAmt') pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.01);
          else if (key === 'octave' || key === 'fine') {
            osc.detune.setTargetAtTime((p.octave | 0) * 1200 + (p.fine || 0), now, 0.01);
          }
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          osc.frequency.setValueAtTime(midiToFreq(midi), t);
        },
        noteOff() {},
        dispose() {
          try { osc.stop(); } catch (e) {}
          osc.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  harmonic: {
    name: 'Harmonic',
    hue: 215,
    params: [
      R('partials', 'Partials', 1, 32, 8, 1),
      R('bright', 'Bright', 0, 3, 1.8),
      R('even', 'Even', 0, 1, 0.5),
      R('level', 'Level', 0, 1, 0.4),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(additiveWave(ctx, p.partials, p.bright, p.even));
      osc.frequency.value = midiToFreq(60);
      const out = ctx.createGain();
      out.gain.value = p.level;
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;
      pitchIn.connect(osc.detune);
      osc.connect(out);
      osc.start();
      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'partials' || key === 'bright' || key === 'even') {
            osc.setPeriodicWave(additiveWave(ctx, p.partials, p.bright, p.even));
          } else if (key === 'level') {
            out.gain.setTargetAtTime(p.level, now, 0.01);
          } else if (key === 'pitchAmt') {
            pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.01);
          }
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          osc.frequency.setValueAtTime(midiToFreq(midi), t);
        },
        noteOff() {},
        dispose() {
          try { osc.stop(); } catch (e) {}
          osc.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  sync: {
    name: 'Sync',
    hue: 12,
    params: [
      R('ratio', 'Ratio', 1, 8, 2.5, 0.01),
      R('level', 'Level', 0, 1, 0.35),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(syncWave(ctx, p.ratio));
      osc.frequency.value = midiToFreq(60);
      const out = ctx.createGain();
      out.gain.value = p.level;
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;
      pitchIn.connect(osc.detune);
      osc.connect(out);
      osc.start();
      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'ratio') osc.setPeriodicWave(syncWave(ctx, p.ratio));
          else if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.01);
          else if (key === 'pitchAmt') {
            pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.01);
          }
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          osc.frequency.setValueAtTime(midiToFreq(midi), t);
        },
        noteOff() {},
        dispose() {
          try { osc.stop(); } catch (e) {}
          osc.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  metal: {
    name: 'Metal',
    hue: 280,
    params: [
      R('inharm', 'Inharmonic', 0, 1, 0.6),
      L('tone', 'Tone', 300, 16000, 8000, 'hz'),
      R('level', 'Level', 0, 1, 0.28),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      // Five sines: Inharmonic slides each one from the harmonic series into the
      // ratios a struck bar rings at.
      const PARTIALS = [
        { harmonic: 1, bar: 1, gain: 1 },
        { harmonic: 2, bar: 2.76, gain: 0.62 },
        { harmonic: 3, bar: 5.4, gain: 0.45 },
        { harmonic: 4, bar: 8.93, gain: 0.3 },
        { harmonic: 5, bar: 13.34, gain: 0.2 }
      ];
      const out = ctx.createGain();
      out.gain.value = p.level;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = p.tone;
      tone.Q.value = 0.4;
      tone.connect(out);
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;
      let base = midiToFreq(60);

      function ratioOf(part) {
        const k = Math.max(0, Math.min(1, p.inharm));
        return part.harmonic + (part.bar - part.harmonic) * k;
      }

      const oscs = PARTIALS.map((part) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = Math.min(18000, base * ratioOf(part));
        const mix = ctx.createGain();
        mix.gain.value = part.gain;
        osc.connect(mix);
        mix.connect(tone);
        pitchIn.connect(osc.detune);
        osc.start();
        return { osc, mix, part };
      });

      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'inharm') {
            for (const o of oscs) {
              o.osc.frequency.setTargetAtTime(
                Math.min(18000, base * ratioOf(o.part)),
                now,
                0.02
              );
            }
          } else if (key === 'tone') {
            tone.frequency.setTargetAtTime(p.tone, now, 0.02);
          } else if (key === 'level') {
            out.gain.setTargetAtTime(p.level, now, 0.02);
          } else if (key === 'pitchAmt') {
            pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.02);
          }
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          base = midiToFreq(midi);
          for (const o of oscs) {
            o.osc.frequency.setValueAtTime(Math.min(18000, base * ratioOf(o.part)), t);
          }
        },
        noteOff() {},
        dispose() {
          for (const o of oscs) {
            try { o.osc.stop(); } catch (e) {}
            o.osc.disconnect();
            o.mix.disconnect();
          }
          tone.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  chip: {
    name: 'Chip',
    hue: 150,
    params: [
      R('width', 'Width', 0.05, 0.95, 0.5),
      R('sub', 'Sub', 0, 1, 0.4),
      R('level', 'Level', 0, 1, 0.3),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;

      const main = ctx.createOscillator();
      main.setPeriodicWave(pulseWave(ctx, p.width));
      main.frequency.value = midiToFreq(60);
      const mainGain = ctx.createGain();
      mainGain.gain.value = 0.7;
      main.connect(mainGain);
      mainGain.connect(out);
      pitchIn.connect(main.detune);
      main.start();

      // A square an octave down, the way the 8-bit chips did their bass.
      const sub = ctx.createOscillator();
      sub.type = 'square';
      sub.frequency.value = midiToFreq(60);
      sub.detune.value = -1200;
      const subGain = ctx.createGain();
      subGain.gain.value = p.sub * 0.8;
      sub.connect(subGain);
      subGain.connect(out);
      pitchIn.connect(sub.detune);
      sub.start();

      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'width') main.setPeriodicWave(pulseWave(ctx, p.width));
          else if (key === 'sub') subGain.gain.setTargetAtTime(p.sub * 0.8, now, 0.02);
          else if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.02);
          else if (key === 'pitchAmt') {
            pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.02);
          }
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const f = midiToFreq(midi);
          main.frequency.setValueAtTime(f, t);
          sub.frequency.setValueAtTime(f, t);
        },
        noteOff() {},
        dispose() {
          try { main.stop(); sub.stop(); } catch (e) {}
          main.disconnect();
          mainGain.disconnect();
          sub.disconnect();
          subGain.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  noise: {
    name: 'Noise',
    hue: 210,
    params: [
      SEL('color', 'Colour', [['white', 'White'], ['pink', 'Pink']], 'white'),
      R('level', 'Level', 0, 1, 0.4)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;
      let src = null;
      function start() {
        src = ctx.createBufferSource();
        src.buffer = engine.getNoise(p.color);
        src.loop = true;
        src.connect(out);
        src.start();
      }
      start();
      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.01);
          if (key === 'color') {
            try { src.stop(); } catch (e) {}
            src.disconnect();
            start();
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          try { src.stop(); } catch (e) {}
          src.disconnect();
          out.disconnect();
        }
      };
    }
  },

  sampler: {
    name: 'Sampler',
    hue: 38,
    params: [
      R('root', 'Root note', 0, 127, 60, 1),
      R('gain', 'Gain', 0, 1, 0.9),
      R('release', 'Release', 0.01, 2, 0.35, 0.01, 's'),
      TOG('loop', 'Loop sample', false)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.gain;
      const voices = [];

      function noteOn(midi, time, vel = 1) {
        const buffer = mod.data && mod.data.buffer;
        if (!buffer) return;
        const t = Math.max(safeTime(time), ctx.currentTime);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = !!p.loop;
        src.playbackRate.value = Math.pow(2, (midi - p.root) / 12);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(Math.max(0.05, vel), t + 0.004);
        src.connect(g);
        g.connect(out);
        const voice = { src, g, midi };
        src.onended = () => {
          const i = voices.indexOf(voice);
          if (i >= 0) voices.splice(i, 1);
        };
        voices.push(voice);
        src.start(t);
      }

      function noteOff(midi, time) {
        const t = Math.max(safeTime(time), ctx.currentTime);
        const rel = Math.max(0.01, p.release);
        for (const v of voices.slice()) {
          if (v.midi !== midi) continue;
          holdAt(v.g.gain, t);
          v.g.gain.linearRampToValueAtTime(0, t + rel);
          try { v.src.stop(t + rel + 0.08); } catch (e) {}
          const i = voices.indexOf(v);
          if (i >= 0) voices.splice(i, 1);
        }
      }

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'gain') out.gain.setTargetAtTime(p.gain, ctx.currentTime, 0.02);
        },
        noteOn,
        noteOff,
        dispose() {
          for (const v of voices.splice(0)) {
            try { v.src.stop(); } catch (e) {}
            v.src.disconnect();
            v.g.disconnect();
          }
          out.disconnect();
        }
      };
    }
  },

  vcf: {
    name: 'VCF',
    hue: 285,
    params: [
      SEL('type', 'Mode', [
        ['lowpass', 'Low pass'],
        ['highpass', 'High pass'],
        ['bandpass', 'Band pass'],
        ['notch', 'Notch']
      ], 'lowpass'),
      L('cutoff', 'Cutoff', 30, 16000, 900, 'hz'),
      R('res', 'Resonance', 0, 22, 4, 0.1),
      R('cv', 'CV amount', 0, 2, 0.5)
    ],
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'cv', label: 'CV', kind: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const f = ctx.createBiquadFilter();
      f.type = p.type;
      f.frequency.value = p.cutoff;
      f.Q.value = p.res;
      const cv = ctx.createGain();
      cv.gain.value = p.cv * 4800;
      cv.connect(f.detune);
      return {
        inputs: { in: f, cv },
        outputs: { out: f },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'type') f.type = p.type;
          else if (key === 'cutoff') f.frequency.setTargetAtTime(p.cutoff, now, 0.015);
          else if (key === 'res') f.Q.setTargetAtTime(p.res, now, 0.02);
          else if (key === 'cv') cv.gain.setTargetAtTime(p.cv * 4800, now, 0.02);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          f.disconnect();
          cv.disconnect();
        }
      };
    }
  },

  vca: {
    name: 'VCA',
    hue: 265,
    params: [
      R('level', 'Level', 0, 1, 0),
      R('cv', 'CV amount', 0, 2, 1)
    ],
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'cv', label: 'CV', kind: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const g = ctx.createGain();
      g.gain.value = p.level;
      const cv = ctx.createGain();
      cv.gain.value = p.cv;
      cv.connect(g.gain);
      return {
        inputs: { in: g, cv },
        outputs: { out: g },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'level') g.gain.setTargetAtTime(p.level, now, 0.01);
          else if (key === 'cv') cv.gain.setTargetAtTime(p.cv, now, 0.01);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          g.disconnect();
          cv.disconnect();
        }
      };
    }
  },

  adsr: {
    name: 'ADSR',
    hue: 140,
    params: [
      R('attack', 'Attack', 0.001, 4, 0.01, 0.001, 's'),
      R('decay', 'Decay', 0.005, 4, 0.25, 0.005, 's'),
      R('sustain', 'Sustain', 0, 1, 0.6),
      R('release', 'Release', 0.005, 5, 0.4, 0.005, 's'),
      R('amount', 'Amount', 0, 1, 1)
    ],
    inputs: [],
    outputs: [{ id: 'cv', label: 'Env', kind: 'cv' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const cs = ctx.createConstantSource();
      cs.offset.value = 0;
      cs.start();
      const amt = ctx.createGain();
      amt.gain.value = p.amount;
      cs.connect(amt);

      return {
        inputs: {},
        outputs: { cv: amt },
        setParam(key) {
          if (key === 'amount') amt.gain.setTargetAtTime(p.amount, ctx.currentTime, 0.01);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const a = Math.max(0.001, p.attack);
          const d = Math.max(0.001, p.decay);
          const s = Math.max(0, Math.min(1, p.sustain)) * (0.35 + 0.65 * vel);
          holdAt(cs.offset, t);
          cs.offset.linearRampToValueAtTime(1, t + a);
          cs.offset.linearRampToValueAtTime(s, t + a + d);
        },
        noteOff(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const r = Math.max(0.005, p.release);
          holdAt(cs.offset, t);
          cs.offset.linearRampToValueAtTime(0, t + r);
        },
        dispose() {
          try { cs.stop(); } catch (e) {}
          cs.disconnect();
          amt.disconnect();
        }
      };
    }
  },

  lfo: {
    name: 'LFO',
    hue: 175,
    inputs: [],
    outputs: [{ id: 'cv', label: 'CV', kind: 'cv' }],
    params: [
      SEL('shape', 'Shape', [
        ['sine', 'Sine'],
        ['triangle', 'Tri'],
        ['sawtooth', 'Saw'],
        ['square', 'Square']
      ], 'sine'),
      L('rate', 'Rate', 0.05, 25, 2, 'hz'),
      R('depth', 'Depth', 0, 1, 0.25)
    ],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const osc = ctx.createOscillator();
      osc.type = p.shape;
      osc.frequency.value = p.rate;
      const depth = ctx.createGain();
      depth.gain.value = p.depth;
      osc.connect(depth);
      osc.start();
      return {
        inputs: {},
        outputs: { cv: depth },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'shape') osc.type = p.shape;
          else if (key === 'rate') osc.frequency.setTargetAtTime(p.rate, now, 0.02);
          else if (key === 'depth') depth.gain.setTargetAtTime(p.depth, now, 0.02);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          try { osc.stop(); } catch (e) {}
          osc.disconnect();
          depth.disconnect();
        }
      };
    }
  },

  delay: {
    name: 'Delay',
    hue: 225,
    params: [
      L('time', 'Time', 0.01, 1.5, 0.28, 's'),
      R('feedback', 'Feedback', 0, 0.95, 0.35),
      R('mix', 'Mix', 0, 1, 0.3)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const input = ctx.createGain();
      const out = ctx.createGain();
      const delay = ctx.createDelay(2.5);
      delay.delayTime.value = p.time;
      const fb = ctx.createGain();
      fb.gain.value = p.feedback;
      const wet = ctx.createGain();
      wet.gain.value = p.mix;
      const dry = ctx.createGain();
      dry.gain.value = 1 - p.mix * 0.85;

      input.connect(dry);
      dry.connect(out);
      input.connect(delay);
      delay.connect(wet);
      wet.connect(out);
      delay.connect(fb);
      fb.connect(delay);

      return {
        inputs: { in: input },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'time') delay.delayTime.setTargetAtTime(p.time, now, 0.05);
          else if (key === 'feedback') fb.gain.setTargetAtTime(p.feedback, now, 0.02);
          else if (key === 'mix') {
            wet.gain.setTargetAtTime(p.mix, now, 0.02);
            dry.gain.setTargetAtTime(1 - p.mix * 0.85, now, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          input.disconnect();
          delay.disconnect();
          fb.disconnect();
          wet.disconnect();
          dry.disconnect();
          out.disconnect();
        }
      };
    }
  },

  reverb: {
    name: 'Reverb',
    hue: 195,
    params: [
      L('size', 'Size', 0.3, 8, 2.4, 's'),
      R('mix', 'Mix', 0, 1, 0.3)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const input = ctx.createGain();
      const out = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.buffer = impulseBuffer(ctx, p.size);
      const wet = ctx.createGain();
      wet.gain.value = p.mix;
      const dry = ctx.createGain();
      dry.gain.value = 1 - p.mix * 0.8;
      input.connect(dry);
      dry.connect(out);
      input.connect(conv);
      conv.connect(wet);
      wet.connect(out);

      return {
        inputs: { in: input },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'size') {
            conv.buffer = impulseBuffer(ctx, p.size);
          } else if (key === 'mix') {
            wet.gain.setTargetAtTime(p.mix, now, 0.02);
            dry.gain.setTargetAtTime(1 - p.mix * 0.85, now, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          input.disconnect();
          conv.disconnect();
          wet.disconnect();
          dry.disconnect();
          out.disconnect();
        }
      };
    }
  },

  drive: {
    name: 'Drive',
    hue: 15,
    params: [
      R('drive', 'Drive', 1, 40, 6, 0.1),
      L('tone', 'Tone', 400, 16000, 6000, 'hz'),
      R('level', 'Level', 0, 1, 0.7)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const pre = ctx.createGain();
      pre.gain.value = p.drive;
      const shaper = ctx.createWaveShaper();
      shaper.curve = tanhCurve();
      shaper.oversample = '2x';
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = p.tone;
      const post = ctx.createGain();
      post.gain.value = p.level;
      pre.connect(shaper);
      shaper.connect(tone);
      tone.connect(post);
      return {
        inputs: { in: pre },
        outputs: { out: post },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'drive') pre.gain.setTargetAtTime(p.drive, now, 0.02);
          else if (key === 'tone') tone.frequency.setTargetAtTime(p.tone, now, 0.02);
          else if (key === 'level') post.gain.setTargetAtTime(p.level, now, 0.02);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          pre.disconnect();
          shaper.disconnect();
          tone.disconnect();
          post.disconnect();
        }
      };
    }
  },

  ringmod: {
    name: 'Ring Mod',
    hue: 340,
    params: [
      L('freq', 'Carrier', 0.5, 2000, 180, 'hz'),
      R('mix', 'Mix', 0, 1, 0.7)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const input = ctx.createGain();
      const mult = ctx.createGain();
      mult.gain.value = 0;
      input.connect(mult);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = p.freq;
      const depth = ctx.createGain();
      depth.gain.value = 1;
      osc.connect(depth);
      depth.connect(mult.gain);
      osc.start();

      const out = ctx.createGain();
      const wet = ctx.createGain();
      wet.gain.value = p.mix;
      const dry = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      mult.connect(wet);
      wet.connect(out);
      input.connect(dry);
      dry.connect(out);

      return {
        inputs: { in: input },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'freq') osc.frequency.setTargetAtTime(p.freq, now, 0.02);
          else if (key === 'mix') {
            wet.gain.setTargetAtTime(p.mix, now, 0.02);
            dry.gain.setTargetAtTime(1 - p.mix, now, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          try { osc.stop(); } catch (e) {}
          osc.disconnect();
          depth.disconnect();
          input.disconnect();
          mult.disconnect();
          wet.disconnect();
          dry.disconnect();
          out.disconnect();
        }
      };
    }
  },

  folder: {
    name: 'Wavefolder',
    hue: 50,
    params: [
      R('amount', 'Fold', 0, 1, 0.4),
      R('level', 'Level', 0, 1, 0.7)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const shaper = ctx.createWaveShaper();
      shaper.curve = foldCurve(p.amount);
      shaper.oversample = '2x';
      const out = ctx.createGain();
      out.gain.value = p.level;
      shaper.connect(out);
      return {
        inputs: { in: shaper },
        outputs: { out },
        setParam(key) {
          if (key === 'amount') shaper.curve = foldCurve(p.amount);
          else if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          shaper.disconnect();
          out.disconnect();
        }
      };
    }
  },

  chorus: {
    name: 'Chorus',
    hue: 165,
    params: [
      L('rate', 'Rate', 0.05, 8, 0.6, 'hz'),
      R('depth', 'Depth', 0, 1, 0.5),
      R('mix', 'Mix', 0, 1, 0.5)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const input = ctx.createGain();
      const out = ctx.createGain();
      const delay = ctx.createDelay(0.2);
      delay.delayTime.value = 0.022;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = p.rate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = p.depth * 0.008;
      lfo.connect(lfoGain);
      lfoGain.connect(delay.delayTime);
      lfo.start();

      const wet = ctx.createGain();
      wet.gain.value = p.mix;
      const dry = ctx.createGain();
      dry.gain.value = 1 - p.mix * 0.5;
      input.connect(dry);
      dry.connect(out);
      input.connect(delay);
      delay.connect(wet);
      wet.connect(out);

      return {
        inputs: { in: input },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'rate') lfo.frequency.setTargetAtTime(p.rate, now, 0.02);
          else if (key === 'depth') lfoGain.gain.setTargetAtTime(p.depth * 0.008, now, 0.02);
          else if (key === 'mix') {
            wet.gain.setTargetAtTime(p.mix, now, 0.02);
            dry.gain.setTargetAtTime(1 - p.mix * 0.5, now, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          try { lfo.stop(); } catch (e) {}
          lfo.disconnect();
          lfoGain.disconnect();
          input.disconnect();
          delay.disconnect();
          wet.disconnect();
          dry.disconnect();
          out.disconnect();
        }
      };
    }
  },

  mixer: {
    name: 'Mixer',
    hue: 240,
    params: [
      R('l1', 'Ch 1', 0, 1, 0.8),
      R('l2', 'Ch 2', 0, 1, 0.8),
      R('l3', 'Ch 3', 0, 1, 0.8),
      R('l4', 'Ch 4', 0, 1, 0.8),
      R('level', 'Master', 0, 1.5, 1)
    ],
    inputs: [
      { id: 'in1', label: '1', kind: 'audio' },
      { id: 'in2', label: '2', kind: 'audio' },
      { id: 'in3', label: '3', kind: 'audio' },
      { id: 'in4', label: '4', kind: 'audio' }
    ],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;
      const gains = [];
      for (let i = 0; i < 4; i++) {
        const g = ctx.createGain();
        g.gain.value = p['l' + (i + 1)];
        g.connect(out);
        gains.push(g);
      }
      return {
        inputs: { in1: gains[0], in2: gains[1], in3: gains[2], in4: gains[3] },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.01);
          else if (/^l[1-4]$/.test(key)) {
            gains[Number(key[1]) - 1].gain.setTargetAtTime(p[key], now, 0.01);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          gains.forEach((g) => g.disconnect());
          out.disconnect();
        }
      };
    }
  },

  multiple: {
    name: 'Multiple',
    hue: 100,
    params: [],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [
      { id: 'out1', label: '1', kind: 'audio' },
      { id: 'out2', label: '2', kind: 'audio' },
      { id: 'out3', label: '3', kind: 'audio' }
    ],
    create(engine) {
      const ctx = engine.ctx;
      const g = ctx.createGain();
      g.gain.value = 1;
      return {
        inputs: { in: g },
        outputs: { out1: g, out2: g, out3: g },
        setParam() {},
        noteOn() {},
        noteOff() {},
        dispose() {
          g.disconnect();
        }
      };
    }
  },

  atten: {
    name: 'Attenuverter',
    hue: 120,
    params: [R('amount', 'Amount', -1, 1, 0.5)],
    inputs: [{ id: 'cv', label: 'CV', kind: 'cv' }],
    outputs: [{ id: 'cv', label: 'CV', kind: 'cv' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const g = ctx.createGain();
      g.gain.value = p.amount;
      return {
        inputs: { cv: g },
        outputs: { cv: g },
        setParam(key) {
          if (key === 'amount') g.gain.setTargetAtTime(p.amount, ctx.currentTime, 0.01);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          g.disconnect();
        }
      };
    }
  },

  random: {
    name: 'Random',
    hue: 320,
    params: [
      L('rate', 'Rate', 0.1, 20, 2, 'hz'),
      TOG('smooth', 'Smooth', false),
      R('level', 'Level', 0, 1, 0.6)
    ],
    inputs: [],
    outputs: [{ id: 'cv', label: 'CV', kind: 'cv' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const cs = ctx.createConstantSource();
      cs.offset.value = 0;
      cs.start();
      const out = ctx.createGain();
      out.gain.value = p.level;
      cs.connect(out);
      let next = 0;
      engine.addScheduler({
        schedule(from, to) {
          if (next < from) next = from;
          let guard = 0;
          while (next < to && guard++ < 4000) {
            const v = Math.random() * 2 - 1;
            if (p.smooth) cs.offset.setTargetAtTime(v, next, 0.06);
            else cs.offset.setValueAtTime(v, next);
            next += 1 / Math.max(0.05, p.rate);
          }
        }
      });
      return {
        inputs: {},
        outputs: { cv: out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          try { cs.stop(); } catch (e) {}
          cs.disconnect();
          out.disconnect();
        }
      };
    }
  },

  seq: {
    name: 'Sequencer',
    hue: 60,
    params: [
      SEL('rate', 'Rate', [
        ['1/4', '1/4'],
        ['1/8', '1/8'],
        ['1/16', '1/16']
      ], '1/8'),
      R('gate', 'Gate', 0.05, 1, 0.5),
      TOG('run', 'Run', false),
      ...Array.from({ length: 8 }, (_, i) =>
        R('step' + i, 'S' + (i + 1), -24, 24, [0, 0, 7, 12, 7, 3, 0, -5][i], 1)
      )
    ],
    inputs: [],
    outputs: [
      { id: 'pitch', label: 'Pitch', kind: 'cv' },
      { id: 'trig', label: 'Gate', kind: 'cv' }
    ],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const cs = ctx.createConstantSource();
      cs.offset.value = (p.step0 || 0) / 12;
      cs.start();
      const gate = ctx.createConstantSource();
      gate.offset.value = 0;
      gate.start();
      const pitchOut = ctx.createGain();
      pitchOut.gain.value = 1;
      cs.connect(pitchOut);
      const gateOut = ctx.createGain();
      gateOut.gain.value = 1;
      gate.connect(gateOut);

      let next = 0;
      let step = 0;
      const stepDur = () => {
        const beat = 60 / (engine.bpm || 120);
        if (p.rate === '1/4') return beat;
        if (p.rate === '1/16') return beat / 4;
        return beat / 2;
      };

      engine.addScheduler({
        schedule(from, to) {
          if (!p.run) {
            next = 0;
            return;
          }
          if (next < from) next = from;
          let guard = 0;
          while (next < to && guard++ < 4000) {
            const dur = stepDur();
            const semis = p['step' + (step % 8)] || 0;
            cs.offset.setValueAtTime(semis / 12, next);
            gate.offset.setValueAtTime(1, next);
            gate.offset.setValueAtTime(0, next + dur * Math.max(0.05, Math.min(0.95, p.gate)));
            step++;
            next += dur;
          }
        }
      });

      return {
        inputs: {},
        outputs: { pitch: pitchOut, trig: gateOut },
        setParam() {},
        noteOn() {},
        noteOff() {},
        dispose() {
          try { cs.stop(); gate.stop(); } catch (e) {}
          cs.disconnect();
          gate.disconnect();
          pitchOut.disconnect();
          gateOut.disconnect();
        }
      };
    }
  },

  scope: {
    name: 'Scope',
    hue: 190,
    params: [],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [],
    create(engine) {
      const ctx = engine.ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.5;
      const mute = ctx.createGain();
      mute.gain.value = 0;
      an.connect(mute);
      mute.connect(engine.master);
      return {
        inputs: { in: an },
        outputs: {},
        analyser: an,
        setParam() {},
        noteOn() {},
        noteOff() {},
        dispose() {
          an.disconnect();
          mute.disconnect();
        }
      };
    }
  },

  comp: {
    name: 'Compressor',
    hue: 255,
    params: [
      R('threshold', 'Thresh', -60, 0, -18, 1, 'dB'),
      R('ratio', 'Ratio', 1, 20, 4, 0.5)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = p.threshold;
      c.ratio.value = p.ratio;
      c.attack.value = 0.004;
      c.release.value = 0.2;
      return {
        inputs: { in: c },
        outputs: { out: c },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'threshold') c.threshold.setTargetAtTime(p.threshold, now, 0.02);
          else if (key === 'ratio') c.ratio.setTargetAtTime(p.ratio, now, 0.02);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          c.disconnect();
        }
      };
    }
  },

  supersaw: {
    name: 'Super Saw',
    hue: 200,
    params: [
      R('voices', 'Voices', 1, 7, 5, 1),
      R('detune', 'Detune', 0, 1, 0.45),
      R('level', 'Level', 0, 1, 0.7),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;
      const oscs = [];
      const gains = [];
      for (let i = 0; i < 7; i++) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = midiToFreq(60);
        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g);
        g.connect(out);
        pitchIn.connect(osc.detune);
        osc.start();
        oscs.push(osc);
        gains.push(g);
      }

      const layout = () => {
        const n = Math.max(1, Math.min(7, Math.round(p.voices)));
        const center = (n - 1) / 2;
        for (let i = 0; i < 7; i++) {
          const on = i < n;
          const spread = (i - center) * 22 * p.detune;
          gains[i].gain.setTargetAtTime(on ? 0.9 / Math.sqrt(n) : 0, ctx.currentTime, 0.02);
          oscs[i].detune.setTargetAtTime(spread, ctx.currentTime, 0.02);
        }
      };
      layout();

      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.02);
          else if (key === 'pitchAmt') pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.02);
          else layout();
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const hz = midiToFreq(midi);
          for (const osc of oscs) osc.frequency.setValueAtTime(hz, t);
        },
        noteOff() {},
        dispose() {
          for (const osc of oscs) {
            try { osc.stop(); } catch (e) {}
            osc.disconnect();
          }
          for (const g of gains) g.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  fmosc: {
    name: 'FM Osc',
    hue: 215,
    params: [
      SEL('wave', 'Carrier', [
        ['sine', 'Sine'],
        ['triangle', 'Tri'],
        ['sawtooth', 'Saw'],
        ['square', 'Square']
      ], 'sine'),
      R('ratio', 'Ratio', 0.25, 8, 2, 0.25),
      R('index', 'Index', 0, 12, 3, 0.1),
      R('level', 'Level', 0, 1, 0.7),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      let base = midiToFreq(60);

      const carrier = ctx.createOscillator();
      carrier.type = p.wave;
      carrier.frequency.value = base;
      const modOsc = ctx.createOscillator();
      modOsc.type = 'sine';
      modOsc.frequency.value = base * p.ratio;
      const modGain = ctx.createGain();
      modGain.gain.value = base * p.index;
      modOsc.connect(modGain);
      modGain.connect(carrier.frequency);

      const out = ctx.createGain();
      out.gain.value = p.level;
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;
      pitchIn.connect(carrier.detune);
      carrier.connect(out);
      carrier.start();
      modOsc.start();

      const retune = (t) => {
        carrier.frequency.setValueAtTime(base, t);
        modOsc.frequency.setTargetAtTime(base * p.ratio, t, 0.02);
        modGain.gain.setTargetAtTime(base * p.index, t, 0.02);
      };

      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'wave') carrier.type = p.wave;
          else if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.02);
          else if (key === 'pitchAmt') pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.02);
          else retune(now);
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          base = midiToFreq(midi);
          retune(t);
        },
        noteOff() {},
        dispose() {
          try {
            carrier.stop();
            modOsc.stop();
          } catch (e) {
            /* ignore */
          }
          carrier.disconnect();
          modOsc.disconnect();
          modGain.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  pulse: {
    name: 'Pulse',
    hue: 55,
    params: [
      R('width', 'Width', 0.05, 0.95, 0.5),
      R('octave', 'Octave', -2, 2, 0, 1),
      R('fine', 'Fine', -100, 100, 0, 1, 'ct'),
      R('level', 'Level', 0, 1, 0.8),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const osc = ctx.createOscillator();
      osc.frequency.value = midiToFreq(60);
      osc.setPeriodicWave(pulseWave(ctx, p.width));
      const out = ctx.createGain();
      out.gain.value = p.level;
      osc.connect(out);
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;
      pitchIn.connect(osc.detune);
      const tuning = () => (p.octave | 0) * 1200 + (p.fine || 0);
      osc.detune.value = tuning();
      osc.start();

      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'width') osc.setPeriodicWave(pulseWave(ctx, p.width));
          else if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.02);
          else if (key === 'pitchAmt') pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.02);
          else if (key === 'octave' || key === 'fine') {
            osc.detune.setTargetAtTime(tuning(), now, 0.02);
          }
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          osc.frequency.setValueAtTime(midiToFreq(midi), t);
        },
        noteOff() {},
        dispose() {
          try { osc.stop(); } catch (e) {}
          osc.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  wavetable: {
    name: 'Wavetable',
    hue: 188,
    params: [
      SEL('table', 'Table', [
        ['organ', 'Organ'],
        ['vocal', 'Vocal'],
        ['reed', 'Reed'],
        ['glass', 'Glass'],
        ['hollow', 'Hollow']
      ], 'organ'),
      R('bright', 'Bright', 0, 1, 0.7),
      R('level', 'Level', 0, 1, 0.7),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const osc = ctx.createOscillator();
      osc.frequency.value = midiToFreq(60);
      osc.setPeriodicWave(harmonicWave(ctx, p.table, p.bright));
      const out = ctx.createGain();
      out.gain.value = p.level;
      osc.connect(out);
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;
      pitchIn.connect(osc.detune);
      osc.start();

      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'table' || key === 'bright') {
            osc.setPeriodicWave(harmonicWave(ctx, p.table, p.bright));
          } else if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.02);
          else if (key === 'pitchAmt') pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.02);
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          osc.frequency.setValueAtTime(midiToFreq(midi), t);
        },
        noteOff() {},
        dispose() {
          try { osc.stop(); } catch (e) {}
          osc.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  vox: {
    name: 'Vox',
    hue: 320,
    params: [
      SEL('vowel', 'Vowel', [
        ['a', 'A'],
        ['e', 'E'],
        ['i', 'I'],
        ['o', 'O'],
        ['u', 'U']
      ], 'a'),
      R('shift', 'Shift', -12, 12, 0, 1, 'st'),
      R('focus', 'Focus', 1, 24, 8, 0.5),
      R('breath', 'Breath', 0, 1, 0.15),
      R('level', 'Level', 0, 1, 0.9),
      R('pitchAmt', 'Pitch CV', 0, 2, 1)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToFreq(60);

      const src = ctx.createGain();
      src.gain.value = 1;
      osc.connect(src);

      // A breath of noise through the same formants gives the vowels air.
      const noise = ctx.createBufferSource();
      noise.buffer = engine.getNoise('white');
      noise.loop = true;
      const breath = ctx.createGain();
      breath.gain.value = p.breath * 0.5;
      noise.connect(breath);
      breath.connect(src);

      const mix = ctx.createGain();
      mix.gain.value = 2;
      const forms = [];
      const amps = [];
      for (let i = 0; i < 3; i++) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = p.focus;
        const amp = ctx.createGain();
        amp.gain.value = VOWEL_GAINS[i];
        src.connect(bp);
        bp.connect(amp);
        amp.connect(mix);
        forms.push(bp);
        amps.push(amp);
      }

      const out = ctx.createGain();
      out.gain.value = p.level;
      mix.connect(out);

      // A touch of the raw saw keeps the note's pitch solid under the formants.
      const body = ctx.createGain();
      body.gain.value = 0.15;
      src.connect(body);
      body.connect(out);

      const pitchIn = ctx.createGain();
      pitchIn.gain.value = p.pitchAmt * 1200;
      pitchIn.connect(osc.detune);

      const place = () => {
        const vowel = VOWELS[p.vowel] || VOWELS.a;
        const shift = Math.pow(2, (p.shift || 0) / 12);
        for (let i = 0; i < forms.length; i++) {
          forms[i].frequency.setTargetAtTime(vowel[i] * shift, ctx.currentTime, 0.03);
          forms[i].Q.setTargetAtTime(p.focus, ctx.currentTime, 0.03);
        }
      };
      place();

      osc.start();
      noise.start();

      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'vowel' || key === 'shift' || key === 'focus') place();
          else if (key === 'breath') breath.gain.setTargetAtTime(p.breath * 0.5, now, 0.02);
          else if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.02);
          else if (key === 'pitchAmt') pitchIn.gain.setTargetAtTime(p.pitchAmt * 1200, now, 0.02);
        },
        noteOn(midi, time) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          osc.frequency.setValueAtTime(midiToFreq(midi), t);
        },
        noteOff() {},
        dispose() {
          try {
            osc.stop();
            noise.stop();
          } catch (e) {
            /* ignore */
          }
          osc.disconnect();
          noise.disconnect();
          breath.disconnect();
          src.disconnect();
          mix.disconnect();
          body.disconnect();
          for (const bp of forms) bp.disconnect();
          for (const a of amps) a.disconnect();
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  comb: {
    name: 'Comb',
    hue: 280,
    params: [
      L('tune', 'Tune', 40, 2000, 220, 'hz'),
      R('feedback', 'Feedback', 0, 0.95, 0.7),
      R('mix', 'Mix', 0, 1, 0.6)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const input = ctx.createGain();
      const out = ctx.createGain();
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = Math.min(0.1, 1 / p.tune);
      const fb = ctx.createGain();
      fb.gain.value = p.feedback;
      const wet = ctx.createGain();
      wet.gain.value = p.mix;
      const dry = ctx.createGain();
      dry.gain.value = 1 - p.mix * 0.7;
      input.connect(dry);
      dry.connect(out);
      input.connect(delay);
      delay.connect(wet);
      wet.connect(out);
      delay.connect(fb);
      fb.connect(delay);

      return {
        inputs: { in: input },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'tune') delay.delayTime.setTargetAtTime(Math.min(0.1, 1 / p.tune), now, 0.02);
          else if (key === 'feedback') fb.gain.setTargetAtTime(p.feedback, now, 0.02);
          else if (key === 'mix') {
            wet.gain.setTargetAtTime(p.mix, now, 0.02);
            dry.gain.setTargetAtTime(1 - p.mix * 0.7, now, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          input.disconnect();
          delay.disconnect();
          fb.disconnect();
          wet.disconnect();
          dry.disconnect();
          out.disconnect();
        }
      };
    }
  },

  phaser: {
    name: 'Phaser',
    hue: 170,
    params: [
      L('rate', 'Rate', 0.05, 5, 0.4, 'hz'),
      R('depth', 'Depth', 0, 1, 0.7),
      L('center', 'Center', 200, 3000, 700, 'hz'),
      R('mix', 'Mix', 0, 1, 0.5)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const input = ctx.createGain();
      const out = ctx.createGain();
      const stages = [];
      let node = input;
      for (let i = 0; i < 4; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = 'allpass';
        ap.frequency.value = p.center;
        ap.Q.value = 0.6;
        node.connect(ap);
        node = ap;
        stages.push(ap);
      }
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = p.rate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = p.depth * p.center;
      lfo.connect(lfoGain);
      for (const ap of stages) lfoGain.connect(ap.frequency);
      lfo.start();

      const wet = ctx.createGain();
      wet.gain.value = p.mix;
      const dry = ctx.createGain();
      dry.gain.value = 1 - p.mix * 0.5;
      node.connect(wet);
      wet.connect(out);
      input.connect(dry);
      dry.connect(out);

      return {
        inputs: { in: input },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'rate') lfo.frequency.setTargetAtTime(p.rate, now, 0.02);
          else if (key === 'center' || key === 'depth') {
            for (const ap of stages) ap.frequency.setTargetAtTime(p.center, now, 0.02);
            lfoGain.gain.setTargetAtTime(p.depth * p.center, now, 0.02);
          } else if (key === 'mix') {
            wet.gain.setTargetAtTime(p.mix, now, 0.02);
            dry.gain.setTargetAtTime(1 - p.mix * 0.5, now, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          try { lfo.stop(); } catch (e) {}
          lfo.disconnect();
          lfoGain.disconnect();
          for (const ap of stages) ap.disconnect();
          input.disconnect();
          wet.disconnect();
          dry.disconnect();
          out.disconnect();
        }
      };
    }
  },

  eq: {
    name: 'EQ',
    hue: 45,
    params: [
      R('low', 'Low', -18, 18, 0, 1, 'dB'),
      R('mid', 'Mid', -18, 18, 0, 1, 'dB'),
      R('high', 'High', -18, 18, 0, 1, 'dB')
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const low = ctx.createBiquadFilter();
      low.type = 'lowshelf';
      low.frequency.value = 240;
      low.gain.value = p.low;
      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = 1200;
      mid.Q.value = 1;
      mid.gain.value = p.mid;
      const high = ctx.createBiquadFilter();
      high.type = 'highshelf';
      high.frequency.value = 3600;
      high.gain.value = p.high;
      low.connect(mid);
      mid.connect(high);

      return {
        inputs: { in: low },
        outputs: { out: high },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'low') low.gain.setTargetAtTime(p.low, now, 0.02);
          else if (key === 'mid') mid.gain.setTargetAtTime(p.mid, now, 0.02);
          else if (key === 'high') high.gain.setTargetAtTime(p.high, now, 0.02);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          low.disconnect();
          mid.disconnect();
          high.disconnect();
        }
      };
    }
  },

  crusher: {
    name: 'Crusher',
    hue: 350,
    params: [
      R('bits', 'Bits', 2, 16, 6, 1),
      L('tone', 'Tone', 500, 16000, 8000, 'hz'),
      R('level', 'Level', 0, 1, 0.7)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const curveFor = (bits) => {
        const n = 2048;
        const c = new Float32Array(n);
        const steps = Math.pow(2, Math.max(1, Math.round(bits))) - 1;
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * 2 - 1;
          c[i] = Math.round(x * steps) / steps;
        }
        return c;
      };
      const shaper = ctx.createWaveShaper();
      shaper.curve = curveFor(p.bits);
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = p.tone;
      const out = ctx.createGain();
      out.gain.value = p.level;
      shaper.connect(tone);
      tone.connect(out);

      return {
        inputs: { in: shaper },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'bits') shaper.curve = curveFor(p.bits);
          else if (key === 'tone') tone.frequency.setTargetAtTime(p.tone, now, 0.02);
          else if (key === 'level') out.gain.setTargetAtTime(p.level, now, 0.02);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          shaper.disconnect();
          tone.disconnect();
          out.disconnect();
        }
      };
    }
  },

  slew: {
    name: 'Slew',
    hue: 130,
    params: [L('time', 'Lag', 0.003, 2, 0.15, 's')],
    inputs: [{ id: 'cv', label: 'CV', kind: 'cv' }],
    outputs: [{ id: 'cv', label: 'CV', kind: 'cv' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 0.5;
      const cutoff = () => Math.min(20000, Math.max(0.1, 1 / (2 * Math.PI * Math.max(0.001, p.time))));
      f.frequency.value = cutoff();
      return {
        inputs: { cv: f },
        outputs: { cv: f },
        setParam(key) {
          if (key === 'time') f.frequency.setTargetAtTime(cutoff(), ctx.currentTime, 0.02);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          f.disconnect();
        }
      };
    }
  },

  transpose: {
    name: 'Transpose',
    hue: 90,
    params: [R('semitones', 'Semitones', -24, 24, 0, 1)],
    inputs: [{ id: 'cv', label: 'CV', kind: 'cv' }],
    outputs: [{ id: 'cv', label: 'CV', kind: 'cv' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = 1;
      const thru = ctx.createGain();
      thru.gain.value = 1;
      thru.connect(out);
      const offset = ctx.createConstantSource();
      offset.offset.value = p.semitones / 12;
      offset.connect(out);
      offset.start();
      return {
        inputs: { cv: thru },
        outputs: { cv: out },
        setParam(key) {
          if (key === 'semitones') {
            offset.offset.setTargetAtTime(p.semitones / 12, ctx.currentTime, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          try { offset.stop(); } catch (e) {}
          thru.disconnect();
          offset.disconnect();
          out.disconnect();
        }
      };
    }
  },

  cvmix: {
    name: 'CV Mixer',
    hue: 230,
    params: [
      R('l1', '1', -1, 1, 0.5),
      R('l2', '2', -1, 1, 0.5),
      R('l3', '3', -1, 1, 0.5)
    ],
    inputs: [
      { id: 'in1', label: '1', kind: 'cv' },
      { id: 'in2', label: '2', kind: 'cv' },
      { id: 'in3', label: '3', kind: 'cv' }
    ],
    outputs: [{ id: 'cv', label: 'CV', kind: 'cv' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = 1;
      const gains = [];
      for (let i = 0; i < 3; i++) {
        const g = ctx.createGain();
        g.gain.value = p['l' + (i + 1)];
        g.connect(out);
        gains.push(g);
      }
      return {
        inputs: { in1: gains[0], in2: gains[1], in3: gains[2] },
        outputs: { cv: out },
        setParam(key) {
          if (/^l[1-3]$/.test(key)) {
            gains[Number(key[1]) - 1].gain.setTargetAtTime(p[key], ctx.currentTime, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          for (const g of gains) g.disconnect();
          out.disconnect();
        }
      };
    }
  },

  clock: {
    name: 'Clock',
    hue: 55,
    params: [
      SEL('rate', 'Rate', [
        ['1/4', '1/4'],
        ['1/8', '1/8'],
        ['1/16', '1/16']
      ], '1/8'),
      R('width', 'Width', 0.05, 1, 0.5),
      TOG('run', 'Run', true)
    ],
    inputs: [],
    outputs: [{ id: 'gate', label: 'Gate', kind: 'cv' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const gate = ctx.createConstantSource();
      gate.offset.value = 0;
      gate.start();
      const out = ctx.createGain();
      out.gain.value = 1;
      gate.connect(out);

      let next = 0;
      const stepDur = () => {
        const beat = 60 / (engine.bpm || 120);
        if (p.rate === '1/4') return beat;
        if (p.rate === '1/16') return beat / 4;
        return beat / 2;
      };

      engine.addScheduler({
        schedule(from, to) {
          if (!p.run) {
            next = 0;
            return;
          }
          if (next < from) next = from;
          let guard = 0;
          while (next < to && guard++ < 4000) {
            const dur = stepDur();
            gate.offset.setValueAtTime(1, next);
            gate.offset.setValueAtTime(0, next + dur * Math.max(0.05, Math.min(0.95, p.width)));
            next += dur;
          }
        }
      });

      return {
        inputs: {},
        outputs: { gate: out },
        setParam() {},
        noteOn() {},
        noteOff() {},
        dispose() {
          try { gate.stop(); } catch (e) {}
          gate.disconnect();
          out.disconnect();
        }
      };
    }
  },

  drum: {
    name: 'Drum',
    hue: 25,
    params: [
      SEL('type', 'Type', [
        ['kick', 'Kick'],
        ['snare', 'Snare'],
        ['hat', 'Hat']
      ], 'kick'),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('decay', 'Decay', 0.05, 1.5, 0.35, 0.01, 's'),
      R('tone', 'Tone', 0, 1, 0.7),
      R('level', 'Level', 0, 1, 0.9)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      const playKick = (t, vel) => {
        const len = Math.max(0.08, p.decay);
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        const f0 = 160 * Math.pow(2, p.tune / 12);
        const f1 = 48 * Math.pow(2, p.tune / 12);
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(f1, t + Math.min(len, 0.4));
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vel, t + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        osc.connect(g);
        g.connect(out);
        osc.start(t);
        osc.stop(t + len + 0.05);
        osc.onended = () => {
          try {
            osc.disconnect();
            g.disconnect();
          } catch (e) {
            /* ignore */
          }
        };
      };

      const playNoise = (t, vel, kind, decay) => {
        const src = ctx.createBufferSource();
        src.buffer = engine.getNoise('white');
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        if (kind === 'hat') {
          filter.type = 'highpass';
          filter.frequency.value = 4000 + p.tone * 6000;
          filter.Q.value = 0.7;
        } else {
          filter.type = 'bandpass';
          filter.frequency.value = 1200 + p.tone * 3200;
          filter.Q.value = 0.8;
        }
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vel, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        src.connect(filter);
        filter.connect(g);
        g.connect(out);
        src.start(t);
        src.stop(t + decay + 0.05);
        src.onended = () => {
          try {
            src.disconnect();
            filter.disconnect();
            g.disconnect();
          } catch (e) {
            /* ignore */
          }
        };
      };

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          if (p.type === 'hat') playNoise(t, vel * 0.7, 'hat', Math.max(0.03, Math.min(0.3, p.decay * 0.4)));
          else if (p.type === 'snare') {
            playNoise(t, vel * 0.9, 'snare', Math.max(0.06, p.decay * 0.8));
            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = 190 * Math.pow(2, p.tune / 12);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(vel * 0.55, t + 0.002);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
            osc.connect(g);
            g.connect(out);
            osc.start(t);
            osc.stop(t + 0.2);
            osc.onended = () => {
              try {
                osc.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          } else {
            playKick(t, vel);
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  zap: {
    name: 'Zap',
    hue: 295,
    params: [
      SEL('wave', 'Wave', [
        ['square', 'Square'],
        ['sawtooth', 'Saw'],
        ['triangle', 'Tri'],
        ['sine', 'Sine']
      ], 'square'),
      R('start', 'Start', 0, 48, 24, 1, 'st'),
      R('drop', 'Drop', 6, 72, 48, 1, 'st'),
      R('time', 'Time', 0.03, 1.2, 0.22, 0.01, 's'),
      R('level', 'Level', 0, 1, 0.7)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.03, p.time);
          // Start above the played note, then fall by Drop semitones.
          const f0 = clampHz(midiToFreq(midi) * Math.pow(2, (p.start || 0) / 12));
          const f1 = clampHz(f0 * Math.pow(2, -(p.drop || 0) / 12));
          const amp = Math.max(0.02, vel) * 0.8;

          const osc = ctx.createOscillator();
          osc.type = p.wave;
          osc.frequency.setValueAtTime(f0, t);
          osc.frequency.exponentialRampToValueAtTime(f1, t + len * 0.9);

          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);

          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + len + 0.05);
          osc.onended = () => {
            try {
              osc.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  riser: {
    name: 'Riser',
    hue: 45,
    params: [
      L('time', 'Time', 0.2, 8, 1.8, 's'),
      L('from', 'From', 80, 6000, 300, 'hz'),
      L('to', 'To', 200, 12000, 6000, 'hz'),
      R('q', 'Q', 1, 20, 4, 0.5),
      SEL('color', 'Noise', [
        ['white', 'White'],
        ['pink', 'Pink']
      ], 'white'),
      R('level', 'Level', 0, 1, 0.7)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.15, p.time);
          // A narrow band passes little of the noise, so a high Q needs more
          // gain to stay as loud as a wide one.
          const amp = Math.max(0.02, vel) * 1.2 * Math.sqrt(Math.max(1, p.q));

          const src = ctx.createBufferSource();
          src.buffer = engine.getNoise(p.color);
          src.loop = true;

          // A band of noise sweeps between From and To; Q sets how focused
          // the whistle is.
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.Q.value = p.q;
          bp.frequency.setValueAtTime(clampHz(p.from), t);
          bp.frequency.exponentialRampToValueAtTime(clampHz(p.to), t + len);

          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(amp, t + Math.max(0.05, len * 0.35));
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);

          src.connect(bp);
          bp.connect(g);
          g.connect(out);
          src.start(t);
          src.stop(t + len + 0.05);
          src.onended = () => {
            try {
              src.disconnect();
              bp.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  clang: {
    name: 'Clang',
    hue: 185,
    params: [
      R('metal', 'Metal', 0, 1, 0.8),
      R('strike', 'Strike', 0, 1, 0.4),
      R('decay', 'Decay', 0.1, 4, 1.2, 0.01, 's'),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.6)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;
      // Bell-like partials; Metal blends them from a harmonic stack to these.
      const RATIOS = [1, 2.76, 5.4, 8.93, 13.34];

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const base = clampHz(midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12));
          const metal = Math.max(0, Math.min(1, p.metal));
          const len = Math.max(0.12, p.decay);
          const amp = Math.max(0.02, vel) * 0.28;

          for (let i = 0; i < RATIOS.length; i++) {
            const ratio = i + 1 + (RATIOS[i] - (i + 1)) * metal;
            const f = base * ratio;
            if (f > 16000) continue;
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t);
            // Higher partials ring shorter, as they do on struck metal.
            const plen = len * Math.pow(0.7, i);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(amp * Math.pow(0.72, i), t + 0.003);
            g.gain.exponentialRampToValueAtTime(0.0001, t + plen);
            osc.connect(g);
            g.connect(out);
            osc.start(t);
            osc.stop(t + plen + 0.05);
            osc.onended = () => {
              try {
                osc.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }

          if (p.strike > 0.01) {
            const nlen = 0.04 + 0.12 * Math.min(1, p.strike);
            const src = ctx.createBufferSource();
            src.buffer = engine.getNoise('white');
            src.loop = true;
            const hp = ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 2500;
            hp.Q.value = 0.7;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(amp * 0.7 * p.strike, t + 0.002);
            g.gain.exponentialRampToValueAtTime(0.0001, t + nlen);
            src.connect(hp);
            hp.connect(g);
            g.connect(out);
            src.start(t);
            src.stop(t + nlen + 0.05);
            src.onended = () => {
              try {
                src.disconnect();
                hp.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  boom: {
    name: 'Boom',
    hue: 8,
    params: [
      L('decay', 'Decay', 0.15, 5, 1.2, 's'),
      R('tone', 'Tone', 0, 1, 0.45),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.8)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.15, p.decay);
          const amp = Math.max(0.02, vel) * 0.8;
          const ratio = Math.pow(2, (p.tune || 0) / 12);

          // Low thump that drops in pitch as the hit lands.
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(clampHz(180 * ratio), t);
          osc.frequency.exponentialRampToValueAtTime(clampHz(45 * ratio), t + Math.min(0.5, len * 0.6));
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);
          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + len + 0.05);
          osc.onended = () => {
            try {
              osc.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };

          // Noise body, with the filter closing down as it decays.
          const nlen = len * 0.8;
          const src = ctx.createBufferSource();
          src.buffer = engine.getNoise('white');
          src.loop = true;
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.Q.value = 0.8;
          lp.frequency.setValueAtTime(clampHz(400 + 4000 * p.tone), t);
          lp.frequency.exponentialRampToValueAtTime(clampHz(120), t + nlen);
          const ng = ctx.createGain();
          ng.gain.setValueAtTime(0.0001, t);
          ng.gain.linearRampToValueAtTime(amp * 0.55, t + 0.004);
          ng.gain.exponentialRampToValueAtTime(0.0001, t + nlen);
          src.connect(lp);
          lp.connect(ng);
          ng.connect(out);
          src.start(t);
          src.stop(t + nlen + 0.05);
          src.onended = () => {
            try {
              src.disconnect();
              lp.disconnect();
              ng.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  blip: {
    name: 'Blip',
    hue: 62,
    params: [
      SEL('wave', 'Wave', [
        ['square', 'Square'],
        ['sawtooth', 'Saw'],
        ['triangle', 'Tri'],
        ['sine', 'Sine']
      ], 'square'),
      R('step', 'Step', 0, 36, 12, 1, 'st'),
      R('time', 'Time', 0.04, 0.6, 0.12, 0.01, 's'),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.6)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      const beep = (at, freq, dur, amp) => {
        const osc = ctx.createOscillator();
        osc.type = p.wave;
        osc.frequency.setValueAtTime(clampHz(freq), at);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.linearRampToValueAtTime(amp, at + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(g);
        g.connect(out);
        osc.start(at);
        osc.stop(at + dur + 0.03);
        osc.onended = () => {
          try {
            osc.disconnect();
            g.disconnect();
          } catch (e) {
            /* ignore */
          }
        };
      };

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.04, p.time);
          const base = midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12);
          const amp = Math.max(0.02, vel) * 0.45;
          // Two steps up, the way an arcade coin sounds.
          beep(t, base, len * 0.55, amp);
          beep(t + len * 0.45, base * Math.pow(2, (p.step || 0) / 12), len, amp * 0.9);
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  ping: {
    name: 'Ping',
    hue: 200,
    params: [
      L('decay', 'Decay', 0.15, 6, 1.4, 's'),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('shimmer', 'Shimmer', 0, 1, 0.35),
      R('level', 'Level', 0, 1, 0.55)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;
      // A pure tone plus two high, slightly stretched partials: a sonar ping.
      const RATIOS = [1, 2.02, 3.06];

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const base = midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12);
          const len = Math.max(0.15, p.decay);
          const amp = Math.max(0.02, vel) * 0.4;
          const shimmer = Math.max(0, Math.min(1, p.shimmer));

          for (let i = 0; i < RATIOS.length; i++) {
            const f = base * RATIOS[i];
            // Higher partials ring shorter and quieter, as they do on a ping.
            const pgain = i === 0 ? amp : amp * shimmer * Math.pow(0.55, i);
            if (f > 16000 || pgain < 0.001) continue;
            const plen = len * Math.pow(0.8, i);
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(pgain, t + 0.004);
            g.gain.exponentialRampToValueAtTime(0.0001, t + plen);
            osc.connect(g);
            g.connect(out);
            osc.start(t);
            osc.stop(t + plen + 0.05);
            osc.onended = () => {
              try {
                osc.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  siren: {
    name: 'Siren',
    hue: 352,
    params: [
      R('rate', 'Rate', 0.2, 12, 1.6, 0.1, 'hz'),
      R('depth', 'Depth', 0, 24, 7, 0.5, 'st'),
      L('time', 'Time', 0.2, 8, 2.5, 's'),
      R('tone', 'Tone', 0, 1, 0.5),
      R('level', 'Level', 0, 1, 0.5)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.2, p.time);
          const base = clampHz(midiToFreq(midi));
          const amp = Math.max(0.02, vel) * 0.28;

          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(base, t);

          // The pitch wails up and down while the note sounds.
          const lfo = ctx.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.setValueAtTime(Math.max(0.2, p.rate), t);
          const lfoGain = ctx.createGain();
          lfoGain.gain.value = Math.max(0, p.depth) * 100;
          lfo.connect(lfoGain);
          lfoGain.connect(osc.detune);

          // A lowpass closes as it decays, so it thins out as it fades.
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.Q.value = 1.2;
          lp.frequency.setValueAtTime(clampHz(600 + 6000 * p.tone), t);
          lp.frequency.exponentialRampToValueAtTime(clampHz(300 + 2500 * p.tone), t + len);

          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.02);
          g.gain.setValueAtTime(amp, t + len * 0.85);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);

          osc.connect(lp);
          lp.connect(g);
          g.connect(out);
          osc.start(t);
          lfo.start(t);
          osc.stop(t + len + 0.05);
          lfo.stop(t + len + 0.05);
          osc.onended = () => {
            try {
              osc.disconnect();
              lfo.disconnect();
              lfoGain.disconnect();
              lp.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  whistle: {
    name: 'Whistle',
    hue: 268,
    params: [
      R('sweep', 'Sweep', -36, 36, -12, 1, 'st'),
      L('time', 'Time', 0.1, 3, 0.6, 's'),
      R('vib', 'Vibrato', 0, 8, 1.5, 0.1, 'st'),
      R('breath', 'Breath', 0, 1, 0.2),
      R('level', 'Level', 0, 1, 0.55)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.1, p.time);
          const f0 = clampHz(midiToFreq(midi));
          const f1 = clampHz(f0 * Math.pow(2, (p.sweep || 0) / 12));
          const amp = Math.max(0.02, vel) * 0.4;

          // The tone glides from the played note by Sweep semitones.
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f0, t);
          osc.frequency.exponentialRampToValueAtTime(f1, t + len * 0.95);

          let vibLfo = null;
          let vibGain = null;
          if (p.vib > 0.01) {
            vibLfo = ctx.createOscillator();
            vibLfo.type = 'sine';
            vibLfo.frequency.value = 5.5;
            vibGain = ctx.createGain();
            vibGain.gain.value = p.vib * 100;
            vibLfo.connect(vibGain);
            vibGain.connect(osc.detune);
            vibLfo.start(t);
            vibLfo.stop(t + len + 0.05);
          }

          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + Math.min(0.08, len * 0.25));
          g.gain.setValueAtTime(amp, t + len * 0.7);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);
          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + len + 0.05);
          osc.onended = () => {
            try {
              osc.disconnect();
              g.disconnect();
              if (vibLfo) vibLfo.disconnect();
              if (vibGain) vibGain.disconnect();
            } catch (e) {
              /* ignore */
            }
          };

          // A breath of noise riding the glide, so it sounds blown not bowed.
          if (p.breath > 0.01) {
            const src = ctx.createBufferSource();
            src.buffer = engine.getNoise('white');
            src.loop = true;
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.Q.value = 2.5;
            bp.frequency.setValueAtTime(f0, t);
            bp.frequency.exponentialRampToValueAtTime(f1, t + len * 0.95);
            const ng = ctx.createGain();
            ng.gain.setValueAtTime(0.0001, t);
            ng.gain.linearRampToValueAtTime(amp * 0.5 * p.breath, t + 0.05);
            ng.gain.exponentialRampToValueAtTime(0.0001, t + len * 0.9);
            src.connect(bp);
            bp.connect(ng);
            ng.connect(out);
            src.start(t);
            src.stop(t + len + 0.05);
            src.onended = () => {
              try {
                src.disconnect();
                bp.disconnect();
                ng.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  glass: {
    name: 'Glass',
    hue: 172,
    params: [
      R('pieces', 'Pieces', 3, 16, 9, 1),
      L('time', 'Time', 0.1, 2, 0.5, 's'),
      R('tone', 'Tone', 0, 1, 0.6),
      R('level', 'Level', 0, 1, 0.5)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.1, p.time);
          const tone = Math.max(0, Math.min(1, p.tone));
          const amp = Math.max(0.02, vel) * 0.5;

          // The crack of the break itself: a bright, very short noise burst.
          const src = ctx.createBufferSource();
          src.buffer = engine.getNoise('white');
          src.loop = true;
          const hp = ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = clampHz(2500 + 4500 * tone);
          hp.Q.value = 0.7;
          const cg = ctx.createGain();
          const clen = Math.min(0.18, len * 0.5);
          cg.gain.setValueAtTime(0.0001, t);
          cg.gain.linearRampToValueAtTime(amp * 0.8, t + 0.002);
          cg.gain.exponentialRampToValueAtTime(0.0001, t + clen);
          src.connect(hp);
          hp.connect(cg);
          cg.connect(out);
          src.start(t);
          src.stop(t + clen + 0.05);
          src.onended = () => {
            try {
              src.disconnect();
              hp.disconnect();
              cg.disconnect();
            } catch (e) {
              /* ignore */
            }
          };

          // Then the shards: short, high partials scattered over the hit.
          const n = Math.max(3, Math.round(p.pieces));
          for (let i = 0; i < n; i++) {
            const f = clampHz(1800 + Math.random() * (2000 + 7000 * tone));
            if (f > 16000) continue;
            const at = t + Math.random() * len * 0.35;
            const dur = 0.02 + Math.random() * len * 0.35;
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, at);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, at);
            g.gain.linearRampToValueAtTime(amp * (0.25 + 0.55 * Math.random()), at + 0.002);
            g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
            osc.connect(g);
            g.connect(out);
            osc.start(at);
            osc.stop(at + dur + 0.03);
            osc.onended = () => {
              try {
                osc.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  splash: {
    name: 'Splash',
    hue: 194,
    params: [
      L('time', 'Time', 0.15, 2.5, 0.5, 's'),
      R('tone', 'Tone', 0, 1, 0.5),
      R('bloop', 'Bloop', 0, 1, 0.5),
      R('level', 'Level', 0, 1, 0.6)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.15, p.time);
          const tone = Math.max(0, Math.min(1, p.tone));
          const amp = Math.max(0.02, vel) * 0.7;

          // Water opens as it is hit, then closes again as it settles.
          const src = ctx.createBufferSource();
          src.buffer = engine.getNoise('white');
          src.loop = true;
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.Q.value = 1.4;
          bp.frequency.setValueAtTime(clampHz(400 + 800 * tone), t);
          bp.frequency.exponentialRampToValueAtTime(
            clampHz(2500 + 5000 * tone),
            t + Math.max(0.02, len * 0.18)
          );
          bp.frequency.exponentialRampToValueAtTime(clampHz(300 + 400 * tone), t + len);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);
          src.connect(bp);
          bp.connect(g);
          g.connect(out);
          src.start(t);
          src.stop(t + len + 0.05);
          src.onended = () => {
            try {
              src.disconnect();
              bp.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };

          // The low bloop of the water closing over.
          if (p.bloop > 0.01) {
            const ratio = Math.max(0.5, Math.min(2, midiToFreq(midi) / 261.63));
            const blen = Math.max(0.1, Math.min(len * 0.6, 0.5));
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(clampHz(260 * ratio), t);
            osc.frequency.exponentialRampToValueAtTime(clampHz(90 * ratio), t + blen * 0.7);
            const bg = ctx.createGain();
            bg.gain.setValueAtTime(0.0001, t);
            bg.gain.linearRampToValueAtTime(amp * 0.5 * p.bloop, t + 0.01);
            bg.gain.exponentialRampToValueAtTime(0.0001, t + blen);
            osc.connect(bg);
            bg.connect(out);
            osc.start(t);
            osc.stop(t + blen + 0.05);
            osc.onended = () => {
              try {
                osc.disconnect();
                bg.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  bounce: {
    name: 'Bounce',
    hue: 32,
    params: [
      R('bounces', 'Bounces', 2, 12, 5, 1),
      L('time', 'Time', 0.3, 4, 1.4, 's'),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.7)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.3, p.time);
          const base = midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12);
          const amp = Math.max(0.02, vel) * 0.7;
          const n = Math.max(2, Math.round(p.bounces));

          // Each bounce comes sooner and lower than the last, as the ball
          // loses height.
          let at = t;
          let gap = len * 0.32;
          let f = clampHz(base * 0.9);
          for (let i = 0; i < n; i++) {
            const dur = Math.max(0.05, gap * 0.9);
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(clampHz(f * 1.7), at);
            osc.frequency.exponentialRampToValueAtTime(f, at + Math.min(0.12, dur * 0.6));
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, at);
            g.gain.linearRampToValueAtTime(amp * Math.pow(0.82, i), at + 0.003);
            g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
            osc.connect(g);
            g.connect(out);
            osc.start(at);
            osc.stop(at + dur + 0.03);
            osc.onended = () => {
              try {
                osc.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
            at += gap;
            gap *= 0.7;
            f = clampHz(f * 0.82);
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  sparkle: {
    name: 'Sparkle',
    hue: 312,
    params: [
      R('grains', 'Grains', 3, 24, 12, 1),
      L('time', 'Time', 0.2, 3, 1.1, 's'),
      R('spread', 'Spread', 0, 48, 24, 1, 'st'),
      R('decay', 'Decay', 0.03, 0.8, 0.18, 0.01, 's'),
      R('level', 'Level', 0, 1, 0.45)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.2, p.time);
          const base = midiToFreq(midi);
          const amp = Math.max(0.02, vel) * 0.22;
          const n = Math.max(3, Math.round(p.grains));

          // A handful of short high pings scattered over the note, each a
          // random number of semitones above the one played.
          for (let i = 0; i < n; i++) {
            const f = base * Math.pow(2, (Math.random() * (p.spread || 0)) / 12);
            if (f > 16000) continue;
            const at = t + Math.random() * len;
            const dur = Math.max(0.03, p.decay * (0.5 + Math.random()));
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, at);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, at);
            g.gain.linearRampToValueAtTime(amp * (0.3 + 0.7 * Math.random()), at + 0.003);
            g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
            osc.connect(g);
            g.connect(out);
            osc.start(at);
            osc.stop(at + dur + 0.03);
            osc.onended = () => {
              try {
                osc.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  thunder: {
    name: 'Thunder',
    hue: 242,
    params: [
      L('time', 'Time', 0.5, 8, 3, 's'),
      R('tone', 'Tone', 0, 1, 0.35),
      R('crack', 'Crack', 0, 1, 0.6),
      R('level', 'Level', 0, 1, 0.6)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.5, p.time);
          const tone = Math.max(0, Math.min(1, p.tone));
          const amp = Math.max(0.02, vel) * 2;

          // The crack of the strike: a short bright snap.
          if (p.crack > 0.01) {
            const clen = Math.min(0.2, len * 0.25);
            const csrc = ctx.createBufferSource();
            csrc.buffer = engine.getNoise('white');
            csrc.loop = true;
            const hp = ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = clampHz(900 + 2500 * tone);
            hp.Q.value = 0.7;
            const cg = ctx.createGain();
            cg.gain.setValueAtTime(0.0001, t);
            cg.gain.linearRampToValueAtTime(amp * 0.35 * p.crack, t + 0.003);
            cg.gain.exponentialRampToValueAtTime(0.0001, t + clen);
            csrc.connect(hp);
            hp.connect(cg);
            cg.connect(out);
            csrc.start(t);
            csrc.stop(t + clen + 0.05);
            csrc.onended = () => {
              try {
                csrc.disconnect();
                hp.disconnect();
                cg.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }

          // Then the rumble: pink noise behind a dark filter that closes as
          // it rolls away.
          const src = ctx.createBufferSource();
          src.buffer = engine.getNoise('pink');
          src.loop = true;
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.Q.value = 0.8;
          lp.frequency.setValueAtTime(clampHz(90 + 500 * tone), t);
          lp.frequency.exponentialRampToValueAtTime(clampHz(50), t + len);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + Math.min(0.25, len * 0.15));
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);
          src.connect(lp);
          lp.connect(g);
          g.connect(out);
          src.start(t);
          src.stop(t + len + 0.05);
          src.onended = () => {
            try {
              src.disconnect();
              lp.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  subdrop: {
    name: 'Sub Drop',
    hue: 256,
    params: [
      L('from', 'From', 40, 300, 110, 'hz'),
      L('to', 'To', 20, 120, 32, 'hz'),
      L('time', 'Time', 0.3, 8, 2.2, 's'),
      R('drive', 'Drive', 0, 1, 0.3),
      R('level', 'Level', 0, 1, 0.75)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.3, p.time);
          const amp = Math.max(0.02, vel) * 0.6;
          // To always sits below From, so the dive always falls.
          const to = Math.min(p.from - 1, p.to);

          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(clampHz(p.from), t);
          osc.frequency.exponentialRampToValueAtTime(clampHz(to), t + len * 0.85);

          // A little drive so the dive still reads on a small speaker.
          const pre = ctx.createGain();
          pre.gain.value = 1 + 3 * Math.max(0, Math.min(1, p.drive));
          const shaper = ctx.createWaveShaper();
          shaper.curve = tanhCurve();
          shaper.oversample = '2x';

          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);

          osc.connect(pre);
          pre.connect(shaper);
          shaper.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + len + 0.05);
          osc.onended = () => {
            try {
              osc.disconnect();
              pre.disconnect();
              shaper.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };

          // A short click lands the drop.
          const csrc = ctx.createBufferSource();
          csrc.buffer = engine.getNoise('white');
          csrc.loop = true;
          const hp = ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = 1500;
          hp.Q.value = 0.7;
          const cg = ctx.createGain();
          cg.gain.setValueAtTime(0.0001, t);
          cg.gain.linearRampToValueAtTime(amp * 0.12, t + 0.002);
          cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
          csrc.connect(hp);
          hp.connect(cg);
          cg.connect(out);
          csrc.start(t);
          csrc.stop(t + 0.1);
          csrc.onended = () => {
            try {
              csrc.disconnect();
              hp.disconnect();
              cg.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  // Pluck -----------------------------------------------------------------
  //
  // A Karplus-Strong string: a short burst of noise is fed into a delay line
  // whose output is damped and fed back, so the burst rings on as a string.
  // Every key played gets its own string, tuned from the note.
  clap: {
    name: 'Clap',
    hue: 340,
    params: [
      R('spread', 'Spread', 0.004, 0.06, 0.018, 0.001, 's'),
      R('tail', 'Tail', 0.02, 0.6, 0.18, 0.01, 's'),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.55)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      // One band of noise with a hard attack and a short fall: a single slap.
      const burst = (at, dur, amp) => {
        const src = ctx.createBufferSource();
        src.buffer = engine.getNoise('white');
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = clampHz(1100 * Math.pow(2, (p.tune || 0) / 12));
        bp.Q.value = 0.8;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.linearRampToValueAtTime(amp, at + 0.0015);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        src.connect(bp);
        bp.connect(g);
        g.connect(out);
        src.start(at);
        src.stop(at + dur + 0.03);
        src.onended = () => {
          try {
            src.disconnect();
            bp.disconnect();
            g.disconnect();
          } catch (e) {
            /* ignore */
          }
        };
      };

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.42;
          const spread = Math.max(0.004, p.spread);
          const tail = Math.max(0.02, p.tail);
          // Three quick slaps, then the room behind them.
          burst(t, 0.02, amp);
          burst(t + spread, 0.02, amp * 0.85);
          burst(t + spread * 2, 0.02, amp * 0.7);
          burst(t + spread * 2, tail, amp * 0.45);
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  cowbell: {
    name: 'Cowbell',
    hue: 40,
    params: [
      L('decay', 'Decay', 0.08, 2, 0.4, 's'),
      R('tone', 'Tone', 0, 1, 0.55),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.5)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.08, p.decay);
          const base = clampHz(midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12));
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.4;
          const tone = Math.max(0, Math.min(1, p.tone));

          // Two square waves a fourth and a bit apart, heard through a narrow
          // band: the trick behind the 808 cowbell.
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = clampHz(base * (2.2 + tone * 2.4));
          bp.Q.value = 1.6;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.003);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);
          bp.connect(g);
          g.connect(out);

          const oscs = [1, 1.48].map((ratio) => {
            const osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.setValueAtTime(clampHz(base * ratio), t);
            osc.connect(bp);
            osc.start(t);
            osc.stop(t + len + 0.03);
            return osc;
          });
          const last = oscs[oscs.length - 1];
          last.onended = () => {
            for (const osc of oscs) {
              try {
                osc.disconnect();
              } catch (e) {
                /* ignore */
              }
            }
            try {
              bp.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  boing: {
    name: 'Boing',
    hue: 100,
    params: [
      L('decay', 'Decay', 0.15, 3, 0.8, 's'),
      R('bend', 'Bend', -24, 12, -12, 1, 'st'),
      R('wobble', 'Wobble', 0, 1, 0.5),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.5)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.15, p.decay);
          const base = clampHz(midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12));
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.45;

          const osc = ctx.createOscillator();
          osc.type = 'sine';
          const from = clampHz(base * Math.pow(2, (p.bend || 0) / 12));
          osc.frequency.setValueAtTime(from, t);
          osc.frequency.exponentialRampToValueAtTime(base, t + len * 0.65);

          // The spring's wobble: a fast vibrato that fades as the note does.
          const wob = ctx.createOscillator();
          wob.type = 'sine';
          wob.frequency.value = 11;
          const wobGain = ctx.createGain();
          const depth = base * 0.35 * Math.max(0, Math.min(1, p.wobble));
          wobGain.gain.setValueAtTime(Math.max(0.1, depth), t);
          wobGain.gain.exponentialRampToValueAtTime(0.1, t + len);
          wob.connect(wobGain);
          wobGain.connect(osc.frequency);

          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.008);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);
          osc.connect(g);
          g.connect(out);

          osc.start(t);
          wob.start(t);
          wob.stop(t + len + 0.02);
          osc.stop(t + len + 0.05);
          osc.onended = () => {
            try {
              osc.disconnect();
              wob.disconnect();
              wobGain.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  buzz: {
    name: 'Buzz',
    hue: 20,
    params: [
      R('time', 'Time', 0.05, 1, 0.25, 0.01, 's'),
      R('tone', 'Tone', 0, 1, 0.6),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.45)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.05, p.time);
          // A buzzer sits an octave below the note, with grit over it.
          const base = clampHz(
            midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12) * 0.5
          );
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.4;
          const tone = Math.max(0, Math.min(1, p.tone));

          const osc = ctx.createOscillator();
          osc.type = 'square';
          osc.frequency.setValueAtTime(base, t);
          const shaper = ctx.createWaveShaper();
          shaper.curve = tanhCurve();
          shaper.oversample = '2x';
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = clampHz(400 + tone * 7000);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.004);
          g.gain.setValueAtTime(amp, t + len * 0.85);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);

          osc.connect(shaper);
          shaper.connect(lp);
          lp.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + len + 0.03);
          osc.onended = () => {
            try {
              osc.disconnect();
              shaper.disconnect();
              lp.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  tweet: {
    name: 'Tweet',
    hue: 175,
    params: [
      R('sweep', 'Sweep', 4, 36, 18, 1, 'st'),
      R('time', 'Time', 0.04, 0.4, 0.1, 0.005, 's'),
      R('chirps', 'Chirps', 1, 6, 2, 1),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.45)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.04, p.time);
          // Birds sit an octave above the note played.
          const base = clampHz(midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12) * 2);
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.36;
          const chirps = Math.max(1, Math.min(6, Math.round(p.chirps)));
          const to = clampHz(base * Math.pow(2, (p.sweep || 0) / 12));

          for (let i = 0; i < chirps; i++) {
            const at = t + i * len * 1.8;
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(base, at);
            osc.frequency.exponentialRampToValueAtTime(to, at + len);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, at);
            g.gain.linearRampToValueAtTime(amp, at + 0.006);
            g.gain.exponentialRampToValueAtTime(0.0001, at + len);
            osc.connect(g);
            g.connect(out);
            osc.start(at);
            osc.stop(at + len + 0.02);
            osc.onended = () => {
              try {
                osc.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  glitch: {
    name: 'Glitch',
    hue: 300,
    params: [
      R('density', 'Density', 0.1, 1, 0.5),
      R('time', 'Time', 0.1, 1.5, 0.4, 0.01, 's'),
      R('tone', 'Tone', 0, 1, 0.6),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.4)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.1, p.time);
          const base = clampHz(midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12));
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.35;
          const density = Math.max(0.05, Math.min(1, p.density));
          const tone = Math.max(0, Math.min(1, p.tone));

          const osc = ctx.createOscillator();
          osc.type = 'square';
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = clampHz(600 + tone * 12000);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t);

          // Steps of a random pitch, opening and closing at random: a broken
          // machine rather than a melody.
          let at = t;
          let guard = 0;
          while (at < t + len && guard++ < 200) {
            const step = 0.008 + Math.random() * 0.045;
            osc.frequency.setValueAtTime(clampHz(base * (1 + Math.floor(Math.random() * 12))), at);
            g.gain.setValueAtTime(Math.random() < density ? amp : 0, at);
            g.gain.setValueAtTime(0, at + step * 0.85);
            at += step;
          }
          g.gain.setValueAtTime(0, t + len);

          osc.connect(lp);
          lp.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + len + 0.03);
          osc.onended = () => {
            try {
              osc.disconnect();
              lp.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  bell: {
    name: 'Bell',
    hue: 58,
    params: [
      R('ratio', 'Ratio', 0.5, 8, 3.5, 0.01, '×'),
      R('index', 'Index', 0, 1, 0.55),
      R('decay', 'Decay', 0.3, 8, 2.4, 0.01, 's'),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.55)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.3, p.decay);
          const base = clampHz(midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12));
          const ratio = Math.max(0.5, p.ratio);
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.5;

          const carrier = ctx.createOscillator();
          carrier.type = 'sine';
          carrier.frequency.setValueAtTime(base, t);

          // A second sine bends the carrier's pitch. Its depth is highest at the
          // strike and falls away fast, so the bell opens bright and then
          // settles into a pure tone.
          const modOsc = ctx.createOscillator();
          modOsc.type = 'sine';
          modOsc.frequency.setValueAtTime(clampHz(base * ratio), t);
          const depth = Math.max(0, Math.min(1, p.index)) * base * 6;
          const modGain = ctx.createGain();
          modGain.gain.setValueAtTime(Math.max(0.0001, depth), t);
          modGain.gain.exponentialRampToValueAtTime(
            0.0001,
            t + Math.min(len, 0.12 + len * 0.25)
          );

          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);

          modOsc.connect(modGain);
          modGain.connect(carrier.frequency);
          carrier.connect(g);
          g.connect(out);
          modOsc.start(t);
          carrier.start(t);
          modOsc.stop(t + len + 0.05);
          carrier.stop(t + len + 0.05);
          carrier.onended = () => {
            try {
              carrier.disconnect();
              modOsc.disconnect();
              modGain.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  marimba: {
    name: 'Marimba',
    hue: 96,
    params: [
      R('decay', 'Decay', 0.08, 2, 0.45, 0.01, 's'),
      R('tone', 'Tone', 0, 1, 0.5),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.7)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;
      // A marimba bar rings on its fundamental plus a bright fourth-partial
      // "ping" that dies first. Tone sets how much of that ping is heard.
      const PARTIALS = [1, 4, 9.2];

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.08, p.decay);
          const base = clampHz(midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12));
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.7;
          const tone = Math.max(0, Math.min(1, p.tone));

          for (let i = 0; i < PARTIALS.length; i++) {
            const f = base * PARTIALS[i];
            if (f > 16000) continue;
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t);
            // The upper partials ring shorter and quieter.
            const plen = len * Math.pow(0.42, i);
            const plevel = amp * Math.pow(tone * 0.6 + 0.4, i) * (i ? 0.45 : 1);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(plevel, t + 0.003);
            g.gain.exponentialRampToValueAtTime(0.0001, t + plen);
            osc.connect(g);
            g.connect(out);
            osc.start(t);
            osc.stop(t + plen + 0.05);
            osc.onended = () => {
              try {
                osc.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  shaker: {
    name: 'Shaker',
    hue: 132,
    params: [
      R('decay', 'Decay', 0.03, 0.6, 0.12, 0.01, 's'),
      R('tone', 'Tone', 0, 1, 0.6),
      R('level', 'Level', 0, 1, 0.45)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.03, p.decay);
          const tone = Math.max(0, Math.min(1, p.tone));
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.5;

          // Grains of high filtered noise: the shake, then a lighter one
          // trailing it a moment later.
          const grain = (at, gain) => {
            const src = ctx.createBufferSource();
            src.buffer = engine.getNoise('white');
            src.loop = true;
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = clampHz(3500 + tone * 5000);
            bp.Q.value = 1.1;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, at);
            g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
            g.gain.exponentialRampToValueAtTime(0.0001, at + len);
            src.connect(bp);
            bp.connect(g);
            g.connect(out);
            src.start(at);
            src.stop(at + len + 0.03);
            src.onended = () => {
              try {
                src.disconnect();
                bp.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          };

          grain(t, amp);
          if (len > 0.06) grain(t + Math.min(len * 0.55, 0.06), amp * 0.55);
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  tom: {
    name: 'Tom',
    hue: 14,
    params: [
      R('tune', 'Tune', -24, 24, 0, 1),
      R('bend', 'Bend', 0, 24, 7, 0.5, 'st'),
      R('decay', 'Decay', 0.1, 2, 0.5, 0.01, 's'),
      R('tone', 'Tone', 0, 1, 0.35),
      R('level', 'Level', 0, 1, 0.75)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.1, p.decay);
          const base = clampHz(midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12));
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.8;
          const tone = Math.max(0, Math.min(1, p.tone));

          // The head starts above the note and drops onto it, the way a struck
          // drum's pitch settles.
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(
            clampHz(base * Math.pow(2, Math.max(0, p.bend) / 12)),
            t
          );
          osc.frequency.exponentialRampToValueAtTime(base, t + Math.min(0.2, len * 0.5));
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(amp, t + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);
          osc.connect(g);
          g.connect(out);
          osc.start(t);
          osc.stop(t + len + 0.05);
          osc.onended = () => {
            try {
              osc.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };

          // The stick on the head: a short burst of low-passed noise.
          if (tone > 0.01) {
            const nlen = 0.02 + 0.05 * tone;
            const src = ctx.createBufferSource();
            src.buffer = engine.getNoise('white');
            src.loop = true;
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = clampHz(1200 + tone * 4000);
            const ng = ctx.createGain();
            ng.gain.setValueAtTime(0.0001, t);
            ng.gain.linearRampToValueAtTime(amp * tone * 0.4, t + 0.002);
            ng.gain.exponentialRampToValueAtTime(0.0001, t + nlen);
            src.connect(lp);
            lp.connect(ng);
            ng.connect(out);
            src.start(t);
            src.stop(t + nlen + 0.03);
            src.onended = () => {
              try {
                src.disconnect();
                lp.disconnect();
                ng.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  crash: {
    name: 'Crash',
    hue: 232,
    params: [
      R('decay', 'Decay', 0.3, 6, 2.2, 0.01, 's'),
      R('tone', 'Tone', 0, 1, 0.65),
      R('level', 'Level', 0, 1, 0.45)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.3, p.decay);
          const tone = Math.max(0, Math.min(1, p.tone));
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.45;

          // A band of bright noise for the body of the crash, and a second,
          // brighter one that splashes on top and dies first.
          const layer = (at, gain, type, freq, q, length) => {
            const src = ctx.createBufferSource();
            src.buffer = engine.getNoise('white');
            src.loop = true;
            const f = ctx.createBiquadFilter();
            f.type = type;
            f.frequency.value = clampHz(freq);
            f.Q.value = q;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, at);
            g.gain.linearRampToValueAtTime(gain, at + 0.004);
            g.gain.exponentialRampToValueAtTime(0.0001, at + length);
            src.connect(f);
            f.connect(g);
            g.connect(out);
            src.start(at);
            src.stop(at + length + 0.05);
            src.onended = () => {
              try {
                src.disconnect();
                f.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          };

          layer(t, amp, 'highpass', 2500 + tone * 4500, 0.6, len);
          layer(t, amp * 0.55, 'bandpass', 6000 + tone * 6000, 1.4, len * 0.35);
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  chord: {
    name: 'Chord',
    hue: 278,
    params: [
      SEL('chord', 'Chord', [
        ['major', 'Major'],
        ['minor', 'Minor'],
        ['sus4', 'Sus4'],
        ['maj7', 'Maj7'],
        ['min7', 'Min7'],
        ['power', 'Power']
      ], 'minor'),
      R('spread', 'Spread', 0, 0.2, 0.05, 0.005, 's'),
      R('decay', 'Decay', 0.1, 4, 0.9, 0.01, 's'),
      R('tone', 'Tone', 0, 1, 0.45),
      R('tune', 'Tune', -24, 24, 0, 1),
      R('level', 'Level', 0, 1, 0.45)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;
      // Semitone steps of each chord, from the note played.
      const CHORDS = {
        major: [0, 4, 7, 12],
        minor: [0, 3, 7, 12],
        sus4: [0, 5, 7, 12],
        maj7: [0, 4, 7, 11],
        min7: [0, 3, 7, 10],
        power: [0, 7, 12, 19]
      };

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.1, p.decay);
          const base = clampHz(midiToFreq(midi) * Math.pow(2, (p.tune || 0) / 12));
          const amp = Math.max(0.02, Math.min(1, vel)) * 0.25;
          const steps = CHORDS[p.chord] || CHORDS.minor;
          const tone = Math.max(0, Math.min(1, p.tone));

          // The notes are strummed rather than hit together: one after another
          // across Spread seconds.
          const gap = steps.length > 1 ? Math.max(0, p.spread) / (steps.length - 1) : 0;
          for (let i = 0; i < steps.length; i++) {
            const at = t + i * gap;
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(clampHz(base * Math.pow(2, steps[i] / 12)), at);
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = clampHz(700 + tone * 11000);
            lp.Q.value = 0.7;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, at);
            g.gain.linearRampToValueAtTime(amp, at + 0.006);
            g.gain.exponentialRampToValueAtTime(0.0001, at + len);
            osc.connect(lp);
            lp.connect(g);
            g.connect(out);
            osc.start(at);
            osc.stop(at + len + 0.05);
            osc.onended = () => {
              try {
                osc.disconnect();
                lp.disconnect();
                g.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  downlifter: {
    name: 'Downlifter',
    hue: 316,
    params: [
      L('time', 'Time', 0.2, 8, 1.6, 's'),
      L('from', 'From', 80, 6000, 5000, 'hz'),
      L('to', 'To', 80, 12000, 250, 'hz'),
      R('q', 'Q', 1, 20, 4, 0.5),
      R('tone', 'Tone', 0, 1, 0.35),
      R('level', 'Level', 0, 1, 0.7)
    ],
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;

      return {
        inputs: {},
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn(midi, time, vel = 1) {
          const t = Math.max(safeTime(time), ctx.currentTime);
          const len = Math.max(0.15, p.time);
          // A narrow band passes little of the noise, so a high Q needs more
          // gain to stay as loud as a wide one.
          const amp = Math.max(0.02, vel) * 1.2 * Math.sqrt(Math.max(1, p.q));
          const hi = clampHz(Math.max(p.from, p.to));
          const lo = clampHz(Math.min(p.from, p.to));

          // The Riser played backwards: a band of noise falling from high to
          // low, for drops and transitions.
          const src = ctx.createBufferSource();
          src.buffer = engine.getNoise('white');
          src.loop = true;
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.Q.value = p.q;
          bp.frequency.setValueAtTime(hi, t);
          bp.frequency.exponentialRampToValueAtTime(lo, t + len);

          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(amp, t + 0.05);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len);

          src.connect(bp);
          bp.connect(g);
          g.connect(out);
          src.start(t);
          src.stop(t + len + 0.05);
          src.onended = () => {
            try {
              src.disconnect();
              bp.disconnect();
              g.disconnect();
            } catch (e) {
              /* ignore */
            }
          };

          // Tone adds a sine following the sweep down, the "pew" under the
          // noise.
          if (p.tone > 0.01) {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(clampHz(hi * 0.6), t);
            osc.frequency.exponentialRampToValueAtTime(clampHz(lo * 1.5), t + len);
            const tg = ctx.createGain();
            tg.gain.setValueAtTime(0.0001, t);
            tg.gain.exponentialRampToValueAtTime(amp * 0.25 * p.tone, t + 0.04);
            tg.gain.exponentialRampToValueAtTime(0.0001, t + len);
            osc.connect(tg);
            tg.connect(out);
            osc.start(t);
            osc.stop(t + len + 0.05);
            osc.onended = () => {
              try {
                osc.disconnect();
                tg.disconnect();
              } catch (e) {
                /* ignore */
              }
            };
          }
        },
        noteOff() {},
        dispose() {
          out.disconnect();
        }
      };
    }
  },

  pluck: {
    name: 'Pluck',
    hue: 45,
    params: [
      R('decay', 'Decay', 0.2, 8, 2.4, 0.05, 's'),
      R('damp', 'Damp', 0.05, 1, 0.5),
      R('pick', 'Pick', 0.002, 0.08, 0.02, 0.001, 's'),
      R('level', 'Level', 0, 1, 0.85)
    ],
    inputs: [{ id: 'pitch', label: 'Pitch', kind: 'cv' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const out = ctx.createGain();
      out.gain.value = p.level;
      // Pitch CV arrives in octaves. A longer string needs a bigger change in
      // its length for the same interval, so each string scales it by its own
      // period.
      const pitchIn = ctx.createGain();
      pitchIn.gain.value = 1;
      const voices = [];
      const MAX_VOICES = 10;

      function dropVoice(v) {
        for (const n of v.nodes) {
          try {
            n.disconnect();
          } catch (e) {
            /* ignore */
          }
        }
        // The string tapped the shared pitch CV: that end of the cable has to
        // come off too, or every pluck played would leave a gain node behind.
        try {
          pitchIn.disconnect(v.cvAmt);
        } catch (e) {
          /* ignore */
        }
        const i = voices.indexOf(v);
        if (i >= 0) voices.splice(i, 1);
      }

      function noteOn(midi, time, vel = 1) {
        const t = Math.max(safeTime(time), ctx.currentTime);
        const period = Math.min(0.18, Math.max(0.0008, 1 / midiToFreq(midi)));
        const decay = Math.max(0.15, p.decay);
        const pickLen = Math.max(0.002, p.pick);
        const amp = Math.max(0.05, Math.min(1, vel)) * 0.5;
        while (voices.length >= MAX_VOICES) dropVoice(voices[0]);

        // The string's input: the pluck plus whatever comes back round the loop.
        const sum = ctx.createGain();
        const loop = ctx.createDelay(0.2);
        loop.delayTime.value = period;
        const damp = ctx.createBiquadFilter();
        damp.type = 'lowpass';
        damp.frequency.value = 300 + Math.max(0, Math.min(1, p.damp)) * 14000;
        damp.Q.value = 0.2;
        const fb = ctx.createGain();
        // The string loses a little energy on every trip round its delay line:
        // a gain of g is 60 dB down after `decay` seconds.
        const g = Math.min(0.9998, Math.pow(0.001, period / decay));
        fb.gain.setValueAtTime(g, t);
        fb.gain.setValueAtTime(g, t + decay);
        fb.gain.linearRampToValueAtTime(0, t + decay + 0.15);

        const burst = ctx.createBufferSource();
        burst.buffer = engine.getNoise('white');
        burst.loop = true;
        const pickGain = ctx.createGain();
        pickGain.gain.setValueAtTime(amp, t);
        pickGain.gain.exponentialRampToValueAtTime(0.0001, t + pickLen);

        // A CV wiggle moves the string's length itself, so its pitch glides
        // rather than jumping.
        const cvAmt = ctx.createGain();
        cvAmt.gain.value = -period * Math.LN2;

        burst.connect(pickGain);
        pickGain.connect(sum);
        sum.connect(loop);
        loop.connect(damp);
        damp.connect(fb);
        fb.connect(sum);
        loop.connect(out);
        pitchIn.connect(cvAmt);
        cvAmt.connect(loop.delayTime);

        burst.start(t);
        burst.stop(t + pickLen + 0.03);

        voices.push({ nodes: [burst, pickGain, sum, loop, damp, fb, cvAmt], cvAmt });
      }

      return {
        inputs: { pitch: pitchIn },
        outputs: { out },
        setParam(key) {
          if (key === 'level') out.gain.setTargetAtTime(p.level, ctx.currentTime, 0.02);
        },
        noteOn,
        noteOff() {},
        dispose() {
          while (voices.length) dropVoice(voices[0]);
          out.disconnect();
          pitchIn.disconnect();
        }
      };
    }
  },

  // Vowel -----------------------------------------------------------------
  //
  // Three resonant bands tuned to the formants of A, E, I, O and U, so
  // anything patched in talks. Shift moves the whole voice up or down, and the
  // Morph CV input sweeps it from an LFO or an envelope.
  vowel: {
    name: 'Vowel',
    hue: 320,
    params: [
      SEL('vowel', 'Vowel', [
        ['a', 'A'],
        ['e', 'E'],
        ['i', 'I'],
        ['o', 'O'],
        ['u', 'U']
      ], 'a'),
      R('shift', 'Shift', 0.5, 2, 1),
      R('res', 'Resonance', 1, 24, 8, 0.1),
      R('cv', 'Morph CV', 0, 2, 0.5),
      R('mix', 'Mix', 0, 1, 0.85)
    ],
    inputs: [
      { id: 'in', label: 'In', kind: 'audio' },
      { id: 'cv', label: 'Morph', kind: 'cv' }
    ],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const input = ctx.createGain();
      const out = ctx.createGain();
      const wet = ctx.createGain();
      wet.gain.value = p.mix;
      const dry = ctx.createGain();
      dry.gain.value = 1 - p.mix * 0.9;
      input.connect(dry);
      dry.connect(out);
      wet.connect(out);

      const cv = ctx.createGain();
      cv.gain.value = p.cv * 1200;

      const bands = [0, 1, 2].map(() => {
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = Math.max(0.5, p.res);
        const g = ctx.createGain();
        input.connect(f);
        f.connect(g);
        g.connect(wet);
        cv.connect(f.detune);
        return { f, g };
      });

      function tune() {
        const vowel = VOWELS[p.vowel] || VOWELS.a;
        const shift = Math.max(0.25, Math.min(4, p.shift));
        const res = Math.max(0, p.res);
        const now = ctx.currentTime;
        bands.forEach((b, i) => {
          const hz = Math.min(16000, (vowel[i] || 1000) * shift);
          b.f.frequency.setTargetAtTime(hz, now, 0.02);
          b.f.Q.setTargetAtTime(Math.max(0.5, p.res), now, 0.02);
          // A narrow band passes less of the signal, so the resonance adds a
          // little level back: the vowel keeps its loudness as it sharpens.
          b.g.gain.setTargetAtTime(VOWEL_GAINS[i] * (1 + res * 0.2), now, 0.02);
        });
      }
      tune();

      return {
        inputs: { in: input, cv },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'vowel' || key === 'shift' || key === 'res') tune();
          else if (key === 'cv') cv.gain.setTargetAtTime(p.cv * 1200, now, 0.02);
          else if (key === 'mix') {
            wet.gain.setTargetAtTime(p.mix, now, 0.02);
            dry.gain.setTargetAtTime(1 - p.mix * 0.9, now, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          input.disconnect();
          dry.disconnect();
          wet.disconnect();
          out.disconnect();
          cv.disconnect();
          for (const b of bands) {
            b.f.disconnect();
            b.g.disconnect();
          }
        }
      };
    }
  },

  // Octaver ---------------------------------------------------------------
  //
  // A full-wave rectifier folds the wave up, so an octave above the input
  // appears under it. Amount decides how much of that joins the dry signal.
  octaver: {
    name: 'Octaver',
    hue: 50,
    params: [
      R('amount', 'Amount', 0, 1, 0.6),
      R('tone', 'Tone', 400, 16000, 7000, 10, 'hz'),
      R('mix', 'Mix', 0, 1, 0.7)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const input = ctx.createGain();
      const out = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      shaper.curve = rectCurve();
      shaper.oversample = '2x';
      // Rectifying leaves a DC offset behind, which would only steal headroom.
      const dc = ctx.createBiquadFilter();
      dc.type = 'highpass';
      dc.frequency.value = 30;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = p.tone;
      const wet = ctx.createGain();
      wet.gain.value = p.mix * p.amount;
      const dry = ctx.createGain();
      dry.gain.value = 1 - p.mix * 0.6;
      input.connect(shaper);
      shaper.connect(dc);
      dc.connect(tone);
      tone.connect(wet);
      wet.connect(out);
      input.connect(dry);
      dry.connect(out);
      return {
        inputs: { in: input },
        outputs: { out },
        setParam(key) {
          const now = ctx.currentTime;
          if (key === 'amount' || key === 'mix') {
            wet.gain.setTargetAtTime(p.mix * p.amount, now, 0.02);
            dry.gain.setTargetAtTime(1 - p.mix * 0.6, now, 0.02);
          } else if (key === 'tone') {
            tone.frequency.setTargetAtTime(p.tone, now, 0.02);
          }
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          input.disconnect();
          shaper.disconnect();
          dc.disconnect();
          tone.disconnect();
          wet.disconnect();
          dry.disconnect();
          out.disconnect();
        }
      };
    }
  },

  // Trance Gate -----------------------------------------------------------
  //
  // A tempo-locked stutter gate: the signal is dropped and opened again on a
  // pattern of steps at the project tempo.
  trance: {
    name: 'Trance Gate',
    hue: 300,
    params: [
      SEL('rate', 'Rate', [
        ['1/8', '1/8'],
        ['1/16', '1/16']
      ], '1/16'),
      SEL('pattern', 'Pattern', [
        ['offbeat', 'Off-beat'],
        ['pulse', 'Pulse'],
        ['trance', 'Trance'],
        ['random', 'Random']
      ], 'trance'),
      R('depth', 'Depth', 0, 1, 1),
      TOG('run', 'Run', true)
    ],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [{ id: 'out', label: 'Out', kind: 'audio' }],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const g = ctx.createGain();
      let next = 0;
      let step = 0;

      const stepDur = () => {
        const beat = 60 / (engine.bpm || 120);
        return p.rate === '1/8' ? beat / 2 : beat / 4;
      };

      function stepOn(i) {
        if (p.pattern === 'random') return Math.random() < 0.55 ? 1 : 0;
        const list = TRANCE_PATTERNS[p.pattern] || TRANCE_PATTERNS.trance;
        return list[i % list.length];
      }

      engine.addScheduler({
        schedule(from, to) {
          if (!p.run) {
            next = 0;
            g.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
            return;
          }
          if (next < from) next = from;
          let guard = 0;
          while (next < to && guard++ < 2000) {
            const on = stepOn(step++);
            const depth = Math.max(0, Math.min(1, p.depth));
            const target = on ? 1 : 1 - depth;
            // A few milliseconds either way, so the gate clicks less.
            g.gain.setTargetAtTime(target, next, 0.004);
            next += stepDur();
          }
        }
      });

      return {
        inputs: { in: g },
        outputs: { out: g },
        setParam() {},
        noteOn() {},
        noteOff() {},
        dispose() {
          g.disconnect();
        }
      };
    }
  },

  // Turing ----------------------------------------------------------------
  //
  // A random sequencer with a memory: eight bits shift once per step, and Flip
  // decides how often a new one comes in. With Flip down the same eight steps
  // come round again; turned up, the tune keeps mutating. The bits pick notes
  // from the chosen scale.
  turing: {
    name: 'Turing',
    hue: 90,
    params: [
      SEL('rate', 'Rate', [
        ['1/4', '1/4'],
        ['1/8', '1/8'],
        ['1/16', '1/16']
      ], '1/8'),
      SEL('scale', 'Scale', [
        ['major', 'Major'],
        ['minor', 'Minor'],
        ['penta', 'Penta'],
        ['chromatic', 'Chromatic']
      ], 'major'),
      R('flip', 'Flip', 0, 1, 0.15),
      R('gate', 'Gate', 0.05, 1, 0.5),
      TOG('run', 'Run', false)
    ],
    inputs: [],
    outputs: [
      { id: 'pitch', label: 'Pitch', kind: 'cv' },
      { id: 'trig', label: 'Gate', kind: 'cv' }
    ],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const pitch = ctx.createConstantSource();
      pitch.offset.value = 0;
      pitch.start();
      const gate = ctx.createConstantSource();
      gate.offset.value = 0;
      gate.start();
      const pitchOut = ctx.createGain();
      const gateOut = ctx.createGain();
      pitch.connect(pitchOut);
      gate.connect(gateOut);

      // A seed worth listening to; with Flip down it becomes a fixed loop.
      let reg = Array.from({ length: 8 }, () => (Math.random() < 0.5 ? 1 : 0));
      let next = 0;

      const stepDur = () => {
        const beat = 60 / (engine.bpm || 120);
        if (p.rate === '1/4') return beat;
        if (p.rate === '1/16') return beat / 4;
        return beat / 2;
      };

      engine.addScheduler({
        schedule(from, to) {
          if (!p.run) {
            next = 0;
            return;
          }
          if (next < from) next = from;
          let guard = 0;
          while (next < to && guard++ < 4000) {
            const dur = stepDur();
            const last = reg[reg.length - 1];
            const bit = Math.random() < Math.max(0, Math.min(1, p.flip)) ? 1 - last : last;
            reg = reg.slice(1).concat(bit);
            const value = reg.reduce((a, b) => (a << 1) | b, 0);
            const scale = SCALES[p.scale] || SCALES.major;
            const semis =
              scale[value % scale.length] + 12 * (Math.floor(value / scale.length) % 2);
            pitch.offset.setValueAtTime(semis / 12, next);
            gate.offset.setValueAtTime(1, next);
            gate.offset.setValueAtTime(
              0,
              next + dur * Math.max(0.05, Math.min(0.95, p.gate))
            );
            next += dur;
          }
        }
      });

      return {
        inputs: {},
        outputs: { pitch: pitchOut, trig: gateOut },
        setParam() {},
        noteOn() {},
        noteOff() {},
        dispose() {
          try {
            pitch.stop();
            gate.stop();
          } catch (e) {
            /* ignore */
          }
          pitch.disconnect();
          gate.disconnect();
          pitchOut.disconnect();
          gateOut.disconnect();
        }
      };
    }
  },

  // Arp -------------------------------------------------------------------
  //
  // Holds the keys that are down and cycles them as a pitch CV, measured from
  // the note the keys are sounding, so the arpeggio stays in the register that
  // was played.
  arp: {
    name: 'Arp',
    hue: 75,
    params: [
      SEL('rate', 'Rate', [
        ['1/4', '1/4'],
        ['1/8', '1/8'],
        ['1/16', '1/16']
      ], '1/16'),
      SEL('mode', 'Mode', [
        ['up', 'Up'],
        ['down', 'Down'],
        ['updown', 'Up-Down'],
        ['random', 'Random']
      ], 'up'),
      R('gate', 'Gate', 0.05, 1, 0.5),
      TOG('run', 'Run', true)
    ],
    inputs: [],
    outputs: [
      { id: 'pitch', label: 'Pitch', kind: 'cv' },
      { id: 'trig', label: 'Gate', kind: 'cv' }
    ],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const pitch = ctx.createConstantSource();
      pitch.offset.value = 0;
      pitch.start();
      const gate = ctx.createConstantSource();
      gate.offset.value = 0;
      gate.start();
      const pitchOut = ctx.createGain();
      const gateOut = ctx.createGain();
      pitch.connect(pitchOut);
      gate.connect(gateOut);

      const held = []; // the notes down right now, in the order they were pressed
      let base = 0; // the note the keys sound, which every CV offset is measured from
      let next = 0;
      let index = 0;

      const stepDur = () => {
        const beat = 60 / (engine.bpm || 120);
        if (p.rate === '1/4') return beat;
        if (p.rate === '1/16') return beat / 4;
        return beat / 2;
      };

      function order() {
        const notes = held.slice().sort((a, b) => a - b);
        if (p.mode === 'down') {
          notes.reverse();
        } else if (p.mode === 'updown' && notes.length > 2) {
          return notes.concat(notes.slice(1, notes.length - 1).reverse());
        }
        return notes;
      }

      engine.addScheduler({
        schedule(from, to) {
          if (!p.run || !held.length) {
            next = 0;
            index = 0;
            return;
          }
          if (next < from) next = from;
          let guard = 0;
          while (next < to && guard++ < 4000) {
            const dur = stepDur();
            const notes = order();
            const midi =
              p.mode === 'random'
                ? notes[Math.floor(Math.random() * notes.length)]
                : notes[index++ % notes.length];
            pitch.offset.setValueAtTime((midi - base) / 12, next);
            gate.offset.setValueAtTime(1, next);
            gate.offset.setValueAtTime(
              0,
              next + dur * Math.max(0.05, Math.min(0.95, p.gate))
            );
            next += dur;
          }
        }
      });

      return {
        inputs: {},
        outputs: { pitch: pitchOut, trig: gateOut },
        setParam() {},
        noteOn(midi) {
          if (held.indexOf(midi) < 0) held.push(midi);
          base = midi;
          next = 0;
        },
        noteOff(midi) {
          const i = held.indexOf(midi);
          if (i >= 0) held.splice(i, 1);
          if (!held.length) {
            base = 0;
            index = 0;
            try {
              gate.offset.setValueAtTime(0, ctx.currentTime);
            } catch (e) {
              /* ignore */
            }
          }
        },
        dispose() {
          try {
            pitch.stop();
            gate.stop();
          } catch (e) {
            /* ignore */
          }
          pitch.disconnect();
          gate.disconnect();
          pitchOut.disconnect();
          gateOut.disconnect();
        }
      };
    }
  },

  output: {
    name: 'Output',
    hue: 0,
    // No trim by default: the Output is the last thing before the master
    // limiter, so a level below 1 only threw away part of the patch's level.
    params: [R('level', 'Level', 0, 1, 1)],
    inputs: [{ id: 'in', label: 'In', kind: 'audio' }],
    outputs: [],
    create(engine, mod) {
      const ctx = engine.ctx;
      const p = mod.params;
      const g = ctx.createGain();
      g.gain.value = p.level;
      g.connect(engine.master);
      return {
        inputs: { in: g },
        outputs: {},
        setParam(key) {
          if (key === 'level') g.gain.setTargetAtTime(p.level, ctx.currentTime, 0.01);
        },
        noteOn() {},
        noteOff() {},
        dispose() {
          g.disconnect();
        }
      };
    }
  }
};

// What each module is for, and the colour that says so ----------------------
//
// The picker lists the rack under these headings, and every module takes its
// group's hue for its card, its ports and its box in the patch view, so the
// colour alone tells you what a module does. `words` are what the picker's
// search looks through, so "osc", "gen", "fx", "seq" and plain synonyms reach a
// whole family rather than only the modules whose description happens to use
// the word.
export const MODULE_GROUPS = [
  {
    id: 'osc',
    label: 'Oscillators',
    hue: 200,
    words: 'osc oscillator synth synthesiser voice tone pitch lead drone sound source',
    types: ['vco', 'harmonic', 'sync', 'metal', 'chip', 'supersaw', 'fmosc', 'pulse', 'wavetable', 'vox']
  },
  {
    id: 'source',
    label: 'Sound generators',
    hue: 35,
    words: 'source sound instrument sample noise string gen generator texture',
    types: ['noise', 'sampler', 'pluck']
  },
  {
    id: 'gen',
    label: 'Sound effects',
    hue: 315,
    words: 'gen generator sfx one-shot percussion hit drum effect fx',
    types: [
      'drum', 'zap', 'riser', 'clang', 'boom', 'blip', 'ping', 'siren', 'whistle', 'glass',
      'splash', 'bounce', 'sparkle', 'thunder', 'subdrop', 'clap', 'cowbell', 'boing', 'buzz',
      'tweet', 'glitch', 'bell', 'marimba', 'shaker', 'tom', 'crash', 'chord', 'downlifter'
    ]
  },
  {
    id: 'filter',
    label: 'Filters & tone',
    hue: 275,
    words: 'filter filt tone shape eq equaliser frequency resonance fx effect processor',
    types: ['vcf', 'comb', 'vowel', 'eq']
  },
  {
    id: 'fx',
    label: 'Effects',
    hue: 175,
    words: 'fx effect processor distortion shape reverb echo chorus space drive grit',
    types: ['chorus', 'phaser', 'delay', 'reverb', 'drive', 'crusher', 'ringmod', 'folder', 'octaver', 'trance']
  },
  {
    id: 'level',
    label: 'Level & dynamics',
    hue: 240,
    words: 'level volume amp gain mix master output comp dynamics loud quiet',
    types: ['vca', 'comp', 'mixer', 'output']
  },
  {
    id: 'mod',
    label: 'Modulation',
    hue: 130,
    words: 'cv control voltage modulation mod env envelope glide lfo random slew',
    types: ['adsr', 'lfo', 'random', 'slew', 'atten', 'transpose', 'cvmix']
  },
  {
    id: 'seq',
    label: 'Sequencing',
    hue: 60,
    words: 'seq sequencer step pattern rhythm arpeggio trigger clock tempo gate',
    types: ['seq', 'turing', 'arp', 'clock']
  },
  {
    id: 'util',
    label: 'Utility',
    hue: 10,
    words: 'utility util routing split scope visual multiple',
    types: ['multiple', 'scope']
  }
];

// A module's own hue is only a fallback for one a group does not list: the
// group's colour always wins, so colour never disagrees with the heading.
for (const group of MODULE_GROUPS) {
  for (const type of group.types) {
    if (DEFS[type]) DEFS[type].hue = group.hue;
  }
}

export function defaultParams(type) {
  const def = DEFS[type];
  const params = {};
  if (!def) return params;
  for (const pd of def.params) params[pd.key] = pd.def;
  return params;
}


// Plain-language descriptions shown in the module picker.
export const MODULE_INFO = {
  vco: "Oscillator — the synth's raw tone. Saw, square, triangle or sine, with octave and fine tuning. Its pitch input takes CV from a sequencer or LFO.",
  noise: 'White or pink noise. Hiss, wind and percussion textures.',
  sampler: 'Plays an audio sample pitched across the keyboard. Load WAV, FLAC, Ogg Vorbis or Ogg Opus, then play it from the keys.',
  vcf: 'Filter — shapes the tone by removing highs, lows or a band. Resonance emphasises the cutoff; its CV input modulates it from an envelope or LFO.',
  vca: 'Amplifier — controls volume. Patch an envelope into its CV input so notes fade in and out instead of droning.',
  adsr: 'Envelope — attack, decay, sustain and release for each note played on the keyboard. Patch the Env output into a VCA or filter CV.',
  lfo: 'Low-frequency oscillator — slow, repeating modulation for vibrato, filter wobble or tremolo.',
  delay: 'Echo — repeats the signal, with time, feedback and a wet/dry mix.',
  reverb: 'Space — a convolution reverb with adjustable size and mix.',
  drive: 'Distortion — overdrives the signal for grit and warmth, with a tone control.',
  ringmod: 'Ring modulator — multiplies the input by an internal sine carrier for metallic, clangorous tones.',
  folder: 'Wavefolder — folds the waveform back on itself, adding buzzy harmonics.',
  chorus: 'Chorus — a short modulated delay that thickens and widens the sound.',
  mixer: 'Four-channel mixer — a level for each input plus a master level.',
  multiple: 'Multiple — splits one signal into three outputs.',
  atten: 'Attenuverter — scales CV down, or inverts it, before it reaches a destination.',
  random: 'Random CV — stepped or smooth random voltages for unpredictable modulation.',
  seq: '8-step sequencer — tuned pitch steps and gate pulses at the tempo. Turn Run on to drive an oscillator’s pitch.',
  scope: 'Oscilloscope — draws the waveform of whatever you patch in. Visual only; it makes no sound.',
  comp: 'Compressor — evens out dynamics and tames peaks.',
  output: 'Master output — the only module that reaches the speakers. Its level sets the final volume.',
  supersaw: 'Super Saw — seven detuned sawtooth oscillators in one. Wide, bright leads and pads; Detune sets how far apart they sit.',
  fmosc: 'FM oscillator — a sine modulator bends the carrier’s pitch for bells, basses and metallic tones. Ratio sets the modulator pitch, Index the depth.',
  pulse: 'Pulse — a variable-width pulse wave. Width sweeps from a hollow square to a thin, nasal pulse; octave and fine keep it in tune.',
  wavetable: 'Wavetable — one oscillator with five harmonic tables: Organ, Vocal, Reed, Glass and Hollow. Bright tilts the upper harmonics up or down.',
  vox: 'Vox — a formant oscillator. A sawtooth plus a breath of noise is shaped by vowel filters for A, E, I, O and U. Focus makes the formants more or less pronounced; Shift moves them up or down.',
  comb: 'Comb filter — a tuned short delay that rings at a pitch. Feedback makes it resonate; sweep Tune for flanger-like movement.',
  phaser: 'Phaser — four sweeping all-pass stages that notch the spectrum for a swirling, jet-like motion.',
  eq: 'Three-band EQ — shelving low and high plus a mid bell, for shaping tone by ±18 dB.',
  crusher: 'Crusher — reduces the bit depth for gritty digital distortion, with a tone control to soften it.',
  slew: 'Slew — lags a control voltage so it glides instead of jumping. Smooths stepped CV and softens envelopes.',
  transpose: 'Transpose — shifts a pitch CV by semitones, so a sequence can move without being retuned.',
  cvmix: 'CV mixer — blends three control voltages with attenuverters, for combining envelopes and LFOs.',
  clock: 'Clock — a gate pulse at the project tempo, with rate, pulse width and run. Patch it into a VCA or filter for rhythm.',
  drum: 'Drum — a kick, snare or hat synthesised on each key press. Tune, decay and tone shape it.',
  zap: 'Zap — a falling laser tone. Start sets how far above the played note it begins, Drop how far it falls, Time how long it takes.',
  riser: 'Riser — a band of noise sweeping from From to To, for builds and whooshes. Q makes it a focused whistle; Time is the whole sweep.',
  clang: 'Clang — an inharmonic metal hit. Metal blends from a harmonic ring to a bell-like clang, Strike adds a noise attack, Decay lets it ring out.',
  boom: 'Boom — an explosion: a low thump plus a noise body whose filter closes as it decays. Tone sets how bright the blast starts.',
  blip: 'Blip — an arcade blip: two short tone steps, the second one transposed up by Step. Wave, Time and Tune shape it.',
  ping: 'Ping — a sonar ping: a pure tone with two quiet high partials that fade first. Decay sets how long it rings, Shimmer how much of the partials you hear.',
  siren: 'Siren — a warning alarm: a sawtooth whose pitch wails up and down. Rate is how fast it sweeps, Depth how far, Time how long it sounds, Tone how bright it is.',
  whistle: 'Whistle — a slide whistle: a tone gliding by Sweep semitones, with Vibrato and a Breath of filtered noise. Good for cartoon falls and rises.',
  glass: 'Glass — shattered glass: a bright noise crack plus Pieces of short high partials scattered over the hit. Tone makes the shards brighter, Time sets how far they spread.',
  splash: 'Splash — a splash of water: a band of noise that opens and then closes, with a Bloop underneath as the water settles. Tone sets how bright the splash is.',
  bounce: 'Bounce — a ball dropping: Bounces thumps that come sooner and lower as it loses height. Time is the whole fall, Tune moves it up or down.',
  sparkle: 'Sparkle — a shimmer: Grains of short high pings scattered over Time, each within Spread semitones of the note played.',
  thunder: 'Thunder — a long rumble: pink noise behind a dark filter that closes as it rolls away, with a Crack at the start.',
  subdrop: 'Sub Drop — a sub-bass dive: a sine falling from From to To over Time, with Drive adding harmonics so it is heard on small speakers too.',
  clap: 'Clap — a hand clap: three quick slaps of filtered noise and the room behind them. Spread sets how far apart the slaps are, Tail how long the room rings.',
  cowbell: 'Cowbell — two square waves through a narrow band, the way the 808 cowbell was made. Decay sets how long it rings, Tone where the band sits.',
  boing: 'Boing — a cartoon spring: a tone that falls by Bend with a fast wobble that fades as it settles. Time is the whole boing.',
  buzz: 'Buzz — a game-show buzzer: a gritty square an octave below the note, held for Time.',
  tweet: 'Tweet — bird chirps: Chirps quick upward sweeps of Sweep semitones. Birds sit an octave above the note played.',
  glitch: 'Glitch — a broken machine: random steps of pitch gated on and off for Time. Density fills in the gaps.',
  bell: 'Bell — a tuned FM bell: Ratio picks the modulator pitch and Index how bright and long the strike is, then Decay lets it ring out.',
  marimba: 'Marimba — a wooden mallet: a sine fundamental with a short, bright fourth-partial ping. Tone sets how much of the ping is heard, Decay how long the bar rings.',
  shaker: 'Shaker — a quick grain of high filtered noise, with a second lighter one trailing it. Tone sets how bright the grain is, Decay how long it lasts.',
  tom: 'Tom — a pitched drum: Bend sets how far above the note the hit starts before dropping onto it, Tone adds the stick and Decay how long it rings.',
  crash: 'Crash — a cymbal: a long band of bright noise with a second splash on top that dies first. Tone makes the crash brighter, Decay how long it rings out.',
  chord: 'Chord — a strummed chord from the note played: Chord picks Major, Minor, Sus4, Maj7, Min7 or Power, Spread how far apart the notes are strummed, and Decay how long the stab rings.',
  downlifter: 'Downlifter — the Riser played backwards: a band of noise falling from From to To, for drops and transitions. Q focuses it, Tone adds a sine following it down.',
  pluck: 'Pluck — a plucked string: a short burst of noise sets a delay line ringing, so every key sounds a string. Damp turns it from a bright guitar into a soft nylon, Decay sets how long it rings, and its Pitch input takes CV from a Sequencer, Turing or Arp.',
  vowel: 'Vowel — a formant filter: three resonant bands tuned to A, E, I, O or U, so whatever is patched in talks and sings. Shift moves the whole voice, and Morph CV sweeps the vowels from an LFO or an envelope.',
  octaver: 'Octaver — folds the wave up so an octave above the input appears under it. Amount sets how much of that joins in, Tone keeps it from getting harsh.',
  trance: 'Trance Gate — a tempo-locked stutter gate. Pattern picks the rhythm, Depth how far the sound drops, and Rate is 1/8 or 1/16 at the project tempo.',
  turing: 'Turing — a random sequencer with a memory: eight bits shift once per step, and Flip sets how often a new one comes in. With Flip down it loops the same tune; turned up it keeps mutating. Scale keeps it musical.',
  arp: 'Arp — an arpeggiator: hold a chord on the keys and it cycles the held notes as a pitch CV, in Up, Down, Up-Down or Random order at the tempo. Patch Pitch into an oscillator and Gate into a VCA.',
  harmonic: 'Harmonic — an additive oscillator: Partials sets how many harmonics it has, Bright tilts them from a mellow fundamental to a full, buzzy top, and Even blends a hollow, square-like tone into a rich one. Organ stops and bell tones live here.',
  sync: 'Sync — a hard-synced saw: the cycle restarts Ratio times per note, so the saw is cut short again and again. Low ratios growl, high ones scream — sweep Ratio for a classic sync lead.',
  metal: 'Metal — five sine partials that slide from the harmonic series into the inharmonic ratios of a struck bar. Inharmonic sets how bell-like it is, Tone softens it.',
  chip: 'Chip — a chiptune oscillator: a pulse wave with a square an octave below it. Width thins the pulse, Sub mixes the low square in for a chiptune bass.'
};
