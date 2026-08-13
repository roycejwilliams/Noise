// Twilio Media Streams speaks mulaw/8000 (G.711 μ-law); Hume EVI only accepts
// linear16 PCM (mulaw is explicitly unsupported per Hume's audio guide). This
// module is the transcoding layer the media-stream bridge needs in both
// directions — standard ITU-T G.711 μ-law tables, no external dependency.
// Ported as-is from co-test/src/services/audioCodec.ts (proven there first).

const BIAS = 0x84;
const CLIP = 32635;

// Standard G.711 μ-law decode table (all 256 byte values -> 16-bit PCM).
// Table form is both simpler to verify against the spec and faster than
// computing the segment/exponent per sample on every call.
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let muVal = ~i & 0xff;
  const sign = muVal & 0x80;
  const exponent = (muVal >> 4) & 0x07;
  const mantissa = muVal & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

export function decodeMulawBuffer(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = MULAW_DECODE_TABLE[buf[i]];
  return out;
}

// Linear16 -> mulaw encode, direct port of the reference G.711 algorithm
// (the same one libsndfile/asterisk/etc use) rather than a table, since the
// input domain is the full 16-bit range.
function linear16ToMulawSample(sampleIn: number): number {
  let sample = sampleIn;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

export function encodeMulawBuffer(samples: Int16Array): Buffer {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = linear16ToMulawSample(samples[i]);
  return out;
}

// Parses just enough of a WAV file (RIFF/WAVE, "fmt " + "data" chunks) to
// pull out sample rate and raw PCM16 samples — Hume's audio_output messages
// are documented as "a base64-encoded WAV file", so this is required just to
// get at the samples, not a general-purpose WAV reader.
export function parseWav(buf: Buffer): { sampleRate: number; channels: number; samples: Int16Array } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("parseWav: not a RIFF/WAVE buffer");
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkBodyStart = offset + 8;

    if (chunkId === "fmt ") {
      channels = buf.readUInt16LE(chunkBodyStart + 2);
      sampleRate = buf.readUInt32LE(chunkBodyStart + 4);
      bitsPerSample = buf.readUInt16LE(chunkBodyStart + 14);
    } else if (chunkId === "data") {
      dataStart = chunkBodyStart;
      dataLength = chunkSize;
    }

    // Chunks are word-aligned — an odd chunkSize has a padding byte after it.
    offset = chunkBodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataStart === -1 || !sampleRate) {
    throw new Error("parseWav: missing fmt or data chunk");
  }
  if (bitsPerSample !== 16) {
    throw new Error(`parseWav: unsupported bitsPerSample ${bitsPerSample} (expected 16)`);
  }

  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * 2);
  }

  return { sampleRate, channels, samples };
}

// Simple linear-interpolation resampler — good enough for phone-quality
// (8kHz) voice audio, no external DSP dependency. Only used on Hume's TTS
// output (typically 24kHz+) going down to Twilio's fixed 8kHz; the input
// direction never needs resampling since we declare Hume's input format as
// 8kHz linear16 to match Twilio's native rate exactly.
export function resampleLinear(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const s0 = samples[srcIndex] ?? samples[samples.length - 1] ?? 0;
    const s1 = samples[srcIndex + 1] ?? s0;
    out[i] = Math.round(s0 + (s1 - s0) * frac);
  }
  return out;
}

// Downmixes interleaved multi-channel PCM16 to mono by averaging channels —
// Twilio Media Streams is always mono, Hume's TTS output may not be.
export function toMono(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples;
  const frameCount = Math.floor(samples.length / channels);
  const out = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
    out[i] = Math.round(sum / channels);
  }
  return out;
}
