# Patch Bay

A modular synthesiser that runs entirely in the browser, built on the Web Audio
API. No build step: open `index.html`.

## What is in it

**72 modules** — VCO, Harmonic, Sync, Metal, Chip, Super Saw, FM Osc, Pulse,
Wavetable, Vox, Noise, Sampler, Pluck, Drum, Zap, Riser, Clang, Boom, Blip, Ping,
Siren, Whistle, Glass, Splash, Bounce, Sparkle, Thunder, Sub Drop, Clap, Cowbell,
Boing, Buzz, Tweet, Glitch, Bell, Marimba, Shaker, Tom, Crash, Chord, Downlifter,
VCF, Comb, Vowel, VCA, ADSR, LFO, Delay, Reverb, Drive, Crusher, Ring Mod,
Wavefolder, Octaver, Chorus, Phaser, EQ, Mixer, CV Mixer, Multiple, Attenuverter,
Transpose, Slew, Random, Clock, Sequencer, Turing, Arp, Trance Gate, Scope,
Compressor and Output.

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

**Sound effects** — twenty-seven one-shot generators, each retriggered by a key
press like the Drum: Zap (a falling laser), Riser (a noise sweep that builds), Clang
(an inharmonic metal hit), Boom (an explosion with a filter sweep), Blip (an arcade
two-step blip), Ping (a sonar ping), Siren (a wailing alarm), Whistle (a slide
whistle with vibrato and breath), Glass (shattered shards), Splash (water opening
and settling), Bounce (a ball dropping), Sparkle (scattered high shimmer), Thunder
(a long dark rumble with a crack), Sub Drop (a sub-bass dive), Clap (three slaps
and the room behind them), Cowbell (two squares through a narrow band), Boing (a
cartoon spring), Buzz (a game-show buzzer), Tweet (bird chirps), Glitch (random
gated steps of a broken machine), Bell (a tuned FM bell), Marimba (a wooden
mallet), Shaker (a quick grain of bright noise), Tom (a pitched drum that bends
down onto the note), Crash (a long cymbal), Chord (a strummed chord stab) and
Downlifter (a noise sweep falling for drops).

**Auto-patched cables** — the default rack is already wired
`sources → VCF → VCA → Delay → Output` with an ADSR on the VCA, an LFO on the
filter cutoff and the sequencer on the oscillator pitch. Modules added with
**+ Add module** wire themselves in, and the **Auto-patch** button rebuilds the
whole routing.

**Build your own** — **Clear rack** removes every module and cable so you can
start from nothing. **+ Add module** opens a picker that describes what each
module is for; tap one to add it. The list is grouped under headings —
**Oscillators**, **Sound generators**, **Sound effects**, **Filters & tone**,
**Effects**, **Level & dynamics**, **Modulation**, **Sequencing** and
**Utility** — and every module's colour comes from its group, on its card, its
ports and its box in the patch view, so colour alone says what a module does.
A search box at the top of the picker narrows the list as you type: `osc` for
the oscillators, `gen` for the one-shot sound generators, `fx` for the effects,
`seq` for the step sequencers, or any module's name — `supersaw`, `filt`,
`delay` — and the hint above the list counts the matches; a heading disappears
with the last module under it. A **Search** button under the box applies the
term and puts the keyboard away, so the matches can be seen, and the keyboard's
own Search key does the same. **Clear** or Escape empties the search again. The
first module you add brings its own Output so the rack still makes sound, and
**Default rack** puts the starting patch back, with its BPM and volume.
Every load starts from scratch: the app opens on the default rack, with every
module at its original settings, and nothing from the last visit survives — the
five channels are empty, their knobs at 0 dB, the song is stopped, Rec is on
channel 1 and the keyboard is at its middle octave. Only the presets you saved on
purpose are kept. The **Output** is the one module
that cannot be removed — it is the only thing that reaches the speakers — and a
rack that somehow arrives without one is given a fresh Output on the end of its
chain, so the synth is never silently unreachable.

