// WAV and FLAC rendering (offline, faster than real time) and Ogg capture
// (real time, MediaRecorder). Every export renders the mix — every recording
// channel on one timeline.

import {
  app,
  lyricEnd,
  hasLyrics,
  NOTE_CHANNEL_COUNT,
  LYRIC_CHANNEL,
  MAX_CHANNEL_VOLUME
} from './app.js?v=12';
import { Engine } from './engine.js?v=12';
import { playOnce, stopPlayback } from './keyboard.js?v=12';
import { mixLyricsInto } from './lyrics.js?v=12';
import { voiceBus } from './voices.js?v=12';

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

export function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const len = buffer.length;
  const dataSize = len * numCh * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));

  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = chans[c][i];
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return ab;
}

export async function downloadBlob(blob, name) {
  // iOS webviews frequently ignore <a download>, so prefer the share sheet
  // there (Save to Files) and fall back to a plain download link.
  try {
    if (typeof File !== 'undefined' && navigator.share && navigator.canShare) {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    /* fall through to a download link */
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 4000);
}

// The name an exported file is written under: the song's own name, as typed at
// the top of the app or in the Mix sheet, made safe for a file system, with the
// format's extension on the end. A name that already ends in an extension loses
// it, so "night drive.wav" is not saved as "night drive.wav.wav", and a song
// nobody has named keeps the plain default.
export function exportFileName(ext, fallback) {
  const typed = String((app.song && app.song.name) || '')
    .trim()
    .replace(/\.(wav|flac|ogg|json)$/i, '')
    .trim();
  const base = typed
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 80)
    .trim();
  return (base || fallback) + '.' + ext;
}

// A channel's own level, as the five knobs above the keyboard set them, so a mix
// comes out balanced the way it was heard.
function mixVolume(i) {
  const v = app.song.volumes ? app.song.volumes[i] : 1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_CHANNEL_VOLUME, n)) : 1;
}

// Renders the mix: every note channel through the rack it was recorded with, and
// the lyric channel's voice take, all into one graph — or a short test note when
// nothing is recorded. One OfflineAudioContext renders the whole thing, so
// exporting is much faster than real time.
export async function renderSong() {
  const tail = 2.5;
  const rate = 44100;

  // Which note channels hold something to render, and how long the song runs.
  const parts = [];
  let end = 0;
  for (let i = 0; i < NOTE_CHANNEL_COUNT; i++) {
    const evs = app.song.channels[i];
    if (!evs.length) continue;
    parts.push(i);
    for (const ev of evs) {
      const e = ev.end == null ? ev.start + 0.3 : ev.end;
      if (e > end) end = e;
    }
  }
  end = Math.max(end, lyricEnd());

  const duration = (end || 2.5) + tail;
  const frames = Math.ceil(rate * duration);

  const off = new OfflineAudioContext(2, frames, rate);
  const bus = off.createGain();
  bus.gain.value = 1;
  bus.connect(off.destination);

  const engines = [];

  if (parts.length) {
    // One engine per channel, from that channel's own rack, so a Sampler part and
    // a part made on the default patch sound as they did when they were recorded.
    // Equal-gain, the same as playback: each engine has already levelled its own
    // patch, so the parts are taken down together to fit under full scale.
    const share = 1 / parts.length;
    for (const i of parts) {
      const gain = off.createGain();
      gain.gain.value = share * mixVolume(i);
      gain.connect(bus);

      const engine = new Engine(off, app.song.racks[i] || app.state, {
        offline: true,
        duration,
        out: gain,
        schedulers: false
      });
      engines.push(engine);

      for (const ev of app.song.channels[i]) {
        engine.noteOn(ev.midi, ev.start, ev.vel);
        engine.noteOff(ev.midi, ev.end == null ? ev.start + 0.25 : ev.end);
      }
    }
  } else if (!hasLyrics()) {
    // Nothing recorded yet: something to hear, through the rack as it is now.
    const engine = new Engine(off, app.state, {
      offline: true,
      duration,
      out: bus,
      schedulers: false
    });
    engines.push(engine);
    engine.noteOn(60, 0.05, 0.9);
    engine.noteOff(60, 1.8);
  }

  // The lyric take joins the mix after the notes' own levelling, at its place on
  // the timeline, and is kept exactly as it was captured.
  if (hasLyrics()) mixLyricsInto(off, bus, 0, mixVolume(LYRIC_CHANNEL));

  const buffer = await off.startRendering();
  for (const engine of engines) {
    try {
      engine.dispose();
    } catch (e) {
      /* ignore */
    }
  }
  return guardPeak(buffer);
}

