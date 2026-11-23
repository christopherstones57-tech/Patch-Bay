// The card that stands in front of the app while the rack is built: the maker's
// name in big coloured letters, a starburst turning behind it, and a little tune
// when it is tapped.
//
// A plain script rather than a module, so it runs before js/main.js has fetched
// and built the whole synth: the card is on screen from the first frame. It owns
// the card completely — it colours the letters, plays the tune and takes the card
// away. The first tap on it is also the one js/main.js listens for to start the
// app's own audio, since a browser only lets a page make a sound after a gesture.
(function () {
  'use strict';

  const card = document.getElementById('splash');
  if (!card) return;

  // Letters ------------------------------------------------------------------
  //
  // Every letter is a span of its own so it can carry its own colour and arrive
  // on its own beat. The hue walks the spectrum across the words, which is what
  // makes the name read as a rainbow rather than one flat colour; the 3D itself
  // is the stack of shadows on each letter, in css/app.css.
  let step = 0;
  let hue = 292;
  for (const line of card.querySelectorAll('.splash-line')) {
    const text = line.textContent;
    line.textContent = '';
    for (const ch of text) {
      const glyph = ch === ' ' ? '\u00a0' : ch;
      const letter = document.createElement('span');
      letter.className = 'splash-letter';
      letter.textContent = glyph;
      letter.dataset.ch = glyph;
      letter.style.setProperty('--h', String(Math.round(hue % 360)));
      letter.style.setProperty('--i', String(step));
      line.appendChild(letter);
      hue += 23;
      step += 1;
    }
  }

  // The tune -----------------------------------------------------------------
  //
  // Five bell notes climbing to the octave, then the chord they came from: a
  // couple of seconds, small enough to be heard out on the way in. It is written
  // here rather than played through the synth because the rack's engine is still
  // being built while the card is up.
  const ARPEGGIO = [
    [0.0, 523.25, 0.55, 0.5],
    [0.1, 659.25, 0.55, 0.5],
    [0.2, 783.99, 0.6, 0.5],
    [0.3, 1046.5, 0.8, 0.55],
    [0.44, 1318.51, 0.6, 0.32]
  ];
  const CHORD = [261.63, 329.63, 392.0, 523.25];

  function playTune() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    let ctx = null;
    try {
      ctx = new Ctx();
    } catch (e) {
      return;
    }
    if (ctx.state === 'suspended' && ctx.resume) {
      // It is made inside the tap, so this is allowed; the catch is for the
      // browser that says no anyway.
      try {
        ctx.resume().catch(() => {});
      } catch (e) {
        /* silent, the notes below simply stay unheard */
      }
    }

    const master = ctx.createGain();
    master.gain.value = 0.3;
    // A little air off the top, so the bells are sweet rather than piercing.
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 5200;
    air.Q.value = 0.4;
    master.connect(air);
    air.connect(ctx.destination);

    // One note: a triangle for the body and a sine an octave up for the shimmer,
    // each with its own quick bloom and a decay that carries it away.
    const bell = (start, freq, length, level) => {
      const body = ctx.createOscillator();
      const sheen = ctx.createOscillator();
      const bodyGain = ctx.createGain();
      const sheenGain = ctx.createGain();
      body.type = 'triangle';
      body.frequency.setValueAtTime(freq, start);
      sheen.type = 'sine';
      sheen.frequency.setValueAtTime(freq * 2.005, start);
      bodyGain.gain.setValueAtTime(0.0001, start);
      bodyGain.gain.exponentialRampToValueAtTime(level, start + 0.012);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      sheenGain.gain.setValueAtTime(0.0001, start);
      sheenGain.gain.exponentialRampToValueAtTime(level * 0.3, start + 0.01);
      sheenGain.gain.exponentialRampToValueAtTime(0.0001, start + length * 0.55);
      body.connect(bodyGain).connect(master);
      sheen.connect(sheenGain).connect(master);
      body.start(start);
      body.stop(start + length + 0.06);
      sheen.start(start);
      sheen.stop(start + length * 0.55 + 0.06);
    };

    const t0 = ctx.currentTime + 0.03;
    for (const note of ARPEGGIO) bell(t0 + note[0], note[1], note[2], note[3]);
    for (const freq of CHORD) bell(t0 + 0.66, freq, 1.5, 0.14);

    // The card is long gone by the last note, so the context closes itself once
    // the tail has run out rather than being left running behind the app.
    window.setTimeout(() => {
      try {
        ctx.close();
      } catch (e) {
        /* already gone */
      }
    }, 3200);
  }

  // Away with it --------------------------------------------------------------
  let gone = false;

  function dismiss() {
    if (gone) return;
    gone = true;
    card.classList.add('splash-out');
    window.setTimeout(() => {
      if (card.parentNode) card.parentNode.removeChild(card);
      // js/main.js waits for this before showing its first hint, which would
      // otherwise be hidden behind the card.
      document.dispatchEvent(new Event('splash:done'));
    }, 700);
  }

  function begin() {
    if (gone) return;
    playTune();
    // The tune plays on over the rack: the card starts fading as the last note
    // lands rather than holding the app back for the whole of it.
    window.setTimeout(dismiss, 950);
  }

  card.addEventListener('pointerdown', begin);
  document.addEventListener('keydown', begin, { once: true });

  // Nobody touched it: a title card should never be a door that will not open, so
  // it stands aside by itself. Nothing is heard in that case — a browser only
  // makes a sound for a page after a tap — and css/app.css has the same last
  // resort in case this file never loads at all.
  window.setTimeout(dismiss, 6000);
})();
