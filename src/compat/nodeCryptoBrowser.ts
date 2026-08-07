export function randomBytes(size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 0 || size > 65_536) throw new Error('Invalid cryptographic random byte request');
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