**Manual patching** — drag from a port to another port, or tap one port and then
the other. Tap a cable to unplug it.

**Presets** — **Presets** in the toolbar opens the presets sheet, where the
patch can be given a name and kept on the device; saving the same name again
replaces that preset, and any preset is loaded from the same list. Thirty sounds
come with Patch Bay, listed under **Built-in**, and your own saves sit under
**Your presets**, each with its module and cable count and the date, with a **×**
to delete it. Tap any preset to put it in the rack: a preset holds the modules,
their positions and settings, the cables, and the BPM and volume. The built-in
thirty cover the synth rather than repeating it — Classic lead, Acid bass, Ambient
pad, Plucked arp, Drum machine, Chiptune lead, Sub bass, Wobble bass, Glass keys,
Bell keys, Pipe organ, Drone, Ring bells, Fold lead, Comb pluck, Chip bass, Echo
flute, Sync scream, String pad, Wooden mallet, Metal hit, FM bell, Pulse lead,
Wavetable keys, Vox choir, Noise sweep, Buzz bass, Siren lead, Glitch machine and
Studio lead.

**Patch view** — a button in the toolbar shows the whole patch full screen: every
module and every cable in the rack, drawn to fit the screen at once, so a rack
larger than the scrolling view can be read at a glance. The header counts the
modules and cables. On a phone held upright the view turns itself into
**landscape**: the whole panel is laid out along the screen's long side, so turn
the phone sideways and the map is the wide picture it was drawn as; on a screen
that is already landscape nothing is turned. **Drag to move around it and pinch
to zoom**; on a computer the wheel zooms, and **−**, **+** and **Fit** in the
header do the same by hand — **Fit** puts the whole patch back on screen. Tap a
module in the map to close the view and jump to its card in the rack; a drag that
ends on a module does not jump. Close with the button or Escape.

**Visualiser** — a toolbar button opens a full-screen picture of whatever the
rack is playing: a ring of spectrum bars that mirrors around a glowing core, the
waveform drawn as a ring, and particles thrown out on each bass hit, all drifting
through slowly shifting colour. It listens to the master output, so it shows the
keys, a recorded take or the demo tune. A **keyboard along the bottom** plays the
patch while the picture runs — the transport's own keybed, with its own **−** and
**+** octave buttons at the left — so the visuals can be played to without
closing them. On a phone held upright it turns into **landscape** the same way
the patch view does. Close with the button or Escape.

**Demo tunes** — **Demo tunes** in the toolbar opens a selector with five
medium-length pieces, each written for a rack of its own, so the list is also a
tour of the synth: Neon lead (a saw through a resonant filter into a delay),
Velvet pad (a seven-voice super saw through chorus and a long reverb), Arcade run
(a chip pulse with a short slap, eight notes to the bar), Rubber bass (a square an
octave down through a tight filter and drive) and Plucked garden (Karplus-Strong
strings in a slow delay and a big room). Tapping one loads its rack into the app
and plays it — the rack on screen is replaced by the tune's, so each one is heard
through exactly the sound it was written for. It opens the visualiser, says its
name there, and stops by itself at the end; the visualiser's own **Demo tune**
button plays whichever was chosen last.

**Virtual MIDI keyboard** — two octaves plus the top C, glissando by sliding a
finger, octave buttons, and `a w s e d f t g y h u j k` on a computer keyboard.
The first tap, key or click anywhere in the page switches the audio on: browsers
will not let a page make sound before one, and Chrome keeps a context started
before it suspended — silent — so nothing is built until the player touches the
page. **Start audio** in the toolbar does the same by hand. The rack's own
output is lifted to full scale by a master stage that follows the rack's level:
the drive is set from the patch's measured peak, so its peaks land just under
full scale, and a fixed soft top rounds whatever overshoots that, before a final
ceiling at full scale. A quiet rack and a loud one both leave the page at the
same peaks, but each keeps its own dynamics instead of everything being squashed
into a wall of square edges — which is what a phone's speaker cannot reproduce,
and answers by turning quiet however far the phone's own volume goes. The
**Vol** slider sits after that stage, so turning it down backs the level off
cleanly and is never undone upstream. On a phone the page also asks for the
**playback** audio
session when the sound starts — and starts a second, silent audio file of its own
for browsers that only grant that session to a page playing real media — so the
synth plays at music volume out of the speaker rather than in the quieter ambient
session, which other audio ducks and the silent switch mutes.