// Several engines' outputs summed can pass full scale on the loudest moment of
// the song. Pull the whole mix back rather than let the format clip it: the parts
// keep their balance, only the level is lowered, and only when it has to be.
function guardPeak(buffer) {
  const chans = [];
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    chans.push(d);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (const d of chans) for (let i = 0; i < d.length; i++) d[i] *= scale;
  }
  return buffer;
}

export async function exportWav() {
  const buffer = await renderSong();
  const blob = new Blob([encodeWav(buffer)], { type: 'audio/wav' });
  const name = exportFileName('wav', 'patch-bay-mix');
  await downloadBlob(blob, name);
  return name;
}

/* FLAC ---------------------------------------------------------------------
 *
 * A small lossless FLAC writer: fixed-block stream, 16-bit samples, mono or
 * stereo, a fixed predictor of order 1 and partitioned Rice coding. Frames are
 * 4096 samples; the last one may be shorter. The file's MD5 field is left at
 * zero, which the format defines as "not known".
 */

const FLAC_BLOCK = 4096;

// Bit writer, big-endian: most significant bit first.
class BitWriter {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.nbits = 0;
  }

  write(value, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1);
      this.nbits++;
      if (this.nbits === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }

  writeSigned(value, bits) {
    this.write(value & ((1 << bits) - 1), bits);
  }

  writeUnary(q) {
    for (let i = 0; i < q; i++) this.write(1, 1);
    this.write(0, 1);
  }

  align() {
    if (this.nbits) this.write(0, 8 - this.nbits);
  }
}

// CRC-8, polynomial x^8 + x^2 + x + 1, over bytes [start, end).
function flacCrc8(bytes, start, end) {
  let c = 0;
  for (let i = start; i < end; i++) {
    c ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
  }
  return c;
}

// CRC-16, polynomial x^16 + x^15 + x^2 + 1, over bytes [start, end).
function flacCrc16(bytes, start, end) {
  let c = 0;
  for (let i = start; i < end; i++) {
    c ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    }
  }
  return c;
}

// FLAC's UTF-8 style coded frame number: one byte below 128, otherwise a lead
// byte with n leading ones and (7-n) payload bits, then 6 bits per tail byte.
function writeFlacNumber(w, value) {
  if (value < 0x80) {
    w.write(value, 8);
    return;
  }
  let n = 2;
  while (n < 7 && value >= Math.pow(2, 5 * n + 1)) n++;
  const tail = [];
  let rest = value;
  for (let i = 0; i < n - 1; i++) {
    tail.unshift(0x80 | (rest % 64));
    rest = Math.floor(rest / 64);
  }
  w.write(((0xff << (8 - n)) & 0xff) | rest, 8);
  for (const b of tail) w.write(b, 8);
}

// Rice parameter for a run of residuals: the mean magnitude picks the code
// length, which keeps the unary quotients short.
function flacRiceK(res, start, count) {
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const v = res[start + i];
    sum += v < 0 ? -2 * v - 1 : 2 * v;
  }
  const mean = sum / count;
  let k = 0;
  while (k < 14 && mean >= Math.pow(2, k + 1)) k++;
  return k;
}

