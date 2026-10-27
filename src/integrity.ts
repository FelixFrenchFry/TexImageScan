export async function verifyBytes(
  bytes: Uint8Array<ArrayBuffer>,
  file: { size: number; sha256: string },
): Promise<void> {
  if (bytes.byteLength !== file.size)
    throw new Error('Model file size does not match the pinned manifest');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== file.sha256)
    throw new Error('Model file checksum does not match the pinned manifest');
}