**Recording** — Rec, Play, Loop. Note events are recorded with their timing and
replayed through the patch.

**Click and count-in** — **Click**, on from the start, is the switch that times a
take: with it on, tapping **Rec** counts a bar of four beats at the BPM and the
take begins on the downbeat, so a part is recorded on the tempo grid instead of
wherever the tap landed. The info line counts the bar down, and the keys played
during it are heard but not written down — a note pressed just before the
downbeat is taken as the take's first. The click is a sound in the room and never
part of the song: it plays straight to the speakers, past the rack and the
master, so no Play, mix or export contains it, and a lyric take gets the count-in
alone — no clicks under it — so the voice is never recorded over a click. With
**Click** off, a take starts on the tap as it did before.

**Quantize** snaps a finished take to the sixteenth of its own tempo — the BPM the
channel's rack was recorded at — so a note played a little early or late lands on
the beat it meant; a note that would round onto nothing is kept at half a step
rather than dropped. It is off until it is tapped, and turning it on snaps the
take already in the channel as well as every take after it.

**Five channels** — the buttons 1–5 above the transport choose which channel Rec
records to, and each channel keeps its own take; a channel's button shows a dot
once it holds notes. Changing channel while recording is refused, so a take is
never split, and starting a take clears only that channel. While one channel
records, the other channels play along as a backing, so the parts line up on one
timeline. **Play** plays every channel together.

**Each channel has its own volume** — the five knobs above the keyboard set how
loud each part is in the mix, channel 5 being the lyrics. A knob turns through
270° and its travel is measured in decibels rather than in linear gain: silence
at the bottom, 0 dB just short of the top — unity, the level a part was recorded
at — and +6 dB at the end of the turn, so a quiet part can be brought up as well
as a loud one taken down, with a full 60 dB below unity for tucking one under the
rest. It is turned by dragging up or down, and because a drag moves the level
from where it found it rather than jumping to the finger, a careful setting is a
small movement: near unity a pixel is about a third of a decibel, and on a
computer holding shift drags four times as finely, the arrows turn a knob by half
a decibel and the page keys by three. **Double-tap** a knob to put it back at
0 dB, and the readout under it says where it is. A knob turned while the song
plays is heard at once, and the live synth plays under the knob of the channel Rec
is set to, so a part is heard while it is recorded at the level it will play back
at. The levels last as long as the page, like everything else in the session; a
mix and a song file carry them too.

**Each channel keeps its rack** — a take is recorded with the rack that was on
screen when it started, and that rack travels with the channel. Recording
channel 1 on a rack with a Sampler, then channel 2 on the default patch, then
channel 3 on a rack of your own, leaves three parts that each play back and mix
down through their own sound: channel 1 keeps its sample, channel 2 keeps the
default patch, channel 3 keeps its effects, and changing the rack afterwards
changes none of them. Playback builds one graph per channel from its own snapshot
and sums them equally; an export renders the same way, so the file has every part
through the rack it was made with. A snapshot holds the modules, their settings
and the cables, along with whatever a module is holding — a Sampler's loaded
sample is the very buffer the channel was recorded with, so a sample loaded later
lands on the live Sampler and leaves the recorded channel as it was. The sample a
Sampler is holding lives only as long as the page, like the take itself. A take
recorded before a channel kept its rack plays through the rack
as it is now.

