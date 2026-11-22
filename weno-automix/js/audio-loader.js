// audio-loader.js — Decode audio files to Float32 channel arrays.
//
// WAV is parsed natively so the original sample rate is preserved
// (Web Audio's decodeAudioData resamples to the context rate).
// Everything else (AIFF on Safari, FLAC, MP3, M4A...) falls back to
// decodeAudioData on an OfflineAudioContext at 48 kHz.

/**
 * @typedef {Object} DecodedAudio
 * @property {string} name
 * @property {number} sampleRate
 * @property {Float32Array[]} channels
 * @property {string} decoder  "wav-native" | "webaudio"
 */

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** Parse a RIFF/WAVE buffer. Returns null if it is not a WAV we understand. */
export function parseWav(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12) return null;
  if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE') return null;

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const id = readFourCC(view, offset);
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      let format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (format === 0xFFFE && size >= 26) {
        // WAVE_FORMAT_EXTENSIBLE: real format is the first 2 bytes of SubFormat GUID
        format = view.getUint16(body + 24, true);
      }
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      dataOffset = body;
      // Some writers put 0 or 0xFFFFFFFF for streamed files — clamp to file end
      if (size === 0 || body + size > buffer.byteLength) size = buffer.byteLength - body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt || dataOffset < 0) return null;
  const { format, channels: nCh, sampleRate, bits } = fmt;
  const bytesPerSample = bits / 8;
  if (!Number.isInteger(bytesPerSample) || nCh < 1) return null;
  const frameSize = bytesPerSample * nCh;
  const nFrames = Math.floor(dataSize / frameSize);

  const channels = Array.from({ length: nCh }, () => new Float32Array(nFrames));
  let p = dataOffset;

  if (format === 1) { // integer PCM
    if (bits === 16) {
      for (let i = 0; i < nFrames; i++)
        for (let c = 0; c < nCh; c++, p += 2) channels[c][i] = view.getInt16(p, true) / 32768;
    } else if (bits === 24) {
      const u8 = new Uint8Array(buffer);
      for (let i = 0; i < nFrames; i++)
        for (let c = 0; c < nCh; c++, p += 3) {
          let v = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
          if (v & 0x800000) v -= 0x1000000;
          channels[c][i] = v / 8388608;
        }
    } else if (bits === 32) {
      for (let i = 0; i < nFrames; i++)
        for (let c = 0; c < nCh; c++, p += 4) channels[c][i] = view.getInt32(p, true) / 2147483648;
    } else if (bits === 8) {
      for (let i = 0; i < nFrames; i++)
        for (let c = 0; c < nCh; c++, p += 1) channels[c][i] = (view.getUint8(p) - 128) / 128;
    } else return null;
  } else if (format === 3) { // IEEE float
    if (bits === 32) {
      for (let i = 0; i < nFrames; i++)
        for (let c = 0; c < nCh; c++, p += 4) channels[c][i] = view.getFloat32(p, true);
    } else if (bits === 64) {
      for (let i = 0; i < nFrames; i++)
        for (let c = 0; c < nCh; c++, p += 8) channels[c][i] = view.getFloat64(p, true);
    } else return null;
  } else {
    return null; // compressed WAV (ADPCM etc.) -> let the browser try
  }

  return { sampleRate, channels };
}

/**
 * Decode a File/Blob into channel arrays.
 * @param {File} file
 * @returns {Promise<DecodedAudio>}
 */
export async function decodeFile(file) {
  const buffer = await file.arrayBuffer();
  const wav = parseWav(buffer);
  if (wav) return { name: file.name, ...wav, decoder: 'wav-native' };

  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new Error(`${file.name}: このブラウザは音声デコードに対応していません`);
  const ctx = new Ctx(1, 1, 48000);
  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
  } catch (e) {
    throw new Error(`${file.name}: デコードできませんでした（WAV推奨。AIFFはSafariのみ対応）`);
  }
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(new Float32Array(audioBuffer.getChannelData(c)));
  }
  return { name: file.name, sampleRate: audioBuffer.sampleRate, channels, decoder: 'webaudio' };
}

/** Encode Float32 channels to a 16-bit PCM WAV Blob (used by the sample generator). */
export function encodeWav16(channels, sampleRate) {
  const nCh = channels.length;
  const n = channels[0].length;
  const dataSize = n * nCh * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * 2, true); v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, dataSize, true);
  let p = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < nCh; c++, p += 2) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(p, Math.round(s * 32767), true);
    }
  return new Blob([buf], { type: 'audio/wav' });
}
