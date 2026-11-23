// Saved presets: name the patch as it stands, keep it on the device, and put
// it back in the rack later.
//
// A preset is the same shape as the rack that persist.js writes down — modules
// with their positions and parameters, and the cables between them — so it is
// read back through the same cleaning, and a preset saved by an older build
// cannot leave a module with a missing parameter.

import { app } from './app.js?v=13';
import { cleanModule, cleanCable, noteIds } from './persist.js?v=13';

const KEY = 'patchbay.presets.v1';
const MAX_PRESETS = 60;

// A compact way to write a preset that is one audio chain plus its modulation.
//
// `chain` is wired end to end, each module's Out into the next one's In, and ends
// at an Output. `extra` modules — envelopes, LFOs, sequencers — sit beside the
// chain without carrying audio. `links` are the CV cables, written as
// [module number, port, module number, port], counting from 1 in the order the
// modules were listed: `[6, 'cv', 3, 'cv']` is the sixth module's CV into the
// third one's CV. Only parameters that differ from the defaults are listed; the
// cleaning fills the rest in.
function chainPreset({ id, name, description, bpm, chain, extra = [], links = [] }) {
  const modules = [];
  const add = (type, params) => {
    const n = modules.length + 1;
    modules.push({
      id: 'm' + n,
      type,
      x: 20 + ((n - 1) % 3) * 230,
      y: 40 + Math.floor((n - 1) / 3) * 320,
      params: params || {}
    });
    return 'm' + n;
  };

  const ids = chain.map((m) => add(m[0], m[1]));
  for (const m of extra) add(m[0], m[1]);

  const cables = [];
  const link = (from, port, to, toPort) => {
    cables.push({
      id: 'c' + (cables.length + 1),
      from: { id: from, port },
      to: { id: to, port: toPort }
    });
  };
  for (let i = 1; i < ids.length; i++) link(ids[i - 1], 'out', ids[i], 'in');
  for (const [from, port, to, toPort] of links) link('m' + from, port, 'm' + to, toPort);

  return { id, name, description, bpm, master: 1, modules, cables };
}