**Channel 5 — lyrics** is the one that records audio rather than notes. Pick it,
tap **Rec**, and the microphone records your voice while channels 1–4 play along
as the backing; the button reads **● Rec voice** while it is selected. The take is
captured on the same clock the note channels start on, so the lyric and the notes
stay in step, and it is kept exactly as it was recorded — nothing is trimmed,
normalised or faded. The lyric take stays in its channel for **Play**, and it is
mixed into every export alongside the four note parts; the channel's dot stays on
until another take replaces it or **Clear song** empties it. A take that is very
quiet — a phone held at arm's length — is lifted at mix time so it can be heard
under the patch, but the audio that is kept is always the audio that was captured.
The lyric take lives only as long as the page, like a recorded sample. The
microphone is asked for on the same tap, with echo cancellation on so the backing
coming out of the speaker stays out of the voice; headphones give the cleanest
take. Where a browser cannot be handed a microphone — an app's own browser on iOS
— **Rec** says so and offers the site's own link for Safari. A take stops itself
after five minutes.

**Mix** — **Mix** sums the five channels — the four note channels with the lyric
take mixed in — and saves them as WAV or FLAC (both rendered offline, faster than
real time; FLAC is encoded losslessly by `js/export.js`, so the Sampler can load it
back in) or OGG (captured live with MediaRecorder, where the browser supports
Ogg). The WAV and OGG buttons export the same mix.

**Naming the files** — the tune's name sits at the top of the app, above the
toolbar, reading **Untitled tune** until it is given one; tap it and type, then
Enter or **Save** to keep the name, or Escape or **Cancel** to leave it as it was.
The Mix sheet's name box edits that same name. Every file it is exported as is
written under it: `night-drive.wav`, `night-drive.flac`, `night-drive.ogg` and
`night-drive.json`. It applies to the sheet's four options and to the WAV and OGG
buttons alike, and it travels inside a song file, so a song imported later exports
under the name it was saved with. Left empty, the exports keep their plain
defaults, `patch-bay-mix` and `patch-bay-song.json`.

**Song files** — a mix is what a song sounds like; a song file is what it is.
**Song file** in the mix sheet writes the whole song as one file —
`patch-bay-song.json` unless it has been given a name — holding the notes of every
channel, the rack each channel was recorded with (its modules, settings and
cables), the lyric take, with the audio written into the file, and the song's own
name. **Import song** in the toolbar reads one back: the
five channels, the racks they keep and the lyrics are put back together, and the
song plays and mixes exactly as it was made. Importing leaves the rack on screen
alone — every channel already carries its own sound, and the rack is the player's
own instrument to go on working with. The song's BPM and the keyboard's octave
come back with it, and the imported song stays until the next load, when the app
starts from scratch again. It is also the one place a sample survives a visit: a
Sampler's sample travels in the file as audio, where the page's own memory would
lose it.

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

**Mic** is the one button that turns a voice take on and off: tap it, allow the
prompt, and it stays on — `Mic on` — for as many takes as you like; **Rec
sample** then records your voice on its own and says so. The rack's own notes
are left out of a voice take, so the keys play back just the voice and never a
recording of themselves.

A take then takes over the keys. It is loaded into the Sampler at middle C,
once through, and the Sampler is wired straight to the Output with every other
cable into the Output — and every other cable off the Sampler — unplugged, so
the keys play that recording alone, transposed from the note you press, and never
the synth's own sound or its effects on top of it. That holds for a voice take
and for a take of the rack itself. A voice take also silences the rack while it
records, so the microphone cannot pick up the synth playing out of the phone's
own speaker and put it into the take. The modules stay on the rack: **Auto-patch**,
**Default rack** or a preset brings the synth back in one tap.

**Rec sample** asks for the microphone itself when it has not been turned on
yet, with the tap behind it, so the first take of a visit can be a voice take
straight away — where asking is safe. On iOS a page shown in an app's own
browser is never asked: a web view whose app has no microphone description of
its own still takes the whole app down when it is asked, and the page cannot
tell that browser from one that would answer. There Rec sample records the rack
alone and says so. A browser that answers no is remembered, and later takes
record the rack without waiting on the same answer again.