// One residual: unary quotient of the zig-zag value, then the low bits.
function writeRice(w, value, k) {
  const u = value < 0 ? -2 * value - 1 : 2 * value;
  const q = k === 0 ? u : Math.floor(u / (1 << k));
  w.writeUnary(q);
  if (k) w.write(u & ((1 << k) - 1), k);
}

// A fixed-predictor subframe of order 1: the first sample raw, then the sample
// to sample differences Rice-coded in partitions.
function writeFixedSubframe(w, samples, off, len) {
  w.write(0, 1);            // zero bit
  w.write(0b001001, 6);     // fixed predictor, order 1
  w.write(0, 1);            // no wasted bits
  w.writeSigned(samples[off], 16); // warm-up sample

  const count = len - 1;
  const res = new Int32Array(count);
  for (let i = 0; i < count; i++) res[i] = samples[off + i + 1] - samples[off + i];

  w.write(0, 2);            // Rice coding with 4-bit parameters

  // The largest partition order that divides the block and leaves partitions
  // worth their own parameter.
  let po = 0;
  for (let p = 6; p >= 0; p--) {
    if ((len & ((1 << p) - 1)) === 0 && len >> p >= 16) {
      po = p;
      break;
    }
  }
  w.write(po, 4);

  const partSize = len >> po;
  let idx = 0;
  for (let p = 0; p < 1 << po; p++) {
    const n = p === 0 ? partSize - 1 : partSize; // the warm-up sample is partition 0's first
    const k = flacRiceK(res, idx, n);
    w.write(k, 4);
    for (let i = 0; i < n; i++) writeRice(w, res[idx + i], k);
    idx += n;
  }
}

// One frame: header with its CRC-8, a subframe per channel, then the frame's
// CRC-16.
function flacFrame(pcm, numCh, off, len, index, rate) {
  const w = new BitWriter();

  w.write(0x3ffe, 14);                    // sync code
  w.write(0, 1);                          // reserved
  w.write(0, 1);                          // fixed block size: coded frame numbers
  w.write(len === FLAC_BLOCK ? 0x0c : 0x07, 4); // 4096, or a 16-bit length below
  w.write(rate === 44100 ? 0x09 : 0x0d, 4);     // 44.1kHz, or a 16-bit rate below
  w.write(numCh - 1, 4);                  // channel assignment: independent
  w.write(0b100, 3);                      // 16 bits per sample
  w.write(0, 1);                          // reserved

  writeFlacNumber(w, index);
  if (len !== FLAC_BLOCK) w.write(len - 1, 16);
  if (rate !== 44100) w.write(rate, 16);

  w.write(flacCrc8(w.bytes, 0, w.bytes.length), 8);

  for (let c = 0; c < numCh; c++) writeFixedSubframe(w, pcm[c], off, len);

  w.align();
  const bytes = w.bytes;
  const crc = flacCrc16(bytes, 0, bytes.length);
  bytes.push((crc >> 8) & 0xff, crc & 0xff);
  return Uint8Array.from(bytes);
}

function flacStreamInfo(numCh, rate, total, minBlock, maxBlock) {
  const w = new BitWriter();
  w.write(minBlock, 16);
  w.write(maxBlock, 16);
  w.write(0, 24);                  // minimum frame size: unknown
  w.write(0, 24);                  // maximum frame size: unknown
  w.write(rate, 20);
  w.write(numCh - 1, 3);
  w.write(15, 5);                  // 16 bits per sample, minus one
  w.write(Math.floor(total / 0x100000000), 4); // total samples, 36 bits
  w.write(total % 0x100000000, 32);
  for (let i = 0; i < 16; i++) w.write(0, 8); // MD5: unknown
  w.align();
  return w.bytes;
}

