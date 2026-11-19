// Sample decoding for the Sampler module.
//
// WAV is decoded by the browser. Ogg Vorbis, Ogg Opus and FLAC are decoded by
// small WASM decoders bundled in js/lib, because iOS Safari before 18.4 cannot
// decode Ogg Vorbis at all and other browsers are patchy about these containers.
// The browser's own decoder is still used as a fallback, and for everything else
// (MP3, M4A/AAC, CAF, AIFF...).

const SCRIPTS = new Map();

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(label || 'Timed out'));
    }, ms);
    promise.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function loadScript(src) {
  if (SCRIPTS.has(src)) return SCRIPTS.get(src);
  const p = withTimeout(
    new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.charset = 'UTF-8'; // the WASM is embedded as a UTF-8 string
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Could not load the audio decoder'));
      document.head.appendChild(el);
    }),
    12000,
    'The audio decoder did not load'
  );
  SCRIPTS.set(src, p);
  // Do not cache a failure: a later attempt should be able to retry.
  p.catch(() => SCRIPTS.delete(src));
  return p;
}

function ascii(bytes, offset, len) {
  let s = '';
  const end = Math.min(bytes.length, offset + len);
  for (let i = offset; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function sniffFormat(bytes, name) {
  if (bytes.length >= 12) {
    const magic = ascii(bytes, 0, 4);
    if (magic === 'OggS') {
      const head = ascii(bytes, 0, Math.min(bytes.length, 256));
      return head.indexOf('OpusHead') >= 0 ? 'ogg-opus' : 'ogg';
    }
    if (magic === 'fLaC') return 'flac';
    if (magic === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav';
  }
  const ext = String(name || '')
    .split('.')
    .pop()
    .toLowerCase();
  if (ext === 'ogg' || ext === 'oga') return 'ogg';
  if (ext === 'opus') return 'ogg-opus';
  if (ext === 'flac') return 'flac';
  if (ext === 'wav' || ext === 'wave') return 'wav';
  return 'unknown';
}

function toAudioBuffer(ctx, decoded) {
  const chans = (decoded && decoded.channelData) || [];
  const len = chans.length ? chans[0].length : 0;
  if (!len) throw new Error('No audio in this file');
  const rate = decoded.sampleRate || ctx.sampleRate;
  const buffer = ctx.createBuffer(chans.length, len, rate);
  for (let i = 0; i < chans.length; i++) {
    const src = chans[i];
    const target = buffer.getChannelData(i);
    target.set(src.length > target.length ? src.subarray(0, target.length) : src);
  }
  return buffer;
}

async function nativeDecode(ctx, arrayBuffer) {
  try {
    // decodeAudioData detaches the buffer it is given, so hand it a copy.
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    if (buffer && buffer.length) return buffer;
  } catch (e) {
    console.warn('Native audio decode failed', e);
  }
  return null;
}

// Runs one of the bundled WASM decoders. Returns null instead of throwing so a
// caller can fall back to the browser's own decoder.
async function decodeWithWasm(ctx, bytes, opts) {
  try {
    await loadScript(opts.script);
    const ns = window[opts.global];
    const Decoder = ns && ns[opts.className];
    if (!Decoder) return null;
    const decoder = new Decoder();
    await withTimeout(decoder.ready, 15000, opts.startError);
    try {
      const decoded = await withTimeout(decoder.decodeFile(bytes), 45000, opts.decodeError);
      return toAudioBuffer(ctx, decoded);
    } finally {
      try {
        decoder.free();
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    console.warn(opts.label + ' decode failed', e);
    return null;
  }
}

function oggVorbisDecode(ctx, bytes) {
  return decodeWithWasm(ctx, bytes, {
    script: 'js/lib/ogg-vorbis-decoder.min.js',
    global: 'ogg-vorbis-decoder',
    className: 'OggVorbisDecoder',
    label: 'Ogg Vorbis',
    startError: 'The Ogg decoder did not start',
    decodeError: 'Decoding this Ogg file took too long'
  });
}

function oggOpusDecode(ctx, bytes) {
  return decodeWithWasm(ctx, bytes, {
    script: 'js/lib/ogg-opus-decoder.min.js',
    global: 'ogg-opus-decoder',
    className: 'OggOpusDecoder',
    label: 'Ogg Opus',
    startError: 'The Opus decoder did not start',
    decodeError: 'Decoding this Ogg Opus file took too long'
  });
}

function flacDecode(ctx, bytes) {
  return decodeWithWasm(ctx, bytes, {
    script: 'js/lib/flac-decoder.min.js',
    global: 'flac-decoder',
    className: 'FLACDecoder',
    label: 'FLAC',
    startError: 'The FLAC decoder did not start',
    decodeError: 'Decoding this FLAC file took too long'
  });
}

// Decodes an audio file into an AudioBuffer, whatever the browser supports.
export async function decodeSampleFile(ctx, arrayBuffer, name) {
  const bytes = new Uint8Array(arrayBuffer);
  const kind = sniffFormat(bytes, name);

  if (kind === 'ogg') {
    // Bundled decoder first so behaviour is the same on every browser.
    const buffer = await oggVorbisDecode(ctx, bytes);
    if (buffer) return buffer;
    const native = await nativeDecode(ctx, arrayBuffer);
    if (native) return native;
    // Some Ogg files hold FLAC rather than Vorbis.
    const flac = await flacDecode(ctx, bytes);
    if (flac) return flac;
    throw new Error('Could not decode this Ogg file — use Ogg Vorbis, Ogg Opus, FLAC or WAV');
  }

  if (kind === 'ogg-opus') {
    const buffer = await oggOpusDecode(ctx, bytes);
    if (buffer) return buffer;
    const native = await nativeDecode(ctx, arrayBuffer);
    if (native) return native;
    throw new Error('Could not decode this Ogg Opus file');
  }

  const native = await nativeDecode(ctx, arrayBuffer);
  if (native) return native;

  if (kind === 'flac') {
    const buffer = await flacDecode(ctx, bytes);
    if (buffer) return buffer;
    throw new Error('Could not decode this FLAC file');
  }

  throw new Error('Could not decode this file — try WAV, FLAC, Ogg Vorbis or Ogg Opus');
}