**Mic** asks in Safari and in the browsers the player opened themselves. In an
app's own browser on iOS it never asks, for the reason above: the tap answers
with the site's public link instead, copied to the clipboard where the web view
allows it — publish the site with **Go Live**, paste the link into Safari and
allow the microphone there, or record the voice in Voice Memos, save it to Files
and load it with the Sampler's **Load sample** button. A request that never came
back — the page was taken down with it — is remembered across the load, and that
browser is not asked again either, so no tap can repeat it. The browser's own
echo cancellation, noise suppression and gain control are asked to stay off, so
a voice arrives as it sounds, and a take with a voice skips the count-in beeps,
which would otherwise land in it.

## CV convention

Control voltages are scaled so that **1.0 = one octave**. Pitch inputs multiply
the incoming signal by 1200 and add it to the oscillator's detune, and filter
cutoff inputs do the same, so modulation stays musical.

## Files

- `js/modules.js` — module definitions: UI parameters, patch ports, DSP graph
- `js/engine.js` — builds the graph in a live or offline AudioContext
- `js/output-route.js` — where the live graph's sound leaves the page, and how a phone is kept on its loud playback session
- `js/autopatch.js` — automatic cable routing
- `js/patchbay.js` — cards, ports, cable dragging, scope drawing
- `js/keyboard.js` — keyboard, recording, transport
- `js/click.js` — the click track and the bar of count-in a take begins after
- `js/voices.js` — the rack snapshot each channel keeps, and the graph it plays through
- `js/lyrics.js` — the lyric channel: capturing a voice take and mixing it back in
- `js/lyric-recorder-worklet.js` — the audio-thread capture the lyric channel reads from
- `js/export.js` — WAV and FLAC encoders, offline render, Ogg capture
- `js/song-file.js` — writes a song to a file and reads one back
- `js/sample-recorder.js` — records a take of the rack, or of your voice, into the Sampler
- `js/sample-recorder-worklet.js` — the audio-thread capture Rec sample reads from
- `js/app.js` — shared state
- `js/persist.js` — the clean start every visit gets, and the cleaning a preset or song file goes through
- `js/presets.js` — saves named patches and puts them back in the rack
- `js/visualiser.js` — the full-screen audio visualiser
- `js/demo.js` — the demo tunes and the rack each one is played on
- `js/main.js` — bootstrap, module picker, toolbar
- `js/splash.js` — the title card on the way in: its letters, its fit to the window, and its tune
- `js/counter.js` — the visitors chip in the title row, counted by Abacus

## Hosting it

The app is a set of files, not one document: `index.html` loads `css/app.css` and
`js/main.js`, those ES modules import their neighbours, and
`js/sample-recorder-worklet.js` is loaded as an AudioWorklet. Upload the folder as
it is — keeping `css/`, `js/` and `js/lib/` beside `index.html` — to any host that
serves files over https, and it runs there unchanged:

- `index.html`
- `css/app.css`
- `js/app.js`, `autopatch.js`, `click.js`, `counter.js`, `decode-audio.js`,
  `demo.js`, `engine.js`, `export.js`, `keyboard.js`,
  `lyric-recorder-worklet.js`, `lyrics.js`, `main.js`, `modules.js`,
  `output-route.js`, `patchbay.js`, `persist.js`, `presets.js`,
  `sample-recorder.js`, `sample-recorder-worklet.js`, `song-file.js`,
  `splash.js`, `visualiser.js`, `voices.js`
- `js/lib/flac-decoder.min.js`, `js/lib/ogg-opus-decoder.min.js`,
  `js/lib/ogg-vorbis-decoder.min.js` — only for loading FLAC/Ogg files the
  browser cannot decode by itself
