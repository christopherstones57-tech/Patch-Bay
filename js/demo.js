// The demo tunes --------------------------------------------------------------
//
// Five medium-length pieces, each written for a rack of its own, so the demo
// selector is also a tour of what the synth can be: a resonant lead with a
// delay, a wide pad through chorus and a long reverb, a chiptune with a short
// slap, a driven bass, and a plucked string in a big room. Each tune plays the
// rack it brings; loading one puts that rack in the app first.
//
// A tune is monophonic — one note at a time, as the oscillators are — laid out
// one bar at a time: each bar is a list of [beat in the bar, MIDI note, length
// in beats].

const BEATS_PER_BAR = 4;

// Turn per-bar lists into the note events the transport plays.
function notesFromBars(bars, bpm) {
  const beat = 60 / bpm;
  const barLength = beat * BEATS_PER_BAR;
  const events = [];
  bars.forEach((bar, barIndex) => {
    for (const [startBeat, midi, durBeats, vel] of bar) {
      const start = barIndex * barLength + startBeat * beat;
      events.push({
        midi,
        start,
        end: start + durBeats * beat,
        vel: vel == null ? (startBeat === 0 ? 0.92 : 0.8) : vel
      });
    }
  });
  return events;
}

// Eight even notes to the bar: the shape of a chip arpeggio or a plucked run.
function eighths(midis) {
  return midis.map((midi, i) => [i * 0.5, midi, 0.44]);
}

// One bar of a driving bass riff on a root note.
function bassBar(root) {
  return [
    [0, root, 0.45],
    [0.5, root, 0.45],
    [1, root + 12, 0.45],
    [1.5, root, 0.45],
    [2, root, 0.45],
    [2.5, root + 7, 0.45],
    [3, root + 3, 0.45],
    [3.5, root + 5, 0.45]
  ];
}

// 1 — Neon lead ---------------------------------------------------------------
// The original demo: an A minor line for a saw through a resonant filter,
// envelope and delay.

const LEAD_BPM = 112;
const LEAD_BARS = [
  // 1 — Am
  [[0, 76, 1.5], [1.5, 74, 0.5], [2, 72, 1], [3, 71, 1]],
  // 2 — F
  [[0, 69, 1], [1, 72, 1], [2, 76, 1.5], [3.5, 74, 0.5]],
  // 3 — C
  [[0, 67, 1], [1, 72, 1], [2, 76, 1], [3, 79, 1]],
  // 4 — G
  [[0, 74, 1.5], [1.5, 71, 0.5], [2, 67, 2]],
  // 5 — Am
  [[0, 72, 0.5], [0.5, 74, 0.5], [1, 76, 1], [2, 79, 1], [3, 76, 1]],
  // 6 — F
  [[0, 77, 1], [1, 76, 1], [2, 72, 1], [3, 69, 1]],
  // 7 — C
  [[0, 72, 0.5], [0.5, 74, 0.5], [1, 76, 1], [2, 79, 2]],
  // 8 — G
  [[0, 74, 1], [1, 71, 1], [2, 67, 1], [3, 62, 1]],
  // 9 — Am, the theme again
  [[0, 76, 1.5], [1.5, 74, 0.5], [2, 72, 1], [3, 71, 1]],
  // 10 — F
  [[0, 69, 1], [1, 72, 1], [2, 76, 1.5], [3.5, 74, 0.5]],
  // 11 — C
  [[0, 67, 1], [1, 72, 1], [2, 76, 1], [3, 79, 1]],
  // 12 — G
  [[0, 74, 1.5], [1.5, 71, 0.5], [2, 67, 2]],
  // 13 — Am, reaching higher
  [[0, 72, 0.5], [0.5, 74, 0.5], [1, 76, 1], [2, 76, 0.5], [2.5, 79, 0.5], [3, 81, 1]],
  // 14 — F
  [[0, 81, 1], [1, 79, 1], [2, 76, 1], [3, 72, 1]],
  // 15 — C
  [[0, 76, 0.5], [0.5, 79, 0.5], [1, 84, 1], [2, 81, 1], [3, 79, 1]],
  // 16 — G, ending on the root
  [[0, 77, 1], [1, 74, 1], [2, 72, 1], [3, 69, 1.6]]
];

