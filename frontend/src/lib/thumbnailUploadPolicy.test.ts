import { describe, expect, it } from 'vitest';
import { runWithOptionalThumbnail } from './thumbCapture.ts';
import { captureWithRetries } from './thumbRetry.ts';

describe('optional thumbnail upload policy', () => {
  it('continues the upload with no thumbnail after three capture failures', async () => {
    let captureAttempts = 0;
    let receivedThumb: Blob | null | undefined;

    const result = await runWithOptionalThumbnail(
      captureWithRetries(async () => {
        captureAttempts += 1;
        throw new Error('decode failed');
      }, 1000, 3),
      async (thumb) => {
        receivedThumb = thumb;
        return 'uploaded';
      },
    );

    expect(captureAttempts).toBe(3);
    expect(receivedThumb).toBeNull();
    expect(result).toBe('uploaded');
  });
});
