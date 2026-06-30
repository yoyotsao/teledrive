const SAMPLE_SIZE = 100 * 1024 * 1024; // first 100 MB

/**
 * Fast dedup fingerprint: SHA-256 of the first 100 MB + file size.
 * Format: "<hex64>:<size>". Returns a lowercase string.
 */
export async function sha256File(file: File): Promise<string> {
  const sample = file.size > SAMPLE_SIZE ? file.slice(0, SAMPLE_SIZE) : file;
  const buffer = await sample.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex}:${file.size}`;
}