// The racks that come after the six above: each a different oscillator, filter
// and set of effects, so the list covers the synth rather than repeating it.
const EXTRA_PRESETS = [
  chainPreset({
    id: 'built-sub',
    name: 'Sub bass',
    description: 'A sine two octaves down through a deep filter and a touch of drive — pure low end',
    bpm: 100,
    chain: [
      ['vco', { wave: 'sine', octave: -2, level: 0.9, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 220, res: 3, cv: 0.3 }],
      ['vca', { level: 0, cv: 1 }],
      ['drive', { drive: 3, tone: 700, level: 0.7 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.005, decay: 0.25, sustain: 0.35, release: 0.15 }]],
    links: [[6, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-wobble',
    name: 'Wobble bass',
    description: 'Saw bass with an LFO square-wave pumping the filter — the dubstep wobble',
    bpm: 128,
    chain: [
      ['vco', { wave: 'sawtooth', octave: -1, level: 0.85, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 420, res: 16, cv: 1 }],
      ['vca', { level: 0, cv: 1 }],
      ['output', { level: 1 }]
    ],
    extra: [
      ['adsr', { attack: 0.005, decay: 0.3, sustain: 0.4, release: 0.2 }],
      ['lfo', { shape: 'square', rate: 3.2, depth: 0.6 }]
    ],
    links: [[5, 'cv', 3, 'cv'], [6, 'cv', 2, 'cv']]
  }),
  chainPreset({
    id: 'built-glass',
    name: 'Glass keys',
    description: 'Additive, bright harmonic tone through a chorus and a room — clear and bell-like',
    bpm: 96,
    chain: [
      ['harmonic', { partials: 12, bright: 2.4, even: 0.2, level: 0.45 }],
      ['vcf', { type: 'lowpass', cutoff: 3200, res: 3, cv: 0.2 }],
      ['vca', { level: 0, cv: 1 }],
      ['chorus', { rate: 0.5, depth: 0.5, mix: 0.4 }],
      ['reverb', { size: 3.2, mix: 0.35 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.005, decay: 0.6, sustain: 0.25, release: 0.7 }]],
    links: [[7, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-bell',
    name: 'Bell keys',
    description: 'Hard-synced tone in a band-pass filter with a long tail — struck metal bells',
    bpm: 90,
    chain: [
      ['sync', { ratio: 3.5, level: 0.4 }],
      ['vcf', { type: 'bandpass', cutoff: 1800, res: 6, cv: 0.2 }],
      ['vca', { level: 0, cv: 1 }],
      ['reverb', { size: 4.5, mix: 0.5 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.002, decay: 1.2, sustain: 0, release: 0.8 }]],
    links: [[6, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-organ',
    name: 'Pipe organ',
    description: 'Twenty-four harmonics, a gentle swell and chorus — full church-organ stops',
    bpm: 72,
    chain: [
      ['harmonic', { partials: 24, bright: 1.2, even: 1, level: 0.4 }],
      ['vcf', { type: 'lowpass', cutoff: 4000, res: 1, cv: 0 }],
      ['vca', { level: 0, cv: 1 }],
      ['chorus', { rate: 0.25, depth: 0.35, mix: 0.35 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.08, decay: 0.2, sustain: 0.9, release: 0.5 }]],
    links: [[6, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-drone',
    name: 'Drone',
    description: 'A super saw held open with no envelope, its filter drifting slowly — a bed to play over',
    bpm: 60,
    chain: [
      ['supersaw', { voices: 5, detune: 0.35, level: 0.45, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 700, res: 4, cv: 0.8 }],
      ['vca', { level: 0.5, cv: 0 }],
      ['reverb', { size: 6, mix: 0.6 }],
      ['output', { level: 1 }]
    ],
    extra: [['lfo', { shape: 'sine', rate: 0.07, depth: 0.5 }]],
    links: [[6, 'cv', 2, 'cv']]
  }),
  chainPreset({
    id: 'built-ring',
    name: 'Ring bells',
    description: 'Harmonic tone through a ring modulator into a delay and a room — clangorous and metallic',
    bpm: 84,
    chain: [
      ['harmonic', { partials: 6, bright: 1.6, even: 0.6, level: 0.5 }],
      ['ringmod', { freq: 320, mix: 0.65 }],
      ['vca', { level: 0, cv: 1 }],
      ['delay', { time: 0.34, feedback: 0.3, mix: 0.3 }],
      ['reverb', { size: 4, mix: 0.4 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.002, decay: 1.6, sustain: 0.1, release: 1.2 }]],
    links: [[7, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-fold',
    name: 'Fold lead',
    description: 'Synced saw folded back on itself, filtered and echoed — a biting digital lead',
    bpm: 118,
    chain: [
      ['sync', { ratio: 4.2, level: 0.4 }],
      ['folder', { amount: 0.55, level: 0.7 }],
      ['vcf', { type: 'lowpass', cutoff: 2600, res: 8, cv: 0.3 }],
      ['vca', { level: 0, cv: 1 }],
      ['delay', { time: 0.24, feedback: 0.35, mix: 0.25 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.3 }]],
    links: [[7, 'cv', 4, 'cv']]
  }),
  chainPreset({
    id: 'built-comb',
    name: 'Comb pluck',
    description: 'A burst of noise ringing a tuned comb filter — a plucked string from a filter',
    bpm: 104,
    chain: [
      ['noise', { color: 'white', level: 0.5 }],
      ['vca', { level: 0, cv: 1 }],
      ['comb', { tune: 220, feedback: 0.85, mix: 0.9 }],
      ['reverb', { size: 3, mix: 0.35 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.001, decay: 0.06, sustain: 0, release: 0.35 }]],
    links: [[6, 'cv', 2, 'cv']]
  }),
  chainPreset({
    id: 'built-chipbass',
    name: 'Chip bass',
    description: 'Chip pulse with its octave-down square through a low filter — 8-bit bass',
    bpm: 120,
    chain: [
      ['chip', { width: 0.5, sub: 0.8, level: 0.3, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 900, res: 6, cv: 0.3 }],
      ['vca', { level: 0, cv: 1 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.004, decay: 0.2, sustain: 0.3, release: 0.12 }]],
    links: [[5, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-flute',
    name: 'Echo flute',
    description: 'Soft triangle with vibrato into a long delay and a room — a breathy solo line',
    bpm: 92,
    chain: [
      ['vco', { wave: 'triangle', level: 0.75, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 2600, res: 2, cv: 0.25 }],
      ['vca', { level: 0, cv: 1 }],
      ['delay', { time: 0.4, feedback: 0.45, mix: 0.35 }],
      ['reverb', { size: 2.6, mix: 0.3 }],
      ['output', { level: 1 }]
    ],
    extra: [
      ['adsr', { attack: 0.06, decay: 0.2, sustain: 0.8, release: 0.3 }],
      ['lfo', { shape: 'sine', rate: 5.2, depth: 0.04 }]
    ],
    links: [[7, 'cv', 3, 'cv'], [8, 'cv', 1, 'pitch']]
  }),
  chainPreset({
    id: 'built-scream',
    name: 'Sync scream',
    description: 'High-ratio hard sync through a screaming filter, drive and a slap — a razor lead',
    bpm: 132,
    chain: [
      ['sync', { ratio: 6.5, level: 0.35 }],
      ['vcf', { type: 'lowpass', cutoff: 1200, res: 14, cv: 0.8 }],
      ['vca', { level: 0, cv: 1 }],
      ['drive', { drive: 12, tone: 3000, level: 0.6 }],
      ['delay', { time: 0.18, feedback: 0.3, mix: 0.2 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.01, decay: 0.4, sustain: 0.6, release: 0.25 }]],
    links: [[7, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-strings',
    name: 'String pad',
    description: 'Five detuned saws with a slow bow, drifting filter and a warm hall — string ensemble',
    bpm: 76,
    chain: [
      ['supersaw', { voices: 5, detune: 0.6, level: 0.5, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 1800, res: 2, cv: 0.25 }],
      ['vca', { level: 0, cv: 1 }],
      ['reverb', { size: 3.6, mix: 0.45 }],
      ['output', { level: 1 }]
    ],
    extra: [
      ['adsr', { attack: 0.9, decay: 1.2, sustain: 0.85, release: 1.8 }],
      ['lfo', { shape: 'sine', rate: 0.2, depth: 0.3 }]
    ],
    links: [[6, 'cv', 3, 'cv'], [7, 'cv', 2, 'cv']]
  }),
  chainPreset({
    id: 'built-mallet',
    name: 'Wooden mallet',
    description: 'A few harmonics with a short, damped hit — marimba and wooden bars',
    bpm: 108,
    chain: [
      ['harmonic', { partials: 4, bright: 1.2, even: 0.3, level: 0.5 }],
      ['vcf', { type: 'lowpass', cutoff: 3000, res: 2, cv: 0 }],
      ['vca', { level: 0, cv: 1 }],
      ['reverb', { size: 2.2, mix: 0.3 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.001, decay: 0.35, sustain: 0, release: 0.25 }]],
    links: [[6, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-metal',
    name: 'Metal hit',
    description: 'Five partials slid into the ratios of a struck bar, ringing out in a room — a gong',
    bpm: 100,
    chain: [
      ['metal', { inharm: 0.85, tone: 9000, level: 0.35, pitchAmt: 1 }],
      ['vca', { level: 0, cv: 1 }],
      ['reverb', { size: 3, mix: 0.45 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.001, decay: 0.9, sustain: 0, release: 0.7 }]],
    links: [[5, 'cv', 2, 'cv']]
  }),
  chainPreset({
    id: 'built-fmbell',
    name: 'FM bell',
    description: 'A sine carrier bent by an FM modulator, into a delay and a long room — a tuned bell',
    bpm: 88,
    chain: [
      ['fmosc', { wave: 'sine', ratio: 3.5, index: 4, level: 0.6, pitchAmt: 1 }],
      ['vca', { level: 0, cv: 1 }],
      ['delay', { time: 0.3, feedback: 0.2, mix: 0.2 }],
      ['reverb', { size: 4.5, mix: 0.45 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.002, decay: 1.4, sustain: 0, release: 1 }]],
    links: [[6, 'cv', 2, 'cv']]
  }),
  chainPreset({
    id: 'built-pulse',
    name: 'Pulse lead',
    description: 'A thin pulse wave with vibrato, a bright filter and a short echo — a solo lead',
    bpm: 124,
    chain: [
      ['pulse', { width: 0.28, octave: 0, level: 0.7, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 2400, res: 7, cv: 0.4 }],
      ['vca', { level: 0, cv: 1 }],
      ['delay', { time: 0.22, feedback: 0.28, mix: 0.22 }],
      ['output', { level: 1 }]
    ],
    extra: [
      ['adsr', { attack: 0.005, decay: 0.25, sustain: 0.6, release: 0.2 }],
      ['lfo', { shape: 'triangle', rate: 5.5, depth: 0.06 }]
    ],
    links: [[6, 'cv', 3, 'cv'], [7, 'cv', 1, 'pitch']]
  }),
  chainPreset({
    id: 'built-wavetable',
    name: 'Wavetable keys',
    description: 'The glass table, softened and chorused — a clean digital electric piano',
    bpm: 90,
    chain: [
      ['wavetable', { table: 'glass', bright: 0.6, level: 0.6, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 4000, res: 1.5, cv: 0.15 }],
      ['vca', { level: 0, cv: 1 }],
      ['chorus', { rate: 0.4, depth: 0.5, mix: 0.35 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.01, decay: 0.5, sustain: 0.4, release: 0.6 }]],
    links: [[6, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-choir',
    name: 'Vox choir',
    description: 'A formant oscillator breathing on an open vowel, slow swell and a hall — a wordless choir',
    bpm: 80,
    chain: [
      ['vox', { vowel: 'a', shift: 0, focus: 9, breath: 0.25, level: 0.7, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 3500, res: 1, cv: 0.15 }],
      ['vca', { level: 0, cv: 1 }],
      ['reverb', { size: 4, mix: 0.4 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.5, decay: 0.8, sustain: 0.85, release: 1.4 }]],
    links: [[6, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-sweep',
    name: 'Noise sweep',
    description: 'White noise through a resonant band sweeping slowly up — risers, wind and tension',
    bpm: 100,
    chain: [
      ['noise', { color: 'white', level: 0.5 }],
      ['vcf', { type: 'bandpass', cutoff: 800, res: 8, cv: 1 }],
      ['vca', { level: 0, cv: 1 }],
      ['reverb', { size: 3, mix: 0.4 }],
      ['output', { level: 1 }]
    ],
    extra: [
      ['adsr', { attack: 0.4, decay: 1.2, sustain: 0.6, release: 1 }],
      ['lfo', { shape: 'sawtooth', rate: 0.25, depth: 0.8 }]
    ],
    links: [[6, 'cv', 3, 'cv'], [7, 'cv', 2, 'cv']]
  }),
  chainPreset({
    id: 'built-buzz',
    name: 'Buzz bass',
    description: 'A wide pulse an octave down through a tight filter and heavy drive — thick and dirty',
    bpm: 132,
    chain: [
      ['pulse', { width: 0.5, octave: -1, level: 0.75, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 600, res: 12, cv: 0.5 }],
      ['vca', { level: 0, cv: 1 }],
      ['drive', { drive: 18, tone: 1800, level: 0.55 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.004, decay: 0.15, sustain: 0.2, release: 0.1 }]],
    links: [[6, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-siren2',
    name: 'Siren lead',
    description: 'The one-shot siren played from the keys, filtered and echoed — alarms and laser falls',
    bpm: 110,
    chain: [
      ['siren', {}],
      ['vcf', { type: 'lowpass', cutoff: 4000, res: 2, cv: 0.2 }],
      ['vca', { level: 0, cv: 1 }],
      ['delay', { time: 0.3, feedback: 0.35, mix: 0.3 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.02, decay: 0.3, sustain: 0.7, release: 0.2 }]],
    links: [[6, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-glitch',
    name: 'Glitch machine',
    description: 'Random gated steps of a broken machine, crushed and echoed — stutter and grit',
    bpm: 120,
    chain: [
      ['glitch', {}],
      ['crusher', { bits: 5, tone: 6000, level: 0.6 }],
      ['vca', { level: 0, cv: 1 }],
      ['delay', { time: 0.16, feedback: 0.4, mix: 0.25 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.001, decay: 0.4, sustain: 0.6, release: 0.2 }]],
    links: [[6, 'cv', 3, 'cv']]
  }),
  chainPreset({
    id: 'built-studio',
    name: 'Studio lead',
    description: 'A saw lead shaped by an EQ and a light drive before the echo — a finished, mixed sound',
    bpm: 126,
    chain: [
      ['vco', { wave: 'sawtooth', level: 0.8, pitchAmt: 1 }],
      ['vcf', { type: 'lowpass', cutoff: 1400, res: 9, cv: 0.6 }],
      ['vca', { level: 0, cv: 1 }],
      ['eq', { low: 3, mid: -2, high: 2 }],
      ['drive', { drive: 5, tone: 4000, level: 0.7 }],
      ['output', { level: 1 }]
    ],
    extra: [['adsr', { attack: 0.005, decay: 0.2, sustain: 0.55, release: 0.2 }]],
    links: [[7, 'cv', 3, 'cv']]
  })
];

// Presets that come with Patch Bay. They are written in the same shape a saved
// preset has — modules with a position and the parameters that differ from the
// defaults, and cables by module id — so loading one goes through exactly the
// same path as loading a patch somebody saved.
export const BUILT_IN_PRESETS = [
  {
    id: 'built-lead',
    name: 'Classic lead',
    description: 'Saw through a resonant filter into a delay, with an envelope and a slow wobble',
    bpm: 120,
    master: 1,
    modules: [
      { id: 'm1', type: 'vco', x: 20, y: 30, params: { wave: 'sawtooth', level: 0.8, pitchAmt: 1 } },
      { id: 'm2', type: 'vcf', x: 250, y: 30, params: { type: 'lowpass', cutoff: 1600, res: 7, cv: 0.5 } },
      { id: 'm3', type: 'vca', x: 480, y: 30, params: { level: 0, cv: 1 } },
      { id: 'm4', type: 'adsr', x: 20, y: 350, params: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.4 } },
      { id: 'm5', type: 'lfo', x: 250, y: 350, params: { shape: 'sine', rate: 5, depth: 0.2 } },
      { id: 'm6', type: 'delay', x: 480, y: 350, params: { time: 0.28, feedback: 0.35, mix: 0.3 } },
      { id: 'm7', type: 'output', x: 20, y: 670, params: { level: 1 } }
    ],
    cables: [
      { id: 'c1', from: { id: 'm1', port: 'out' }, to: { id: 'm2', port: 'in' } },
      { id: 'c2', from: { id: 'm2', port: 'out' }, to: { id: 'm3', port: 'in' } },
      { id: 'c3', from: { id: 'm3', port: 'out' }, to: { id: 'm6', port: 'in' } },
      { id: 'c4', from: { id: 'm6', port: 'out' }, to: { id: 'm7', port: 'in' } },
      { id: 'c5', from: { id: 'm4', port: 'cv' }, to: { id: 'm3', port: 'cv' } },
      { id: 'c6', from: { id: 'm5', port: 'cv' }, to: { id: 'm2', port: 'cv' } }
    ]
  },
  {
    id: 'built-acid',
    name: 'Acid bass',
    description: 'Squelchy saw bass driven by the sequencer, with a fast envelope',
    bpm: 128,
    master: 1,
    modules: [
      { id: 'm1', type: 'vco', x: 20, y: 30, params: { wave: 'sawtooth', octave: -1, level: 0.8, pitchAmt: 1 } },
      { id: 'm2', type: 'vcf', x: 250, y: 30, params: { type: 'lowpass', cutoff: 420, res: 18, cv: 0.4 } },
      { id: 'm3', type: 'vca', x: 480, y: 30, params: { level: 0, cv: 1 } },
      { id: 'm4', type: 'adsr', x: 20, y: 350, params: { attack: 0.003, decay: 0.18, sustain: 0.1, release: 0.12 } },
      {
        id: 'm5',
        type: 'seq',
        x: 250,
        y: 350,
        params: {
          rate: '1/16', gate: 0.45, run: true,
          step0: 0, step1: 0, step2: 12, step3: 0, step4: 3, step5: 0, step6: 7, step7: -5
        }
      },
      { id: 'm6', type: 'output', x: 480, y: 350, params: { level: 1 } }
    ],
    cables: [
      { id: 'c1', from: { id: 'm1', port: 'out' }, to: { id: 'm2', port: 'in' } },
      { id: 'c2', from: { id: 'm2', port: 'out' }, to: { id: 'm3', port: 'in' } },
      { id: 'c3', from: { id: 'm3', port: 'out' }, to: { id: 'm6', port: 'in' } },
      { id: 'c4', from: { id: 'm4', port: 'cv' }, to: { id: 'm3', port: 'cv' } },
      { id: 'c5', from: { id: 'm5', port: 'pitch' }, to: { id: 'm1', port: 'pitch' } }
    ]
  },
  {
    id: 'built-pad',
    name: 'Ambient pad',
    description: 'Seven-voice super saw, slow swell, chorus and a long reverb',
    bpm: 84,
    master: 1,
    modules: [
      { id: 'm1', type: 'supersaw', x: 20, y: 30, params: { voices: 7, detune: 0.55, level: 0.55, pitchAmt: 1 } },
      { id: 'm2', type: 'vcf', x: 250, y: 30, params: { type: 'lowpass', cutoff: 2200, res: 2, cv: 0.35 } },
      { id: 'm3', type: 'vca', x: 480, y: 30, params: { level: 0, cv: 1 } },
      { id: 'm4', type: 'adsr', x: 20, y: 350, params: { attack: 1.2, decay: 1.5, sustain: 0.8, release: 2.4 } },
      { id: 'm5', type: 'lfo', x: 250, y: 350, params: { shape: 'sine', rate: 0.18, depth: 0.5 } },
      { id: 'm6', type: 'chorus', x: 480, y: 350, params: { rate: 0.4, depth: 0.6, mix: 0.45 } },
      { id: 'm7', type: 'reverb', x: 20, y: 670, params: { size: 3.6, mix: 0.45 } },
      { id: 'm8', type: 'output', x: 250, y: 670, params: { level: 1 } }
    ],
    cables: [
      { id: 'c1', from: { id: 'm1', port: 'out' }, to: { id: 'm2', port: 'in' } },
      { id: 'c2', from: { id: 'm2', port: 'out' }, to: { id: 'm3', port: 'in' } },
      { id: 'c3', from: { id: 'm3', port: 'out' }, to: { id: 'm6', port: 'in' } },
      { id: 'c4', from: { id: 'm6', port: 'out' }, to: { id: 'm7', port: 'in' } },
      { id: 'c5', from: { id: 'm7', port: 'out' }, to: { id: 'm8', port: 'in' } },
      { id: 'c6', from: { id: 'm4', port: 'cv' }, to: { id: 'm3', port: 'cv' } },
      { id: 'c7', from: { id: 'm5', port: 'cv' }, to: { id: 'm2', port: 'cv' } }
    ]
  },
  {
    id: 'built-pluck',
    name: 'Plucked arp',
    description: 'A Karplus-Strong string arpeggiated with a little delay and room',
    bpm: 110,
    master: 1,
    modules: [
      { id: 'm1', type: 'pluck', x: 20, y: 30, params: { decay: 1.6, damp: 0.6, pick: 0.02, level: 0.85 } },
      { id: 'm2', type: 'arp', x: 250, y: 30, params: { rate: '1/16', mode: 'updown', gate: 0.5, run: true } },
      { id: 'm3', type: 'delay', x: 20, y: 350, params: { time: 0.32, feedback: 0.4, mix: 0.35 } },
      { id: 'm4', type: 'reverb', x: 250, y: 350, params: { size: 2.8, mix: 0.3 } },
      { id: 'm5', type: 'output', x: 480, y: 350, params: { level: 1 } }
    ],
    cables: [
      { id: 'c1', from: { id: 'm1', port: 'out' }, to: { id: 'm3', port: 'in' } },
      { id: 'c2', from: { id: 'm3', port: 'out' }, to: { id: 'm4', port: 'in' } },
      { id: 'c3', from: { id: 'm4', port: 'out' }, to: { id: 'm5', port: 'in' } },
      { id: 'c4', from: { id: 'm2', port: 'pitch' }, to: { id: 'm1', port: 'pitch' } }
    ]
  },
  {
    id: 'built-drums',
    name: 'Drum machine',
    description: 'Kick, snare and hat mixed together — play them from the keys',
    bpm: 124,
    master: 1,
    modules: [
      { id: 'm1', type: 'drum', x: 20, y: 30, params: { type: 'kick', tune: 0, decay: 0.4, tone: 0.7, level: 0.9 } },
      { id: 'm2', type: 'drum', x: 250, y: 30, params: { type: 'snare', tune: 0, decay: 0.22, tone: 0.75, level: 0.7 } },
      { id: 'm3', type: 'drum', x: 480, y: 30, params: { type: 'hat', tune: 0, decay: 0.08, tone: 0.8, level: 0.5 } },
      { id: 'm4', type: 'mixer', x: 20, y: 350, params: { l1: 0.8, l2: 0.7, l3: 0.55, l4: 0, level: 1 } },
      { id: 'm5', type: 'output', x: 250, y: 350, params: { level: 1 } }
    ],
    cables: [
      { id: 'c1', from: { id: 'm1', port: 'out' }, to: { id: 'm4', port: 'in1' } },
      { id: 'c2', from: { id: 'm2', port: 'out' }, to: { id: 'm4', port: 'in2' } },
      { id: 'c3', from: { id: 'm3', port: 'out' }, to: { id: 'm4', port: 'in3' } },
      { id: 'c4', from: { id: 'm4', port: 'out' }, to: { id: 'm5', port: 'in' } }
    ]
  },
  {
    id: 'built-chip',
    name: 'Chiptune lead',
    description: 'Pulse wave with a square underneath, filtered with a touch of vibrato',
    bpm: 132,
    master: 1,
    modules: [
      { id: 'm1', type: 'chip', x: 20, y: 30, params: { width: 0.5, sub: 0.6, level: 0.35, pitchAmt: 1 } },
      { id: 'm2', type: 'vcf', x: 250, y: 30, params: { type: 'lowpass', cutoff: 2400, res: 5, cv: 0.3 } },
      { id: 'm3', type: 'vca', x: 480, y: 30, params: { level: 0, cv: 1 } },
      { id: 'm4', type: 'adsr', x: 20, y: 350, params: { attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.2 } },
      { id: 'm5', type: 'lfo', x: 250, y: 350, params: { shape: 'triangle', rate: 5.5, depth: 0.05 } },
      { id: 'm6', type: 'output', x: 480, y: 350, params: { level: 1 } }
    ],
    cables: [
      { id: 'c1', from: { id: 'm1', port: 'out' }, to: { id: 'm2', port: 'in' } },
      { id: 'c2', from: { id: 'm2', port: 'out' }, to: { id: 'm3', port: 'in' } },
      { id: 'c3', from: { id: 'm3', port: 'out' }, to: { id: 'm6', port: 'in' } },
      { id: 'c4', from: { id: 'm4', port: 'cv' }, to: { id: 'm3', port: 'cv' } },
      { id: 'c5', from: { id: 'm5', port: 'cv' }, to: { id: 'm1', port: 'pitch' } }
    ]
  },
  ...EXTRA_PRESETS
];

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function readAll() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch (e) {
    return [];
  }
  if (!raw) return [];
  let list = null;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(list)) return [];

  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || '');
    const name = String(p.name || '').trim().slice(0, 60);
    if (!id || !name) continue;
    out.push({
      id,
      name,
      savedAt: Number(p.savedAt) || 0,
      bpm: Number(p.bpm) || 120,
      master: Number.isFinite(Number(p.master)) ? Number(p.master) : 1,
      modules: Array.isArray(p.modules) ? p.modules : [],
      cables: Array.isArray(p.cables) ? p.cables : []
    });
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out;
}

function writeAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    // No storage, or no room: the preset simply is not kept.
    return false;
  }
}

export function listPresets() {
  return readAll();
}

// What the rack holds now, as a preset body.
function snapshot() {
  const { modules, cables, bpm, master } = app.state;
  return {
    bpm,
    master,
    modules: modules.map((m) => ({
      id: m.id,
      type: m.type,
      x: m.x,
      y: m.y,
      params: { ...m.params }
    })),
    cables: cables.map((c) => ({
      id: c.id,
      from: { id: c.from.id, port: c.from.port },
      to: { id: c.to.id, port: c.to.port }
    }))
  };
}

// Keep the rack under a name. Saving the same name again replaces that preset,
// so a patch can be tweaked and saved again without piling up.
export function savePreset(name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return null;

  const list = readAll();
  const existing = list.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  const preset = {
    ...snapshot(),
    id: existing ? existing.id : 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: clean,
    savedAt: Date.now()
  };

  const rest = list.filter((p) => p !== existing);
  rest.unshift(preset);
  if (!writeAll(rest.slice(0, MAX_PRESETS))) return null;
  return preset;
}

export function removePreset(id) {
  const list = readAll();
  const rest = list.filter((p) => p.id !== id);
  if (rest.length === list.length) return false;
  return writeAll(rest);
}

// A preset cleaned into a rack the engine and the cards can take: unknown
// module types and cables to ports that no longer exist are dropped.
export function presetRack(preset) {
  const saved = preset || {};
  const seen = new Set();
  const modules = (Array.isArray(saved.modules) ? saved.modules : [])
    .map((m) => cleanModule(m, seen))
    .filter(Boolean);
  const byId = new Map(modules.map((m) => [m.id, m]));
  const cables = (Array.isArray(saved.cables) ? saved.cables : [])
    .map((c) => cleanCable(c, byId))
    .filter(Boolean);

  return {
    modules,
    cables,
    bpm: clamp(Number(saved.bpm) || 120, 40, 240),
    master: clamp(Number.isFinite(Number(saved.master)) ? Number(saved.master) : 1, 0, 1)
  };
}

// Swap a cleaned preset into the rack, with IDs that cannot collide with the
// modules the app already handed out.
export function adoptRack(rack) {
  app.state.modules = rack.modules;
  app.state.cables = rack.cables;
  app.state.bpm = rack.bpm;
  app.state.master = rack.master;
  noteIds(rack.modules, rack.cables);
}
