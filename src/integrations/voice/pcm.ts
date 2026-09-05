/** Resamples interleaved PCM16 samples without owning channel or provider policy. */
export function resamplePcm16(input: Int16Array, sourceRate: number, targetRate: number): Int16Array {
  if (input.length === 0) return new Int16Array();
  if (sourceRate === targetRate) return new Int16Array(input);
  const length = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * sourceRate / targetRate;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = Math.round((input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction);
  }
  return output;
}

/** Detects real leading PCM signal without treating digital silence as speech. */
export function hasAudiblePcm16(input: Buffer, threshold = 8): boolean {
  for (let offset = 0; offset + 1 < input.length; offset += 2) {
    if (Math.abs(input.readInt16LE(offset)) > threshold) return true;
  }
  return false;
}

/** Decodes complete little-endian PCM16 samples into independent storage. */
export function pcm16leToSamples(buffer: Buffer): Int16Array {
  const output = new Int16Array(Math.floor(buffer.length / 2));
  for (let index = 0; index < output.length; index += 1) output[index] = buffer.readInt16LE(index * 2);
  return output;
}

/** Encodes PCM16 samples as independent little-endian bytes. */
export function samplesToPcm16le(samples: Int16Array): Buffer {
  const output = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) output.writeInt16LE(samples[index] ?? 0, index * 2);
  return output;
}