// 2 — Velvet pad --------------------------------------------------------------
// Slow D minor swells for a seven-voice super saw through a soft filter, chorus
// and a long reverb. Long notes, so the envelope's release carries each into the
// next.

const PAD_BPM = 84;
const PAD_BARS = [
  [[0, 62, 4]], // Dm
  [[0, 65, 4]], // F
  [[0, 69, 2], [2, 67, 2]], // Am
  [[0, 65, 4]], // F
  [[0, 62, 2], [2, 65, 2]], // Bb
  [[0, 74, 4]], // D
  [[0, 64, 2], [2, 67, 2]], // C
  [[0, 72, 4]], // C
  [[0, 57, 2], [2, 62, 2]], // Dm
  [[0, 65, 4]], // F
  [[0, 64, 2], [2, 67, 2]], // C
  [[0, 62, 4]] // Dm
];

// 3 — Arcade run --------------------------------------------------------------
// A chip pulse with its octave-down square, a bright filter and a short slap,
// running eight notes to the bar through C major.

const CHIP_BPM = 142;
const CHIP_BARS = [
  eighths([72, 76, 79, 76, 84, 79, 76, 72]), // C
  eighths([69, 72, 76, 79, 81, 79, 76, 72]), // Am
  eighths([65, 69, 72, 77, 76, 72, 69, 65]), // F
  eighths([67, 71, 74, 79, 77, 74, 71, 67]), // G
  eighths([72, 76, 79, 84, 88, 84, 79, 76]), // C, up an octave
  eighths([81, 79, 76, 72, 69, 72, 76, 79]), // Am
  eighths([84, 81, 79, 76, 72, 76, 79, 81]), // F
  eighths([74, 71, 67, 62, 67, 71, 74, 79]), // G
  eighths([72, 76, 79, 76, 84, 79, 76, 72]), // C
  eighths([69, 72, 76, 79, 81, 79, 76, 72]), // Am
  eighths([65, 69, 72, 77, 76, 72, 69, 65]), // F
  eighths([67, 71, 74, 79, 77, 74, 71, 67]), // G
  eighths([84, 84, 79, 79, 88, 88, 84, 84]), // C, the high answer
  eighths([81, 79, 77, 76, 74, 72, 71, 69]), // Am
  eighths([72, 76, 79, 84, 79, 76, 72, 67]), // F
  [[0, 60, 4]] // C, home
];

// 4 — Rubber bass -------------------------------------------------------------
// A square an octave down through a tight resonant filter and a dose of drive:
// a riff that walks the bar and pops an octave on the second beat.

const BASS_BPM = 104;
const BASS_BARS = [
  bassBar(52), bassBar(52), bassBar(52), bassBar(52), // Em
  bassBar(48), bassBar(48), bassBar(48), bassBar(48), // C
  bassBar(55), bassBar(55), bassBar(55), bassBar(55), // G
  bassBar(50), bassBar(50), bassBar(50), bassBar(52) // D, then back to Em
];

// 5 — Plucked garden ----------------------------------------------------------
// A Karplus-Strong string run through a slow delay and a big warm room, in D
// major: bright arpeggios that let the delay answer them.

const PLUCK_BPM = 96;
const PLUCK_BARS = [
  eighths([62, 66, 69, 74, 69, 66, 62, 66]), // D
  eighths([57, 61, 64, 69, 64, 61, 57, 61]), // A
  eighths([59, 62, 66, 71, 66, 62, 59, 62]), // Bm
  eighths([55, 59, 62, 67, 62, 59, 55, 59]), // G
  eighths([62, 66, 69, 74, 78, 74, 69, 66]), // D
  eighths([57, 61, 64, 69, 73, 69, 64, 61]), // A
  eighths([59, 62, 66, 71, 74, 71, 66, 62]), // Bm
  eighths([55, 59, 62, 67, 71, 67, 62, 59]), // G
  eighths([74, 69, 66, 62, 69, 74, 78, 81]), // D, rising
  eighths([69, 64, 61, 57, 64, 69, 73, 76]), // A
  eighths([71, 66, 62, 59, 66, 71, 74, 78]), // Bm
  eighths([67, 62, 59, 55, 62, 67, 71, 74]), // G
  eighths([62, 66, 69, 74, 69, 66, 62, 69]), // D
  eighths([57, 61, 64, 69, 64, 61, 57, 64]), // A
  eighths([59, 62, 66, 71, 66, 62, 59, 66]), // Bm
  [[0, 74, 2], [2, 69, 2]] // D, settling
];

