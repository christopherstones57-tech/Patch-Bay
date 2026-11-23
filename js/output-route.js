// Where the sound leaves the page -------------------------------------------
//
// The live graph plays straight into the AudioContext's destination: what the
// context renders is what the phone plays. Nothing sits between the two.
//
// A detour was tried in an earlier build — a MediaStreamDestination taken from
// the graph and played by a hidden <video> element, on the theory that media the
// system can see playing earns the loud playback session. On iOS it does the
// opposite: a live Media Stream in a media element is handled the way a video
// call is, so it is routed like one, to the receiver instead of the speaker and
// through the call audio processing — automatic gain, a narrowed band — which is
// heard as a synth that is quiet however far the phone's volume goes. The volume
// meter read full throughout, because the graph itself was fine and only the
// route was losing the sound.
//
// What actually earns the playback session is asking for it — setAudioSession
// ('playback'), in js/app.js — and, on a browser that decides from the media it
// has seen, the silent file main.js loops. Both stay; the detour is gone.

import { setAudioSession } from './app.js?v=12';

// The node the live engine's master volume connects into. Called once per
// AudioContext, so a rack swap — which builds a new engine on the same context —
// keeps playing through the same route.
export function liveOutput(ctx) {
  // An interruption, a phone call or a trip to the background can put the page
  // back in the quiet ambient session, where the sound follows the silent switch
  // and is mixed under other audio. The loud one is asked for again each time
  // the route is made, and main.js asks again whenever the context starts.
  setAudioSession('playback');
  return ctx.destination;
}
