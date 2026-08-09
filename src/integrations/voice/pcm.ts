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
