// Twilio Media Streams speak mulaw/8000 (G.711 μ-law). Hume's Expression Measurement realtime endpoint
// (/v1/expression/audio/realtime) takes only raw s16le PCM at 16 kHz, mono. This is the one-way conversion the voice
// read needs (services/mediaStreamBridge.ts): μ-law decode, then 8 kHz -> 16 kHz.
//
// Rebuilt 2026-10-23 from the Hume EVI bridge's codec (removed in 48e970a6 when calls moved to ElevenLabs): the same
// ITU-T G.711 decode table and linear resampler. The encode direction and the WAV reader went with the two-way bridge;
// the voice read only listens.

const BIAS = 0x84;

// Standard G.711 μ-law decode table (all 256 byte values -> 16-bit PCM).
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const muVal = ~i & 0xff;
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

// Linear-interpolation resampler: good enough for phone-quality voice, no DSP dependency.
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

export const TWILIO_RATE = 8000;
export const HUME_RATE = 16000;

// Twilio's caller audio (mulaw 8 kHz) as the bytes Hume reads: s16le, 16 kHz, mono, no header. Always an even length.
export function mulaw8kToPcm16k(mulaw: Buffer): Buffer {
  const pcm = resampleLinear(decodeMulawBuffer(mulaw), TWILIO_RATE, HUME_RATE);
  const out = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], i * 2);
  return out;
}

// Milliseconds of audio in a s16le 16 kHz mono buffer.
export const pcm16kMs = (bytes: number): number => (bytes / 2 / HUME_RATE) * 1000;