// The racks -------------------------------------------------------------------

function leadRack() {
  return {
    bpm: LEAD_BPM,
    master: 1,
    modules: [
      { id: 'm1', type: 'vco', x: 20, y: 30, params: { wave: 'sawtooth', level: 0.8, pitchAmt: 1 } },
      { id: 'm2', type: 'vcf', x: 250, y: 30, params: { type: 'lowpass', cutoff: 1800, res: 6, cv: 0.45 } },
      { id: 'm3', type: 'vca', x: 480, y: 30, params: { level: 0, cv: 1 } },
      { id: 'm4', type: 'adsr', x: 20, y: 350, params: { attack: 0.01, decay: 0.35, sustain: 0.55, release: 0.45 } },
      { id: 'm5', type: 'lfo', x: 250, y: 350, params: { shape: 'sine', rate: 4.6, depth: 0.22 } },
      { id: 'm6', type: 'delay', x: 480, y: 350, params: { time: 0.28, feedback: 0.32, mix: 0.28 } },
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
  };
}

function padRack() {
  return {
    bpm: PAD_BPM,
    master: 1,
    modules: [
      { id: 'm1', type: 'supersaw', x: 20, y: 30, params: { voices: 7, detune: 0.5, level: 0.5, pitchAmt: 1 } },
      { id: 'm2', type: 'vcf', x: 250, y: 30, params: { type: 'lowpass', cutoff: 1500, res: 3, cv: 0.3 } },
      { id: 'm3', type: 'vca', x: 480, y: 30, params: { level: 0, cv: 1 } },
      { id: 'm4', type: 'adsr', x: 20, y: 350, params: { attack: 1.3, decay: 1.6, sustain: 0.85, release: 2.6 } },
      { id: 'm5', type: 'lfo', x: 250, y: 350, params: { shape: 'sine', rate: 0.12, depth: 0.45 } },
      { id: 'm6', type: 'chorus', x: 480, y: 350, params: { rate: 0.35, depth: 0.6, mix: 0.45 } },
      { id: 'm7', type: 'reverb', x: 20, y: 670, params: { size: 5.2, mix: 0.5 } },
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
  };
}

function chipRack() {
  return {
    bpm: CHIP_BPM,
    master: 1,
    modules: [
      { id: 'm1', type: 'chip', x: 20, y: 30, params: { width: 0.3, sub: 0.45, level: 0.33, pitchAmt: 1 } },
      { id: 'm2', type: 'vcf', x: 250, y: 30, params: { type: 'lowpass', cutoff: 3200, res: 4, cv: 0.2 } },
      { id: 'm3', type: 'vca', x: 480, y: 30, params: { level: 0, cv: 1 } },
      { id: 'm4', type: 'adsr', x: 20, y: 350, params: { attack: 0.004, decay: 0.12, sustain: 0.5, release: 0.12 } },
      { id: 'm5', type: 'delay', x: 250, y: 350, params: { time: 0.12, feedback: 0.22, mix: 0.16 } },
      { id: 'm6', type: 'output', x: 480, y: 350, params: { level: 1 } }
    ],
    cables: [
      { id: 'c1', from: { id: 'm1', port: 'out' }, to: { id: 'm2', port: 'in' } },
      { id: 'c2', from: { id: 'm2', port: 'out' }, to: { id: 'm3', port: 'in' } },
      { id: 'c3', from: { id: 'm3', port: 'out' }, to: { id: 'm5', port: 'in' } },
      { id: 'c4', from: { id: 'm5', port: 'out' }, to: { id: 'm6', port: 'in' } },
      { id: 'c5', from: { id: 'm4', port: 'cv' }, to: { id: 'm3', port: 'cv' } }
    ]
  };
}

function bassRack() {
  return {
    bpm: BASS_BPM,
    master: 1,
    modules: [
      { id: 'm1', type: 'vco', x: 20, y: 30, params: { wave: 'square', octave: -1, level: 0.85, pitchAmt: 1 } },
      { id: 'm2', type: 'vcf', x: 250, y: 30, params: { type: 'lowpass', cutoff: 340, res: 18, cv: 0.55 } },
      { id: 'm3', type: 'vca', x: 480, y: 30, params: { level: 0, cv: 1 } },
      { id: 'm4', type: 'adsr', x: 20, y: 350, params: { attack: 0.004, decay: 0.18, sustain: 0.14, release: 0.1 } },
      { id: 'm5', type: 'drive', x: 250, y: 350, params: { drive: 9, tone: 1400, level: 0.65 } },
      { id: 'm6', type: 'output', x: 480, y: 350, params: { level: 1 } }
    ],
    cables: [
      { id: 'c1', from: { id: 'm1', port: 'out' }, to: { id: 'm2', port: 'in' } },
      { id: 'c2', from: { id: 'm2', port: 'out' }, to: { id: 'm3', port: 'in' } },
      { id: 'c3', from: { id: 'm3', port: 'out' }, to: { id: 'm5', port: 'in' } },
      { id: 'c4', from: { id: 'm5', port: 'out' }, to: { id: 'm6', port: 'in' } },
      { id: 'c5', from: { id: 'm4', port: 'cv' }, to: { id: 'm3', port: 'cv' } }
    ]
  };
}

function pluckRack() {
  return {
    bpm: PLUCK_BPM,
    master: 1,
    modules: [
      { id: 'm1', type: 'pluck', x: 20, y: 30, params: { decay: 2.2, damp: 0.45, pick: 0.02, level: 0.9 } },
      { id: 'm2', type: 'vcf', x: 250, y: 30, params: { type: 'lowpass', cutoff: 2600, res: 1.5, cv: 0 } },
      { id: 'm3', type: 'delay', x: 480, y: 30, params: { time: 0.42, feedback: 0.45, mix: 0.32 } },
      { id: 'm4', type: 'reverb', x: 20, y: 350, params: { size: 4.2, mix: 0.42 } },
      { id: 'm5', type: 'output', x: 250, y: 350, params: { level: 1 } }
    ],
    cables: [
      { id: 'c1', from: { id: 'm1', port: 'out' }, to: { id: 'm2', port: 'in' } },
      { id: 'c2', from: { id: 'm2', port: 'out' }, to: { id: 'm3', port: 'in' } },
      { id: 'c3', from: { id: 'm3', port: 'out' }, to: { id: 'm4', port: 'in' } },
      { id: 'c4', from: { id: 'm4', port: 'out' }, to: { id: 'm5', port: 'in' } }
    ]
  };
}

// The tunes, in the order the selector lists them.
export const DEMO_TUNES = [
  {
    id: 'neon-lead',
    name: 'Neon lead',
    description: 'Saw through a resonant filter into a delay — an A minor line with a slow wobble',
    hue: 205,
    rack: leadRack(),
    notes: notesFromBars(LEAD_BARS, LEAD_BPM)
  },
  {
    id: 'velvet-pad',
    name: 'Velvet pad',
    description: 'Seven-voice super saw, slow swell, chorus and a long reverb — D minor swells',
    hue: 195,
    rack: padRack(),
    notes: notesFromBars(PAD_BARS, PAD_BPM)
  },
  {
    id: 'arcade-run',
    name: 'Arcade run',
    description: 'Chip pulse with an octave-down square and a short slap — eight notes to the bar',
    hue: 150,
    rack: chipRack(),
    notes: notesFromBars(CHIP_BARS, CHIP_BPM)
  },
  {
    id: 'rubber-bass',
    name: 'Rubber bass',
    description: 'Square an octave down through a tight filter and drive — a riff in E minor',
    hue: 15,
    rack: bassRack(),
    notes: notesFromBars(BASS_BARS, BASS_BPM)
  },
  {
    id: 'plucked-garden',
    name: 'Plucked garden',
    description: 'Karplus-Strong strings with a slow delay and a big room — arpeggios in D major',
    hue: 85,
    rack: pluckRack(),
    notes: notesFromBars(PLUCK_BARS, PLUCK_BPM)
  }
];

// The first tune, for anything that still asks for "the demo tune".
export const DEMO_TUNE = DEMO_TUNES[0].notes;
export const DEMO_LENGTH = DEMO_TUNES[0].notes.reduce(
  (end, ev) => Math.max(end, ev.end == null ? ev.start : ev.end),
  0
);
