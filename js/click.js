// The click track -------------------------------------------------------------
//
// A click the player records to: a bar of count-in before a take, and the beat
// kept under it while it runs. What is heard here is a sound in the room and
// never part of the song. The click's own oscillator plays straight into the
// page's output, past the rack's graph, the master and the voice bus, so no mix,
// an export or a song file can contain it; an export renders in a context of its
// own, where this node is never made at all.
//
// Beats are counted from the take's downbeat: beat 0 is where the take really
// starts, and the count-in is the bar before it, at -1, -2, -3, -4. The player
// hears the bar counted in and plays on the downbeat, which is the moment the
// recorded notes and a lyric take begin.

import { app } from './app.js?v=13';

// One bar of 4/4: the shortest count-in that still says where the beat is.
export const COUNT_IN_BEATS = 4;

const CLICK_LEVEL = 0.32;
const LOOKAHEAD = 0.2; // seconds scheduled ahead of the clock
const PUMP_MS = 50; // how often the scheduler looks ahead again
const ACCENT_EVERY = 4; // the first beat of the bar is the loud one
const HIGH_HZ = 1760; // the accented click
const LOW_HZ = 990; // the other three

let metronome = null;
let out = null;
let outCtx = null;

// Where the click leaves the page: the same destination the synth plays into,
// and never a point anything else listens to.
function clickOutput(ctx) {
  if (outCtx !== ctx || !out) {
    try {
      if (out) out.disconnect();
    } catch (e) {
      /* already gone */
    }
    out = ctx.createGain();
    out.gain.value = 1;
    out.connect(app.output || ctx.destination);
    outCtx = ctx;
  }
  return out;
}

// One click: a short sine that is gone in fifty milliseconds. It is scheduled
// ahead of time, so the beat stays exact however busy the page is.
function blip(ctx, dest, time, accent) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const at = Math.max(time, ctx.currentTime);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(accent ? HIGH_HZ : LOW_HZ, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(CLICK_LEVEL, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(at);
  osc.stop(at + 0.07);
  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch (e) {
      /* already gone */
    }
  };
}

function clampTempo(bpm) {
  const n = Number(bpm);
  const tempo = Number.isFinite(n) && n > 0 ? n : Number(app.state.bpm) || 120;
  return Math.min(240, Math.max(40, tempo));
}

// Start a click at `from` on the context's clock: `countIn` beats ahead of it,
// and — with `keepGoing` — the beat on from there until stopClick(). A count-in
// on its own stops before the downbeat, so nothing lands on a take that has
// begun. Returns null when there is no clock to click on.
export function startClick({ from, countIn = COUNT_IN_BEATS, keepGoing = true, bpm } = {}) {
  stopClick();

  const ctx = app.ctx;
  if (!ctx) return null;

  const spb = 60 / clampTempo(bpm);
  const start = Number.isFinite(from) ? from : ctx.currentTime + 0.12;
  const lead = Math.max(0, Math.round(Number(countIn) || 0));

  const state = {
    ctx,
    dest: clickOutput(ctx),
    spb,
    start,
    index: -lead,
    next: start - lead * spb,
    keepGoing: keepGoing !== false,
    timer: null,
    done: false
  };

  // A count-in asked for at the downbeat itself has nothing left to count.
  if (!state.keepGoing && state.index >= 0) return null;

  const finish = () => {
    if (state.done) return;
    state.done = true;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (metronome === state) metronome = null;
  };

  const pump = () => {
    if (metronome !== state || state.done) return;
    const now = ctx.currentTime;
    // A page that sat in the background for a while must not fire the beats it
    // missed all at once; the click picks up at the next beat instead.
    if (state.next < now - 0.5) {
      const skipped = Math.ceil((now - state.next) / state.spb);
      state.index += skipped;
      state.next += skipped * state.spb;
    }
    while (state.next < now + LOOKAHEAD) {
      // A count-in on its own ends before the take starts.
      if (!state.keepGoing && state.index >= 0) {
        finish();
        return;
      }
      blip(ctx, state.dest, state.next, state.index % ACCENT_EVERY === 0);
      state.index++;
      state.next += state.spb;
    }
  };

  metronome = state;
  state.stop = finish;
  pump();
  if (!state.done) state.timer = setInterval(pump, PUMP_MS);
  return state;
}

export function stopClick() {
  const state = metronome;
  metronome = null;
  if (state) state.stop();
}
