# Patch Bay

A modular synthesiser that runs entirely in the browser, built on the Web Audio
API. No build step: open `index.html`.

## What is in it

**65 modules** — VCO, Harmonic, Sync, Metal, Chip, Super Saw, FM Osc, Pulse,
Wavetable, Vox, Noise, Sampler, Pluck, Drum, Zap, Riser, Clang, Boom, Blip, Ping,
Siren, Whistle, Glass, Splash, Bounce, Sparkle, Thunder, Sub Drop, Clap, Cowbell,
Boing, Buzz, Tweet, Glitch, VCF, Comb, Vowel, VCA, ADSR, LFO, Delay, Reverb,
Drive, Crusher, Ring Mod, Wavefolder, Octaver, Chorus, Phaser, EQ, Mixer, CV
Mixer, Multiple, Attenuverter, Transpose, Slew, Random, Clock, Sequencer, Turing,
Arp, Trance Gate, Scope, Compressor and Output.

**Oscillators** — VCO for saw, square, triangle and sine; **Harmonic** builds a
tone from up to 32 harmonics, so one module covers organ stops and bright buzzy
leads; **Sync** is a hard-synced saw, its cycle cut short Ratio times per note;
**Metal** slides five sine partials between the harmonic series and the
inharmonic ratios of a struck bar; **Chip** is a pulse with a square an octave
below it. All of them take pitch CV, so a Sequencer, Turing or Arp drives them.

**Special modules** — **Pluck** is a Karplus-Strong string: a burst of noise
rings a delay line, so every key sounds a plucked string, with Damp and Decay
shaping it. **Vowel** is a three-band formant filter that makes anything talk
(A, E, I, O, U), with a Morph CV input. **Octaver** folds the wave up for an
octave above the input. **Trance Gate** stutters the signal on a pattern at the
tempo. **Turing** is a random sequencer with a memory: eight bits shift once per
step, and Flip sets how often a new one comes in, so it can loop a tune or keep
mutating it. **Arp** holds the keys that are down and cycles them as a pitch CV.
A module added with a Pitch output wires itself into every oscillator that takes
CV, and one with a Gate output opens the VCA when no envelope has claimed it.

**Sound effects** — twenty one-shot generators, each retriggered by a key press
like the Drum: Zap (a falling laser), Riser (a noise sweep that builds), Clang (an
inharmonic metal hit), Boom (an explosion with a filter sweep), Blip (an arcade
two-step blip), Ping (a sonar ping), Siren (a wailing alarm), Whistle (a slide
whistle with vibrato and breath), Glass (shattered shards), Splash (water opening
and settling), Bounce (a ball dropping), Sparkle (scattered high shimmer), Thunder
(a long dark rumble with a crack), Sub Drop (a sub-bass dive), Clap (three slaps
and the room behind them), Cowbell (two squares through a narrow band), Boing (a
cartoon spring), Buzz (a game-show buzzer), Tweet (bird chirps) and Glitch
(random gated steps of a broken machine).

**Auto-patched cables** — the default rack is already wired
`sources → VCF → VCA → Delay → Output` with an ADSR on the VCA, an LFO on the
filter cutoff and the sequencer on the oscillator pitch. Modules added with
**+ Add module** wire themselves in, and the **Auto-patch** button rebuilds the
whole routing.

**Build your own** — **Clear rack** removes every module and cable so you can
start from nothing. **+ Add module** opens a picker that describes what each
module is for; tap one to add it. A search box at the top of the picker narrows
the list as you type: `osc` for the oscillators, `gen` for the one-shot sound
generators, `fx` for the effects, `seq` for the step sequencers, or any
module's name — `supersaw`, `filt`, `delay` — and the hint above the list counts
the matches. **Clear** or Escape empties the search again. The first module you
add brings its own Output so the rack still makes sound, and **Default rack**
puts the starting patch back.
The rack, its cables and the recorded channels are kept on the device, so a
reload brings them back as they were; a loaded or recorded sample is the one thing
that lives only as long as the page.

**Manual patching** — drag from a port to another port, or tap one port and then
the other. Tap a cable to unplug it.

**Virtual MIDI keyboard** — two octaves plus the top C, glissando by sliding a
finger, octave buttons, and `a w s e d f t g y h u j k` on a computer keyboard.

**Recording** — Rec, Play, Loop. Note events are recorded with their timing and
replayed through the patch.

**Four channels** — the buttons 1–4 above the transport choose which channel Rec
records to, and each channel keeps its own take; a channel's button shows a dot
once it holds notes. Changing channel while recording is refused, so a take is
never split, and starting a take clears only that channel. While one channel
records, the other channels play along as a backing, so the parts line up on one
timeline. **Play** plays every channel together.