- `manifest.json` — the name, colours and standalone display a browser reads when
  the page is added to a Home Screen; the page runs as well without it

`ad.html` is not part of the app and none of the above needs it: it is a
single self-contained promo page for Patch Bay — its own styles and one small
script are inside the file — whose every link is written `./index.html`, so it
works beside the app on any host and can be posted anywhere that serves files.
Upload it or leave it out; the synth runs either way.

`links.html` is a small page of copy buttons — the app's address, this
repository's and the promo page's — for when a link has to be pasted somewhere
and the message it arrived in will not copy it. Each button asks the browser for
the clipboard, and a browser that refuses selects the link instead, so a
long-press can take it. It is its own page with its own styles and script, opens
on its own at `links.html`, and nothing in the app links to it or needs it; the
promo page's "Just the link" block offers the address too.

Opening `index.html` from the Files app (`file://`) does not work: ES modules and
the AudioWorklet need a real https address. **Run** publishes to the preview link,
which opens in FreeMilk's own browser, and **Go Live** to the public one, which is
the link to open in Safari — the microphone is allowed there.

### Publishing it yourself

FreeMilk's link is one host among many, and it is the only one that puts a "Made
with FreeMilk" badge in the corner of the page. Nothing in the app depends on it:
the files are the whole site, so any host that serves them over https as they are
will do — no build step, no server, no database.

**GitHub Pages**, from the repository that already holds it: Settings → Pages →
Source "Deploy from a branch", branch `main`, folder `/ (root)`, Save. That one
switch is the repository's to give — no file in it can turn Pages on, since GitHub
reserves that for an administrator — and a minute later the app is at
`https://<user>.github.io/Patch-Bay/`, publishing again on every push to `main`.
Pages serves a site from a folder rather than from a host's root, which is why
every path in the page is relative — nothing has to change. A private repository
needs a paid plan for Pages; this one is public.

**The whole screen, from a link.** Pages — or itch, or any other host — serves
the page as a web page, so on a phone it arrives with the browser's own address
bar and toolbar around it. That is the browser rather than the app, and no file
in the repository can turn it off from a link. To have it take the screen, open
the link once and add the page to the Home Screen — Safari: **Share → Add to Home
Screen**; Chrome: **⋮ → Add to Home screen**; the same in most other phone
browsers. The `apple-mobile-web-app-*` tags in `index.html` and the
`manifest.json` beside it are what make it open from there as the app itself,
with no bars, its own name, and `env(safe-area-inset-*)` already giving the notch
and the home bar their room; from a link it is the same page as ever. The address
bar is also where the page is opened in an app's own browser, which is why the
microphone asks there the way it does (see **Mic** above).

**itch.io**, which the splash card already names: Dashboard → Create new project,
kind of project HTML, and upload one zip whose top level is `index.html`, `css/`
and `js/`. On a phone, open the project's folder in Files, select those items and
Compress — a zip made from the folder itself holds them one level down, where itch
does not look. Tick "This file will be played in the browser", give the embed a
window of at least 960×600, and tick Mobile friendly. itch serves the game from its
own https address, so the modules, the two worklets and the microphone all work as
they do here.

One thing itch does differently: the game plays inside its own frame, and iOS
hands a frame no microphone. **Mic** there answers by copying the game's own
address, which opens in Safari, where the microphone is allowed — that path
already exists for any host, so it needs nothing added. The rules that keep the
transport and the sheets clear of the FreeMilk badge (`body:has(> freemilk-badge)`
in `css/app.css`) simply never match on a page without one.

## Licence

Patch Bay is released under the MIT licence — see `LICENSE`. The bundled WASM
decoders in `js/lib` are MIT too, credited above.

## What the page talks to

One page of static files, one outbound request: the visitor counter. `SECURITY.md`
lists every request the page makes, what the bundled decoder files are and where
they come from, and how to check it — for anyone reading the source or answering a
scanner that flagged it.

