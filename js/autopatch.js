// Automatic cable routing: the default signal flow is
//   sources -> VCF -> Comb -> Vowel -> Drive -> Crusher -> Wavefolder
//   -> Octaver -> EQ -> Compressor -> VCA -> Trance Gate -> Phaser -> Chorus
//   -> Delay -> Reverb -> Output
// with envelopes and LFOs wired into the VCA and filter, and the sequencer
// into the oscillator pitch. Ports sum, so several sources can share one input.

import { DEFS } from './modules.js?v=13';
import { app, addCable, removeAllCables } from './app.js?v=13';

const SOURCES = [
  'vco',
  'harmonic',
  'sync',
  'metal',
  'chip',
  'supersaw',
  'fmosc',
  'pulse',
  'wavetable',
  'vox',
  'noise',
  'sampler',
  'pluck',
  'drum',
  'zap',
  'riser',
  'clang',
  'boom',
  'blip',
  'ping',
  'siren',
  'whistle',
  'glass',
  'splash',
  'bounce',
  'sparkle',
  'thunder',
  'subdrop',
  'clap',
  'cowbell',
  'boing',
  'buzz',
  'tweet',
  'glitch',
  'bell',
  'marimba',
  'shaker',
  'tom',
  'crash',
  'chord',
  'downlifter'
];
const CHAIN = [
  'vcf',
  'comb',
  'vowel',
  'drive',
  'crusher',
  'folder',
  'octaver',
  'eq',
  'comp',
  'vca',
  'trance',
  'phaser',
  'chorus',
  'delay',
  'reverb',
  'output'
];

function hasPort(list, id) {
  return list.some((p) => p.id === id);
}

function byType(type) {
  return app.state.modules
    .filter((m) => m.type === type)
    .sort((a, b) => a.x - b.x);
}

export function autoPatch() {
  removeAllCables();
  const mods = app.state.modules;
  const sources = mods
    .filter((m) => SOURCES.includes(m.type))
    .sort((a, b) => a.x - b.x);
  const mixer = byType('mixer')[0];

  const chain = [];
  if (mixer) chain.push(mixer);
  for (const t of CHAIN) for (const m of byType(t)) chain.push(m);

  const firstIn = chain.find((m) => hasPort(DEFS[m.type].inputs, 'in'));

  if (mixer) {
    sources.forEach((s, i) => {
      addCable(s.id, 'out', mixer.id, 'in' + (1 + (i % 4)));
    });
  } else if (firstIn) {
    for (const s of sources) addCable(s.id, 'out', firstIn.id, 'in');
  }

  let prev = null;
  for (const m of chain) {
    if (prev && hasPort(DEFS[m.type].inputs, 'in')) {
      addCable(prev.id, 'out', m.id, 'in');
    }
    prev = hasPort(DEFS[m.type].outputs, 'out') ? m : null;
  }

  // Modulation -------------------------------------------------------------
  const vca = byType('vca')[0];
  const vcf = byType('vcf')[0];
  const adsrs = byType('adsr');
  const lfos = byType('lfo');
  const seq = byType('seq')[0];
  // Every oscillator in the rack follows the sequencer and the second LFO, so
  // adding another one plays in tune with the rest.
  const pitchTargets = mods.filter(
    (m) => SOURCES.includes(m.type) && DEFS[m.type] && hasPort(DEFS[m.type].inputs, 'pitch')
  );

  const cvTargets = [];
  if (vca) cvTargets.push({ mod: vca, port: 'cv' });
  if (vcf) cvTargets.push({ mod: vcf, port: 'cv' });

  if (adsrs[0] && cvTargets[0]) addCable(adsrs[0].id, 'cv', cvTargets[0].mod.id, cvTargets[0].port);
  if (adsrs[1] && vcf) addCable(adsrs[1].id, 'cv', vcf.id, 'cv');
  if (lfos[0] && vcf) addCable(lfos[0].id, 'cv', vcf.id, 'cv');
  if (lfos[1]) for (const m of pitchTargets) addCable(lfos[1].id, 'cv', m.id, 'pitch');
  if (seq) for (const m of pitchTargets) addCable(seq.id, 'pitch', m.id, 'pitch');
  if (seq && vca && !adsrs[0]) addCable(seq.id, 'trig', vca.id, 'cv');

  if (app.onCablesChanged) app.onCablesChanged();
}

// Wire a freshly added module into the patch without disturbing existing
// cables, so new modules make sound straight away.
export function autoConnectModule(mod) {
  const def = DEFS[mod.type];
  if (!def) return;
  const hasIn = hasPort(def.inputs, 'in');
  const hasOut = hasPort(def.outputs, 'out');

  // A module whose job is modulation — the sequencer, the Turing machine, the
  // arpeggiator — wires itself into every oscillator it can reach, and opens
  // the amplifier's gate when no envelope has claimed it.
  if (hasPort(def.outputs, 'pitch')) {
    for (const m of app.state.modules) {
      const d = DEFS[m.type];
      if (m.id === mod.id || !d || !hasPort(d.inputs, 'pitch')) continue;
      addCable(mod.id, 'pitch', m.id, 'pitch');
    }
  }
  if (hasPort(def.outputs, 'trig')) {
    const vca = byType('vca')[0];
    if (vca && !byType('adsr')[0]) addCable(mod.id, 'trig', vca.id, 'cv');
  }

  if (SOURCES.includes(mod.type)) {
    const target = app.state.modules.find(
      (m) => m.id !== mod.id && hasPort(DEFS[m.type].inputs, 'in') && m.type !== 'scope'
    );
    if (target) addCable(mod.id, 'out', target.id, 'in');
    return;
  }

  if (hasIn && hasOut) {
    const output = byType('output')[0];
    const intoOutput = output
      ? app.state.cables.find((c) => c.to.id === output.id && c.to.port === 'in')
      : null;
    if (output) {
      if (intoOutput) {
        const from = intoOutput.from;
        removeCableById(intoOutput.id);
        addCable(from.id, from.port, mod.id, 'in');
      }
      addCable(mod.id, 'out', output.id, 'in');
    } else {
      const vca = byType('vca')[0] || byType('vcf')[0];
      if (vca) addCable(mod.id, 'out', vca.id, 'in');
    }
    return;
  }

  if (hasIn) {
    const source = byType('vco')[0] || byType('sampler')[0] || byType('noise')[0];
    if (source) addCable(source.id, 'out', mod.id, 'in');
  }
}

function removeCableById(id) {
  const i = app.state.cables.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [cable] = app.state.cables.splice(i, 1);
  if (app.engine) app.engine.disconnectCable(cable);
}
