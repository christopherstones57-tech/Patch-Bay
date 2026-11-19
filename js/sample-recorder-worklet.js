// Captures the audio reaching it for the sample recorder and hands it to the
// main thread in blocks, so a take arrives quickly without a message for every
// 128-frame render quantum. Its own output is silence: nothing the recorder
// hears is ever monitored through the speakers.

const CHUNK = 4096;

class SampleRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.buf = new Float32Array(CHUNK);
    this.pos = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && typeof d.record === 'boolean') {
        // Whatever is still in the buffer when the take ends is part of it.
        if (!d.record) this.flush();
        this.recording = d.record;
      }
    };
  }

  flush() {
    if (!this.pos) return;
    const out = this.buf.slice(0, this.pos);
    this.pos = 0;
    this.port.postMessage(out, [out.buffer]);
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;

    // Every channel folded to mono, so a wide patch and a voice arrive together.
    const frames = input[0].length;
    const chans = input.length;
    for (let i = 0; i < frames; i++) {
      let v = input[0][i];
      for (let c = 1; c < chans; c++) v += input[c][i];
      this.buf[this.pos++] = chans > 1 ? v / chans : v;
      if (this.pos === CHUNK) this.flush();
    }
    return true;
  }
}

registerProcessor('sample-recorder', SampleRecorderProcessor);
