import { AppError } from '../errors.js';

export const MAX_RECORDING_SECONDS = 60;
export const MAX_AUDIO_BYTES = 2_881_024;
export const MAX_TEXT_CHARACTERS = 2000;

// Accept only the documented Meta file format. Strip ancillary WAV chunks so
// neither names nor device metadata accompany an intentional recording.
export function validateWav(buffer) {
  const invalid = () => { throw new AppError('Record mono, 16-bit PCM WAV at 16 or 24 kHz.', 415); };
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) invalid();
  if (buffer.length > MAX_AUDIO_BYTES) throw new AppError('Recording is too large. Keep it under 60 seconds.', 413);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE' || buffer.readUInt32LE(4) !== buffer.length - 8) invalid();
  let format;
  let samples;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) invalid();
    if (id === 'fmt ') {
      if (format || size < 16) invalid();
      format = buffer.subarray(start, start + 16);
    } else if (id === 'data') {
      if (samples) invalid();
      samples = buffer.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (offset !== buffer.length || !format || !samples?.length || samples.length % 2) invalid();
  const sampleRate = format.readUInt32LE(4);
  if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 ||
      ![16_000, 24_000].includes(sampleRate) || format.readUInt16LE(14) !== 16 ||
      format.readUInt16LE(12) !== 2 || format.readUInt32LE(8) !== sampleRate * 2) invalid();
  const durationMs = samples.length / (sampleRate * 2) * 1000;
  if (durationMs > MAX_RECORDING_SECONDS * 1000) throw new AppError('Recording exceeds the 60-second limit.', 413);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); format.copy(header, 20);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  return { sampleRate, durationMs, audio: Buffer.concat([header, samples]) };
}