**Mix** — **Mix** sums the four channels and saves them as WAV or FLAC (both
rendered offline, faster than real time; FLAC is encoded losslessly by
`js/export.js`, so the Sampler can load it back in) or OGG (captured live with
MediaRecorder, where the browser supports Ogg). The WAV and OGG buttons export
the same mix.

**Sample loader** — load WAV, FLAC, Ogg Vorbis or Ogg Opus audio into the Sampler
module; it is pitched across the keyboard relative to the Root note parameter, so
samples follow the notes you play. The browser's own decoder is used where it
supports the format, and bundled WASM decoders (`js/lib`) cover Ogg Vorbis, Ogg
Opus and FLAC on browsers that do not (iOS Safari before 18.4 cannot decode Ogg
Vorbis).

Ogg Vorbis, Ogg Opus and FLAC fallback decoding uses
[wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) (MIT licence,
libvorbis, libopus and libFLAC compiled to WebAssembly).

**Record a sample** — **Rec sample** records the rack's own output for up to ten
seconds and loads the take into a Sampler (adding one if the rack has none), so
the keys play it straight away. Recording starts on the tap; three beeps count
it in, and they go straight to the speakers so they never reach the take. The
button reads **■ Stop** for the whole take and never changes size, and a message
above the transport shows the seconds and the level being captured — it is placed
above the transport's buttons, so nothing covers Stop, and touching the transport
clears it. The take is trimmed, normalised and faded so it starts without a
click; tap **Stop** to finish early.

**Mic** is the one button that asks for the microphone: tap it, allow the
prompt, and it stays on — `Mic on` — for as many takes as you like; **Rec
sample** then records your voice on its own and says so. The rack's own notes
are left out of a voice take, so the keys play back just the voice and never a
recording of themselves. **Rec sample** never asks for the microphone itself:
only **Mic** does, with the tap behind it, so a take is never lost to a request.

**Mic** asks only in a browser you opened yourself. An app's own browser on iOS
has no microphone to hand a page: the app showing it would have to ask iOS for
one on the page's behalf, and nothing the page does can make it, so iOS does not
refuse the request — it ends that app instead. So there **Mic** sends nothing at
all: it copies the site's public link and says where a voice is recorded instead
— publish the site with **Go Live**, paste the link into Safari and allow the
microphone there, or record the voice in Voice Memos, save it to Files and load
it with the Sampler's **Load sample** button. The browser's own echo
cancellation, noise suppression and gain control are asked to stay off, so a
voice arrives as it sounds, and a take with a voice skips the count-in beeps,
which would otherwise land in it.

## CV convention

Control voltages are scaled so that **1.0 = one octave**. Pitch inputs multiply
the incoming signal by 1200 and add it to the oscillator's detune, and filter
cutoff inputs do the same, so modulation stays musical.

## Files

- `js/modules.js` — module definitions: UI parameters, patch ports, DSP graph
- `js/engine.js` — builds the graph in a live or offline AudioContext
- `js/autopatch.js` — automatic cable routing
- `js/patchbay.js` — cards, ports, cable dragging, scope drawing
- `js/keyboard.js` — keyboard, recording, transport
- `js/export.js` — WAV and FLAC encoders, offline render, Ogg capture
- `js/sample-recorder.js` — records a take of the rack, or of your voice, into the Sampler
- `js/sample-recorder-worklet.js` — the audio-thread capture Rec sample reads from
- `js/app.js` — shared state
- `js/persist.js` — keeps the rack, cables and channels across a reload
- `js/main.js` — bootstrap, module picker, toolbar

## Hosting it

The app is a set of files, not one document: `index.html` loads `css/app.css` and
`js/main.js`, those ES modules import their neighbours, and
`js/sample-recorder-worklet.js` is loaded as an AudioWorklet. Upload the folder as
it is — keeping `css/`, `js/` and `js/lib/` beside `index.html` — to any host that
serves files over https, and it runs there unchanged:

- `index.html`
- `css/app.css`
- `js/app.js`, `autopatch.js`, `decode-audio.js`, `engine.js`, `export.js`,
  `keyboard.js`, `main.js`, `modules.js`, `patchbay.js`, `persist.js`,
  `sample-recorder.js`, `sample-recorder-worklet.js`
- `js/lib/flac-decoder.min.js`, `js/lib/ogg-opus-decoder.min.js`,
  `js/lib/ogg-vorbis-decoder.min.js` — only for loading FLAC/Ogg files the
  browser cannot decode by itself

Opening `index.html` from the Files app (`file://`) does not work: ES modules and
the AudioWorklet need a real https address. **Run** publishes to the preview link,
which opens in FreeMilk's own browser, and **Go Live** to the public one, which is
the link to open in Safari — the microphone is allowed there.

## Licence

Patch Bay is released under the MIT licence — see `LICENSE`. The bundled WASM
decoders in `js/lib` are MIT too, credited above.