// Returns the file as a list of byte chunks, ready for a Blob.
export function encodeFlac(buffer) {
  const numCh = buffer.numberOfChannels >= 2 ? 2 : 1;
  const rate = buffer.sampleRate;
  const raw = buffer.length;

  // Every frame but the last is FLAC_BLOCK samples; a final frame shorter than
  // the format's 16-sample minimum is padded with silence so the stream stays a
  // valid fixed-block one.
  const rem = raw % FLAC_BLOCK;
  const pad = raw === 0 ? 16 : rem > 0 && rem < 16 ? 16 - rem : 0;
  const total = raw + pad;

  const pcm = [];
  for (let c = 0; c < numCh; c++) {
    const src = buffer.getChannelData(c);
    const arr = new Int16Array(total);
    for (let i = 0; i < raw; i++) {
      let s = src[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      arr[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    pcm.push(arr);
  }

  const lens = [];
  for (let off = 0; off < total; off += FLAC_BLOCK) {
    lens.push(Math.min(FLAC_BLOCK, total - off));
  }

  let minBlock = FLAC_BLOCK;
  let maxBlock = FLAC_BLOCK;
  for (const l of lens) {
    if (l < minBlock) minBlock = l;
    if (l > maxBlock) maxBlock = l;
  }

  // 'fLaC', then the STREAMINFO block (last metadata block, type 0, 34 bytes).
  const head = new BitWriter();
  head.write(0x66, 8);
  head.write(0x4c, 8);
  head.write(0x61, 8);
  head.write(0x43, 8);
  head.write(0x80, 8);
  head.write(0, 8);
  head.write(0, 8);
  head.write(34, 8);

  const parts = [Uint8Array.from(head.bytes.concat(flacStreamInfo(numCh, rate, total, minBlock, maxBlock)))];

  let off = 0;
  for (let i = 0; i < lens.length; i++) {
    parts.push(flacFrame(pcm, numCh, off, lens[i], i, rate));
    off += lens[i];
  }
  return parts;
}

export async function exportFlac() {
  const buffer = await renderSong();
  const blob = new Blob(encodeFlac(buffer), { type: 'audio/flac' });
  const name = exportFileName('flac', 'patch-bay-mix');
  await downloadBlob(blob, name);
  return name;
}

export function oggMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
  const candidates = [
    'audio/ogg;codecs=opus',
    'audio/ogg;codecs=vorbis',
    'audio/ogg',
    'audio/opus'
  ];
  return (
    candidates.find((m) => {
      try {
        return MediaRecorder.isTypeSupported(m);
      } catch (e) {
        return false;
      }
    }) || null
  );
}

export async function exportOgg() {
  const mime = oggMime();
  if (!mime) {
    throw new Error(
      'This browser cannot record Ogg audio. Use WAV or FLAC, or open the app in Chrome or Firefox.'
    );
  }
  if (!app.ctx || !app.engine) throw new Error('Start the audio first');

  stopPlayback();

  const dest = app.ctx.createMediaStreamDestination();
  // Everything the speakers are playing: the live rack's own ceiling (the keys,
  // and the lyric take, which joins at its volume) and the bus every recorded
  // channel's voice is summed on. The file then holds exactly what is heard.
  const taps = [app.engine.rail || app.engine.volume];
  const bus = voiceBus();
  if (bus) taps.push(bus);
  for (const t of taps) t.connect(dest);

  const chunks = [];
  const rec = new MediaRecorder(dest.stream, { mimeType: mime });
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise((res) => {
    rec.onstop = res;
  });

  rec.start();
  await playOnce();
  await new Promise((r) => setTimeout(r, 250));
  rec.stop();
  await stopped;

  for (const t of taps) {
    try {
      t.disconnect(dest);
    } catch (e) {
      /* ignore */
    }
  }

  if (!chunks.length) throw new Error('The browser recorded no audio');

  const blob = new Blob(chunks, { type: 'audio/ogg' });
  const name = exportFileName('ogg', 'patch-bay-mix');
  await downloadBlob(blob, name);
  return name;
}
