// Captures the lyric channel: the voice arriving at it, folded to mono and handed
// to the main thread in blocks. Its own output is silence, so nothing the take
// hears is ever monitored through the speakers.
//
// Unlike the sample recorder it is told *when* on the context's clock to begin,
// and it drops every frame before that moment. A take therefore starts on the
// same timeline as the four note channels it plays along with, to the sample,
// rather than wherever the microphone happened to be ready — and the moment it
// really started is reported with the first block, so the take can be placed on
// the timeline exactly.

const CHUNK = 4096;

class LyricRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.startTime = 0; // context time the take begins at
    this.started = false; // the block holding that moment has been reached
    this.sentStart = false; // the first block has gone out with its time
    this.firstTime = 0; // context time of the first frame actually kept
    this.buf = new Float32Array(CHUNK);
    this.pos = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d || typeof d.record !== 'boolean') return;
      if (d.record) {
        this.buf = new Float32Array(CHUNK);
        this.pos = 0;
        this.started = false;
        this.sentStart = false;
        this.startTime = Number(d.start) || 0;
        this.recording = true;
      } else {
        this.recording = false;
        // Whatever is still in the buffer when the take ends is part of it.
        this.flush();
        this.port.postMessage({ done: true });
      }
    };
  }

  flush() {
    if (!this.pos) return;
    const out = this.buf.slice(0, this.pos);
    this.pos = 0;
    const first = !this.sentStart;
    this.sentStart = true;
    this.port.postMessage(
      { frames: out, start: first ? this.firstTime : null },
      [out.buffer]
    );
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;

    const frames = input[0].length;
    const rate = sampleRate;

    // The first block reaching the take: either it holds the starting moment, in
    // which case the frames before it are dropped, or it ends before the start
    // and is skipped whole.
    let offset = 0;
    if (!this.started) {
      if (currentTime + frames / rate <= this.startTime) return true;
      offset = Math.max(0, Math.ceil((this.startTime - currentTime) * rate));
      this.started = true;
      this.firstTime = currentTime + offset / rate;
    }

    // Every channel folded to mono, so a stereo interface still arrives as one
    // voice.
    const chans = input.length;
    for (let i = offset; i < frames; i++) {
      let v = input[0][i];
      for (let c = 1; c < chans; c++) v += input[c][i];
      this.buf[this.pos++] = chans > 1 ? v / chans : v;
      if (this.pos === CHUNK) this.flush();
    }
    return true;
  }
}

registerProcessor('lyric-recorder', LyricRecorderProcessor);
