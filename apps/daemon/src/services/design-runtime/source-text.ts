/** Preserve exact selected source bytes, including a BOM; binary bundles use the full-package import. */
export function decodeDesignRuntimeSource(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Selected design-runtime source must contain valid UTF-8 bytes.');
  return text;
}
