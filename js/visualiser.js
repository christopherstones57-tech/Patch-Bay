// A full-screen audio visualiser: a ring of spectrum bars around a beating
// core, the waveform drawn as a glowing ring, and particles thrown out on every
// kick of the bass. It listens to the master output of the live engine, so it
// shows whatever the rack — or the demo tune — is playing.

import { app } from './app.js?v=12';
import { mountKeybed, shiftKeyboardOctave } from './keyboard.js?v=12';
import { voiceBus } from './voices.js?v=12';

const BARS = 64;
const MAX_PARTICLES = 90;

let overlay = null;
let canvas = null;
let g = null;
let infoEl = null;

let open = false;
let raf = 0;
let lastT = 0;
let dpr = 1;
let cw = 0;
let ch = 0;

let analyser = null;
let analyserEngine = null;
let analyserSink = null;
let analyserBus = null;
let freq = null;
let wave = null;

const particles = [];

let bass = 0;
let bassAvg = 0;
let beat = 0;
let hue = 200;
let caption = 'Live audio';

function dropAnalyser() {
  // The two sources feed the analyser, so they are the ones that let go of it: a
  // discarded analyser left connected would go on being driven for nothing.
  if (analyserEngine && analyserEngine.limiter) {
    try {
      analyserEngine.limiter.disconnect(analyser);
    } catch (e) {
      /* already gone */
    }
  }
  if (analyserBus) {
    try {
      analyserBus.disconnect(analyser);
    } catch (e) {
      /* already gone */
    }
  }
  if (analyser) {
    try {
      analyser.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
  if (analyserSink) {
    try {
      analyserSink.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
  analyser = null;
  analyserSink = null;
  analyserEngine = null;
  analyserBus = null;
  freq = null;
  wave = null;
}

// One analyser per engine. It hangs off the master limiter through a silent
// gain, so it has a path to the speakers (an analyser with none may never run)
// and adds nothing to what is heard. It reads before the volume knob, so the
// picture is of the patch rather than of the knob.
function ensureAnalyser() {
  const engine = app.engine;
  if (!engine || !app.ctx) {
    if (analyser) dropAnalyser();
    return null;
  }
  if (analyser && analyserEngine === engine) return analyser;

  dropAnalyser();
  analyser = app.ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.82;
  freq = new Uint8Array(analyser.frequencyBinCount);
  wave = new Uint8Array(analyser.fftSize);

  analyserSink = app.ctx.createGain();
  analyserSink.gain.value = 0;
  try {
    engine.limiter.connect(analyser);
    // A recorded channel plays through its own engine, summed on the voice bus,
    // so that bus is read too: Play shows the song, not an empty rack.
    const bus = voiceBus();
    if (bus) {
      bus.connect(analyser);
      analyserBus = bus;
    }
    analyser.connect(analyserSink);
    analyserSink.connect(app.ctx.destination);
  } catch (e) {
    /* a closed context simply shows the idle animation */
  }
  analyserEngine = engine;
  return analyser;
}

function resize() {
  if (!canvas || !g) return;
  const wide = Math.max(1, Math.round(canvas.clientWidth));
  const tall = Math.max(1, Math.round(canvas.clientHeight));
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = wide;
  ch = tall;
  canvas.width = Math.max(1, Math.round(wide * dpr));
  canvas.height = Math.max(1, Math.round(tall * dpr));
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawnParticles(count, power, size, cx, cy, base) {
  for (let n = 0; n < count && particles.length < MAX_PARTICLES; n++) {
    const angle = Math.random() * Math.PI * 2;
    particles.push({
      a: angle,
      r: base * (0.55 + Math.random() * 0.2),
      vr: 25 + Math.random() * 70 + power * 170,
      drift: (Math.random() - 0.5) * 0.7,
      x: cx,
      y: cy,
      size: 1 + Math.random() * 2.4,
      life: 1,
      ttl: 0.9 + Math.random() * 1.7,
      hue: (hue + Math.random() * 90) % 360
    });
  }
}

function drawFrame(now) {
  if (!g || !cw || !ch) return;

  const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016);
  lastT = now;

  const a = ensureAnalyser();
  let energy = 0;
  let bassRaw = 0;

  if (a) {
    a.getByteFrequencyData(freq);
    a.getByteTimeDomainData(wave);
    const n = freq.length;
    const low = Math.max(1, Math.floor(n * 0.055));
    let sum = 0;
    let lowSum = 0;
    for (let i = 0; i < n; i++) {
      const v = freq[i] / 255;
      sum += v;
      if (i < low) lowSum += v;
    }
    energy = sum / n;
    bassRaw = lowSum / low;
  } else {
    // Nothing to listen to yet: a soft pulse so the screen is never dead.
    energy = 0.1 + 0.05 * Math.sin(now / 900);
    bassRaw = 0.08 + 0.05 * Math.sin(now / 700);
  }

  bass += (bassRaw - bass) * Math.min(1, dt * 10);
  bassAvg += (bass - bassAvg) * Math.min(1, dt * 1.8);
  if (bass - bassAvg > 0.05) beat = 1;
  beat = Math.max(0, beat - dt * 3);

  hue = (hue + dt * (18 + bass * 120 + beat * 60)) % 360;

  // A trail rather than a clear, so rings and particles leave a glow behind.
  g.fillStyle = 'rgba(3, 5, 10, 0.34)';
  g.fillRect(0, 0, cw, ch);

  const cx = cw / 2;
  const cy = ch / 2;
  const size = Math.min(cw, ch);
  const base = size * 0.16;
  const maxLen = size * 0.34;
  const spin = now / 20000;

  // A wash of colour behind everything, brightening with the music.
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.78);
  glow.addColorStop(0, `hsla(${hue}, 90%, 60%, ${0.1 + bass * 0.24})`);
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, cw, ch);

  // Spectrum bars all the way round, mirrored so both halves answer together.
  g.lineCap = 'round';
  const total = BARS * 2;
  for (let i = 0; i < total; i++) {
    const k = i < BARS ? i : total - 1 - i;
    const t = k / (BARS - 1);
    const idx = a
      ? Math.min(freq.length - 1, Math.floor(Math.pow(t, 1.7) * freq.length * 0.5))
      : 0;
    const v = a ? freq[idx] / 255 : 0.12 + 0.06 * Math.sin(now / 500 + k);
    const angle = (i / total) * Math.PI * 2 - Math.PI / 2 + spin;
    const r0 = base * 1.02;
    const r1 = r0 + 3 + v * maxLen;

    g.strokeStyle = `hsla(${(hue + t * 130) % 360}, 92%, ${55 + v * 25}%, ${0.25 + v * 0.75})`;
    g.lineWidth = 1.5 + v * 3;
    g.beginPath();
    g.moveTo(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0);
    g.lineTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
    g.stroke();
  }

  // The waveform, wrapped into a ring around the core.
  if (wave) {
    g.beginPath();
    const M = 240;
    for (let i = 0; i <= M; i++) {
      const p = i / M;
      const s =
        (wave[Math.min(wave.length - 1, Math.floor(p * wave.length))] - 128) / 128;
      const r =
        base * 0.82 + s * base * (0.23 + bass * 0.2);
      const ang = p * Math.PI * 2;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.strokeStyle = `hsla(${hue}, 95%, 72%, 0.85)`;
    g.lineWidth = 2;
    g.shadowBlur = 18;
    g.shadowColor = `hsla(${hue}, 95%, 60%, 0.9)`;
    g.stroke();
    g.shadowBlur = 0;
  }

  // The core: a soft disc that swells on the beat.
  const coreR = base * 0.75;
  const core = g.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  core.addColorStop(0, `hsla(${hue}, 95%, 70%, ${0.26 + beat * 0.22})`);
  core.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = core;
  g.beginPath();
  g.arc(cx, cy, coreR, 0, Math.PI * 2);
  g.fill();

  // A ring that flashes outward on each bass hit.
  if (beat > 0.02) {
    g.beginPath();
    g.arc(cx, cy, base * (1.2 + (1 - beat) * 0.6), 0, Math.PI * 2);
    g.strokeStyle = `hsla(${hue}, 95%, 65%, ${beat * 0.5})`;
    g.lineWidth = 1 + beat * 3;
    g.stroke();
  }

  // Particles.
  if (beat > 0.6) spawnParticles(Math.round(5 + bass * 18), bass, size, cx, cy, base);
  else if (energy > 0.3 && Math.random() < 0.35) spawnParticles(1, energy, size, cx, cy, base);

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.r += p.vr * dt * (0.6 + bass);
    p.a += p.drift * dt;
    p.life -= dt / p.ttl;
    if (p.life <= 0 || p.r > size * 0.95) {
      particles.splice(i, 1);
      continue;
    }
    const x = cx + Math.cos(p.a) * p.r;
    const y = cy + Math.sin(p.a) * p.r;
    g.globalAlpha = Math.max(0, p.life) * 0.85;
    g.fillStyle = `hsl(${p.hue}, 95%, ${60 + p.life * 20}%)`;
    g.beginPath();
    g.arc(x, y, p.size * (0.5 + p.life), 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  if (!open) return;
  drawFrame(now);
}

export function setVisualiserCaption(text) {
  caption = String(text || 'Live audio');
  if (infoEl) infoEl.textContent = caption;
}

export function initVisualiser() {
  overlay = document.getElementById('visualiser');
  canvas = document.getElementById('visualiser-canvas');
  infoEl = document.getElementById('visualiser-info');
  if (!overlay || !canvas) return;

  g = canvas.getContext('2d');
  setVisualiserCaption(caption);

  // The visualiser carries its own keyboard, so a patch can be played while the
  // picture runs. It is the transport's keybed, mounted a second time: same
  // notes, same octave, same highlight.
  mountKeybed(document.getElementById('visualiser-keys'));
  const octDown = document.getElementById('visualiser-oct-down');
  const octUp = document.getElementById('visualiser-oct-up');
  if (octDown) octDown.addEventListener('click', () => shiftKeyboardOctave(-12));
  if (octUp) octUp.addEventListener('click', () => shiftKeyboardOctave(12));

  const close = document.getElementById('visualiser-close');
  if (close) close.addEventListener('click', closeVisualiser);

  window.addEventListener('resize', () => {
    if (open) resize();
  });
}

export function openVisualiser() {
  if (!overlay || open) return;
  open = true;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  ensureAnalyser();
  resize();
  // The rotated layout needs a frame before the canvas has its real size.
  requestAnimationFrame(() => {
    if (open) resize();
  });
  lastT = 0;
  if (!raf) raf = requestAnimationFrame(frame);
}

export function closeVisualiser() {
  if (!overlay || !open) return;
  open = false;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  dropAnalyser();
  particles.length = 0;
}
