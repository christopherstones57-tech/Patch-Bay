// Song files ------------------------------------------------------------------
//
// A mix is what a song sounds like; a song file is what it is. One file holds
// every note channel, the rack each of those channels was recorded with — its
// modules, settings and cables, and the sample a Sampler was holding — and the
// lyric channel's voice take, so a song made here can be put back together
// exactly as it was on another visit or another device.
//
// The file is JSON with the audio inside it: the lyric take and any Sampler's
// sample are written as base64 WAV, which every browser can decode again without
// a bundled decoder. It is the one place a sample does survive, because the file
// is not the page: Recover sample and the lyric take are otherwise in memory for
// as long as the page lives.
//
// Importing replaces the song — the five channels, the racks they keep and the
// lyrics — and leaves the rack on screen alone. Each channel already carries the
// sound it was recorded with, so the song plays as it was made whatever rack is
// loaded, and the rack is the player's own instrument to go on working with.

import {
  app,
  CHANNEL_COUNT,
  NOTE_CHANNEL_COUNT,
  MAX_CHANNEL_VOLUME,
  setChannel
} from './app.js?v=13';
import { encodeWav, downloadBlob, exportFileName } from './export.js?v=13';
import { cleanEvents, cleanRack } from './persist.js?v=13';
import {
  stopPlayback,
  stopRecordingNow,
  updateSongInfo,
  renderKeyboard
} from './keyboard.js?v=13';
import { decodeSampleFile } from './decode-audio.js?v=13';

const SONG_FORMAT = 'patchbay-song';
const SONG_VERSION = 1;
const SONG_FILE = 'patch-bay-song';
const NOT_A_SONG = 'That file is not a Patch Bay song';

// A clipboard of bytes, in chunks so a long recording does not overflow the
// argument list of a single call.
function bytesToBase64(bytes) {
  let text = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(text);
}

