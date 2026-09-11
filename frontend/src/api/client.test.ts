import axios, { AxiosError, type AxiosResponse } from 'axios';
import { expect, it } from 'vitest';
import { RETIRE_PENDING_UPLOAD_STATISTIC } from '../lib/uploadStatistics';
import { classifyUploadStatisticsFailure } from './client';

function response(status: number, detail: string): AxiosResponse {
  return {
    data: { detail }, status, statusText: '', headers: {}, config: { headers: new axios.AxiosHeaders() },
  };
}

it('classifies only the upload endpoint account-not-linked 403 as permanently rejected', () => {
  const permanentlyRejected = new AxiosError('Forbidden', undefined, undefined, undefined,
    response(403, 'Account is not linked to this drive'));
  const forbiddenForAnotherReason = new AxiosError('Forbidden', undefined, undefined, undefined,
    response(403, 'Forbidden'));
  const unavailable = new AxiosError('Unavailable', undefined, undefined, undefined,
    response(503, 'Unavailable'));

  expect(classifyUploadStatisticsFailure(permanentlyRejected)).toBe(RETIRE_PENDING_UPLOAD_STATISTIC);
  expect(classifyUploadStatisticsFailure(forbiddenForAnotherReason)).toBeUndefined();
  expect(classifyUploadStatisticsFailure(unavailable)).toBeUndefined();
});
