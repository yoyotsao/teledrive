import type { Segment } from './segmentPlan';

export type SegmentResult = {
  index: number;
  message_id: number;
  file_id: string;
  access_hash?: string;
  size: number;
  account_id: number;
};

export type SegmentState = 'pending' | 'active' | 'migrating' | 'finalizing' | 'completed' | 'failed';

export interface AttemptLease {
  taskId: string;
  attemptId: number;
  accountId: number;
}

export interface SegmentMigrationEvent {
  fileJobId: string;
  taskId: string;
  segmentIndex: number;
  abandonedLogicalBytes: number;
  logicalFileBytes: number;
  totalFileBytes: number;
  message: '重新分派上傳帳號，該區段將從頭重傳';
}

export interface SegmentProgressEvent {
  logicalFileBytes: number;
  totalFileBytes: number;
}

export interface PremiumFloodNotice {
  waitSeconds: number;
  penaltyUntil: number;
  pacerMode: 'frozen';
  scheduledRate: number;
}

export interface SegmentAttemptHooks {
  signal: AbortSignal;
  onRpcStart(): boolean;
  onRpcSettled(): void;
  onPartAccepted(partIndex: number, bytes: number): void;
  onPremiumFlood(event: PremiumFloodNotice): void;
  grantFinalize(): boolean;
}

export interface SegmentAttemptInput {
  lease: AttemptLease;
  file: File;
  segment: Segment;
  thumb?: Blob | null;
  hooks: SegmentAttemptHooks;
}

export interface SegmentAttemptRunner {
  accountId: number;
  accountName: string;
  run(input: SegmentAttemptInput): Promise<SegmentResult & { hasThumbnail: boolean }>;
}

export interface SegmentFileJobInput {
  fileJobId: string;
  file: File;
  segments: Segment[];
  runners: SegmentAttemptRunner[];
  thumb?: Blob | null;
  migrationEnabled?: boolean;
  onProgress?: (event: SegmentProgressEvent) => void;
  onMigration?: (event: SegmentMigrationEvent) => void;
}
