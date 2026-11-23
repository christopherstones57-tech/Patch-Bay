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

  // Fitting the card to the window --------------------------------------------
  //
  // The card is drawn at a size that fills a phone, and a wider window's fallback
  // font is wider again — so on a computer the name ran off the side, and the
  // line under it was pushed out of sight below. The card is measured and
  // scaled down until all of it is on screen, whatever size the window is.
  // The lines never wrap (css/app.css), so the measured width is the real one.
  const inner = card.querySelector('.splash-card');

  function fitCard() {
    if (!inner || !card.parentNode) return;
    inner.style.transform = '';
    let wide = 0;
    for (const line of inner.querySelectorAll('.splash-line')) {
      if (line.scrollWidth > wide) wide = line.scrollWidth;
    }
    const tall = inner.scrollHeight;
    if (!wide || !tall) return;
    const room = 24;
    const fit = Math.min(
      1,
      (window.innerWidth - room * 2) / wide,
      (window.innerHeight - room * 2) / tall
    );
    if (fit < 0.995) inner.style.transform = 'scale(' + fit.toFixed(3) + ')';
  }

  fitCard();
  window.addEventListener('resize', fitCard);
  window.addEventListener('load', fitCard);
  // A fallback font can land after the first layout, so measure once more.
  window.setTimeout(fitCard, 350);

  // The tune -----------------------------------------------------------------
  //
  // Five bell notes climbing to the octave, then the chord they came from: a
  // couple of seconds, small enough to be heard out on the way in. It is written
  // here rather than played through the synth because the sound has to be there
  // whatever the state of the rack.
  //
  // It is wanted as the card arrives, not only when the card is tapped, so it is
  // asked for at once. A browser will not start a page's sound before the page
  // has been touched, and leaves the context suspended until it is: the tune is
  // then played on the first tap or key, which is the same gesture that starts
  // the app itself. Either way it is heard once.
  //
  // Where it is heard from matters as much as when. It plays through the same
  // AudioContext as the synth whenever that one exists — js/main.js builds it in
  // the page's first gesture, before this file's own handler for that tap runs,
  // and leaves it on window.patchBayAudio to be found (see rackAudio). What used
  // to go wrong was a second context of the tune's own, made as the page loaded:
  // a phone keeps such a one suspended however often it is asked, so the card
  // was silent while the rack, on the context the tap built, played. One context
  // for the page means the tune leaves by the same route as everything else. A
  // tune asked for when there is no rack context yet — a browser that lets a
  // page play as it loads, or a tap that arrives before main.js has run — builds
  // one of its own, and it is thrown away if it never starts.
  const ARPEGGIO = [
    [0.0, 523.25, 0.55, 0.5],
    [0.1, 659.25, 0.55, 0.5],
    [0.2, 783.99, 0.6, 0.5],
    [0.3, 1046.5, 0.8, 0.55],
    [0.44, 1318.51, 0.6, 0.32]
  ];
  const CHORD = [261.63, 329.63, 392.0, 523.25];
  // One time through, from the first note to the chord's tail.
  const PASS = 2.4;

  let tuneCtx = null; // the context the tune plays through
  let tuneOwn = false; // true when this file built it, so it may close it
  let tuneOut = null; // the gain every note of the tune is joined to
  let tuneAir = null; // the filter the tune leaves its context by
  let tuneStarted = false;

  // The context js/main.js built for the rack, once it has. It is never closed
  // here: the synth plays on it.
  function rackAudio() {
    const ctx = window.patchBayAudio;
    if (!ctx || ctx.state === 'closed' || !ctx.destination) return null;
    return ctx;
  }

  // The tune is heard on the phone's media playback session rather than the
  // quiet ambient one a page's own Web Audio is given by default: the ambient
  // session follows the silent switch, so on a phone with the ring switch off
  // the tune was silent here while the rack itself — which asks for the session
  // in js/main.js and js/output-route.js — still played. This file is a plain
  // script, loaded before the modules, so it asks for the session itself.
  function claimPlaybackSession() {
    try {
      const session = typeof navigator === 'undefined' ? null : navigator.audioSession;
      if (session) session.type = 'playback';
    } catch (e) {
      /* no Audio Session API, or a browser that refuses the type */
    }
  }

  function tuneAudio() {
    if (tuneCtx && tuneCtx.state !== 'closed') return tuneCtx;
    // The rack's context when the tap has already built it, so the tune is heard
    // the way the synth is heard rather than on a context of its own.
    let ctx = rackAudio();
    let own = false;
    if (!ctx) {
      claimPlaybackSession();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      try {
        ctx = new Ctx();
      } catch (e) {
        return null;
      }
      own = true;
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
    tuneCtx = ctx;
    tuneOwn = own;
    tuneOut = master;
    tuneAir = air;
    return ctx;
  }

  // One note: a triangle for the body and a sine an octave up for the shimmer,
  // each with its own quick bloom and a decay that carries it away.
  function bell(start, freq, length, level) {
    const ctx = tuneCtx;
    if (!ctx || !tuneOut) return;
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
    body.connect(bodyGain).connect(tuneOut);
    sheen.connect(sheenGain).connect(tuneOut);
    body.start(start);
    body.stop(start + length + 0.06);
    sheen.start(start);
    sheen.stop(start + length * 0.55 + 0.06);
  }

  // One time through: the arpeggio, then the chord it came from.
  function playPass(start) {
    for (const note of ARPEGGIO) bell(start + note[0], note[1], note[2], note[3]);
    for (const freq of CHORD) bell(start + 0.66, freq, 1.5, 0.14);
  }

  function closeTune() {
    const ctx = tuneCtx;
    const own = tuneOwn;
    const master = tuneOut;
    const air = tuneAir;
    tuneCtx = null;
    tuneOwn = false;
    tuneOut = null;
    tuneAir = null;
    try {
      if (master) master.disconnect();
    } catch (e) {
      /* already gone */
    }
    try {
      if (air) air.disconnect();
    } catch (e) {
      /* already gone */
    }
    // The rack's context is the app's and is played on long after the tune: only
    // one this file built is closed.
    if (!own || !ctx) return;
    try {
      ctx.close();
    } catch (e) {
      /* already gone */
    }
  }

  function scheduleTune() {
    if (tuneStarted || !tuneCtx || tuneCtx.state !== 'running') return;
    tuneStarted = true;
    playPass(tuneCtx.currentTime + 0.05);
    // A card nobody touches stands there for six seconds, so the tune goes round
    // a second time; a card on its way out takes the tune with it.
    window.setTimeout(() => {
      if (!tuneCtx || !card.parentNode) return;
      if (card.classList.contains('splash-out')) return;
      playPass(tuneCtx.currentTime + 0.05);
    }, PASS * 1000);
    // The last tail has run out long before this, so the context closes itself
    // rather than being left running behind the app.
    window.setTimeout(closeTune, (PASS * 2 + 1.6) * 1000);
  }

  // Play as soon as the context says it is running. One built inside the tap
  // starts at once and is heard straight away; the rack's, which the same tap has
  // just asked main.js to start, says so a moment later.
  function whenRunning(ctx, play) {
    if (!ctx) return;
    if (ctx.state === 'running') {
      play();
      return;
    }
    if (!ctx.addEventListener) return;
    let answered = false;
    const onState = () => {
      if (answered || ctx.state !== 'running') return;
      answered = true;
      ctx.removeEventListener('statechange', onState);
      if (tuneCtx === ctx) play();
    };
    ctx.addEventListener('statechange', onState);
    // Asking again is what a browser waiting for the gesture answers, and it
    // costs nothing where the context is already on its way up.
    try {
      const asked = ctx.resume && ctx.resume();
      if (asked && asked.catch) asked.catch(() => {});
    } catch (e) {
      /* the statechange listener above is the only answer left */
    }
    // Nothing came of it: stop listening, and let the next gesture have it.
    window.setTimeout(() => {
      if (answered) return;
      answered = true;
      ctx.removeEventListener('statechange', onState);
    }, 4000);
  }

  function startTune() {
    if (tuneStarted || !card.parentNode) return;
    if (card.classList.contains('splash-out')) return;
    claimPlaybackSession();
    // A context of this file's own that the browser never started is thrown away
    // rather than asked again: a phone can keep one made before the page was
    // touched suspended however often it is asked. Built here, inside the tap, it
    // is one the browser will start — or, with main.js already up, the tune
    // simply takes the rack's (see tuneAudio).
    if (tuneCtx && tuneOwn && tuneCtx.state !== 'running') closeTune();

    if (!tuneCtx || tuneCtx.state === 'closed') tuneAudio();
    if (!tuneCtx) return;
    whenRunning(tuneCtx, scheduleTune);
  }

  startTune();
  // The card's own tap and the first key both count as the gesture that lets the
  // page make a sound, so both are listened for until the tune is heard.
  window.addEventListener('pointerdown', startTune);
  window.addEventListener('keydown', startTune);

  // Away with it --------------------------------------------------------------
  let gone = false;

  function dismiss() {
    if (gone) return;
    gone = true;
    // The tune has had its chance: the page needs no more of these gestures.
    window.removeEventListener('pointerdown', startTune);
    window.removeEventListener('keydown', startTune);
    // A context that never got to play is closed rather than left suspended.
    if (!tuneStarted) window.setTimeout(closeTune, 0);
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
    // The tune is asked for as the card arrives, so it is usually already
    // playing; if the browser held it back until the page was touched, this tap
    // is what lets it out.
    startTune();
    // The tune plays on over the rack: the card starts fading as the last note
    // lands rather than holding the app back for the whole of it.
    window.setTimeout(dismiss, 950);
  }

  card.addEventListener('pointerdown', begin);
  document.addEventListener('keydown', begin, { once: true });

  // Nobody touched it: a title card should never be a door that will not open, so
  // it stands aside by itself. A browser that will not start the tune without a
  // touch simply never hears it, and css/app.css has the same last resort in case
  // this file never loads at all.
  window.setTimeout(dismiss, 6000);
})();