function base64ToBytes(text) {
  const binary = atob(String(text));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// A context to decode the audio in. A song can be imported before the sound has
// been started, and the file's audio still has to be read back; an offline
// context decodes without opening the speakers. The live one is preferred when
// it exists, so the audio arrives at the rate it will be played at.
function decodeContext() {
  if (app.ctx) return app.ctx;
  try {
    return new OfflineAudioContext(1, 1, 44100);
  } catch (e) {
    return null;
  }
}

async function audioToBuffer(ctx, wav) {
  if (!ctx || !wav) return null;
  try {
    const bytes = base64ToBytes(wav);
    return await decodeSampleFile(ctx, bytes.buffer, 'song.wav');
  } catch (e) {
    console.warn('Could not read the audio in a song file', e);
    return null;
  }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function number(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// A rack as it goes into the file. Anything a module is holding that is audio —
// a Sampler's sample — becomes WAV text, so it can come back on the far side.
function packRack(rack) {
  if (!rack || !rack.modules || !rack.modules.length) return null;
  return {
    bpm: rack.bpm,
    master: rack.master,
    modules: rack.modules.map((m) => {
      const out = { id: m.id, type: m.type, x: m.x, y: m.y, params: m.params };
      const data = m.data || {};
      const buffer = data.buffer;
      if (buffer && typeof buffer.getChannelData === 'function') {
        try {
          out.audio = bytesToBase64(new Uint8Array(encodeWav(buffer)));
          if (data.name) out.audioName = String(data.name);
        } catch (e) {
          /* a module whose audio will not encode simply travels without it */
        }
      }
      return out;
    }),
    cables: rack.cables
  };
}

// A rack read back out of a file, with any sample it carried decoded again.
async function unpackRack(saved, ctx) {
  const rack = cleanRack(saved);
  if (!rack) return null;
  const savedModules = Array.isArray(saved.modules) ? saved.modules : [];
  for (const m of rack.modules) {
    const src = savedModules.find((x) => String(x && x.id) === m.id);
    if (!src || !src.audio) continue;
    const buffer = await audioToBuffer(ctx, src.audio);
    if (buffer) m.data = { buffer, name: src.audioName || 'Sample' };
  }
  return rack;
}

function packLyrics(take) {
  if (!take || !take.buffer) return null;
  try {
    return {
      offset: take.offset || 0,
      peak: take.peak || 0,
      wav: bytesToBase64(new Uint8Array(encodeWav(take.buffer)))
    };
  } catch (e) {
    return null;
  }
}

function readText(file) {
  if (file && typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.readAsText(file);
  });
}

// Everything the song is, ready to be written out or read back.
export function songData() {
  return {
    format: SONG_FORMAT,
    version: SONG_VERSION,
    savedAt: Date.now(),
    name: app.song.name,
    bpm: app.state.bpm,
    keyBase: app.keyBase,
    channel: app.song.channel,
    loop: app.song.loop,
    volumes: app.song.volumes.slice(0, CHANNEL_COUNT),
    channels: app.song.channels.slice(0, NOTE_CHANNEL_COUNT),
    racks: app.song.racks.map(packRack),
    lyrics: packLyrics(app.song.lyrics)
  };
}

// Write the song to a file the player keeps, to be imported again later.
// Resolves with the name it was saved under, which is the tune's own once it has
// been named at the top of the app or in the Mix sheet.
export async function saveSongFile() {
  const data = songData();
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json' });
  const name = exportFileName('json', SONG_FILE);
  await downloadBlob(blob, name);
  return name;
}

// Put a song file back into the app. Replaces the song — the channels, the racks
// they keep and the lyric take — and leaves the rack on screen as it is, since
// every channel plays through its own. Resolves with a short account of what
// arrived, or throws with something to tell the player.
export async function importSongFile(file) {
  if (!file) throw new Error('No file was chosen');
  const text = await readText(file);

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(NOT_A_SONG);
  }
  if (!data || typeof data !== 'object' || data.format !== SONG_FORMAT) {
    throw new Error(NOT_A_SONG);
  }

  const ctx = decodeContext();

  // The racks first: each may carry the sample a Sampler was holding, and that
  // has to be decoded before the song can be played.
  const savedRacks = Array.isArray(data.racks) ? data.racks : [];
  const racks = [];
  for (let i = 0; i < NOTE_CHANNEL_COUNT; i++) {
    racks.push(await unpackRack(savedRacks[i], ctx));
  }

  const savedChannels = Array.isArray(data.channels) ? data.channels : [];
  const channels = [];
  for (let i = 0; i < CHANNEL_COUNT; i++) channels.push(cleanEvents(savedChannels[i]));

  let lyrics = null;
  let lyricsLost = false;
  const savedLyrics = data.lyrics;
  if (savedLyrics && savedLyrics.wav) {
    const buffer = await audioToBuffer(ctx, savedLyrics.wav);
    if (buffer) {
      lyrics = {
        buffer,
        offset: Math.max(0, number(savedLyrics.offset, 0)),
        duration: buffer.duration,
        peak: Math.max(0, number(savedLyrics.peak, 0)),
        recordedAt: Date.now()
      };
    } else {
      lyricsLost = true;
    }
  }

  // The song that was open is put down before the file's takes take its place.
  stopRecordingNow();
  stopPlayback();
  // A lyric take stopped by that only lands a moment later; the file's takes
  // must not be overwritten by it on the way.
  await new Promise((resolve) => setTimeout(resolve, 400));

  app.song.channels = channels;
  app.song.racks = racks;
  app.song.lyrics = lyrics;
  app.song.loop = !!data.loop;
  // The mix the song was balanced to, channel by channel.
  const savedVolumes = Array.isArray(data.volumes) ? data.volumes : [];
  app.song.volumes = [];
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    app.song.volumes.push(clamp(number(savedVolumes[i], 1), 0, MAX_CHANNEL_VOLUME));
  }
  setChannel(clamp(Math.round(number(data.channel, 0)), 0, CHANNEL_COUNT - 1));

  // The song brings its name with it, so exporting a mix of it writes the same
  // name the file was saved under.
  app.song.name = typeof data.name === 'string' ? data.name.slice(0, 80) : '';

  if (data.bpm != null) {
    app.state.bpm = clamp(Math.round(number(data.bpm, app.state.bpm)), 40, 240);
    if (app.engine) app.engine.setBpm(app.state.bpm);
  }
  if (data.keyBase != null) {
    app.keyBase = clamp(Math.round(number(data.keyBase, app.keyBase)), 12, 72);
    renderKeyboard();
  }

  updateSongInfo();
  // Nothing is kept between visits: the song plays until the page is reloaded,
  // like every other session.

  let notes = 0;
  for (let i = 0; i < NOTE_CHANNEL_COUNT; i++) notes += channels[i].length;
  return { notes, lyrics: !!lyrics, lyricsLost, racks: racks.filter(Boolean).length };
}
