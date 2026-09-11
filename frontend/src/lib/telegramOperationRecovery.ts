export interface OperationMapping {
  randomId: string;
  messageId: number;
}

export type MappingApplyResult = 'applied' | 'duplicate' | 'conflict';

export class OperationMappingReducer {
  private readonly mappings = new Map<string, OperationMapping>();

  apply(mapping: OperationMapping): MappingApplyResult {
    const existing = this.mappings.get(mapping.randomId);
    if (!existing) {
      this.mappings.set(mapping.randomId, { ...mapping });
      return 'applied';
    }
    if (existing.messageId === mapping.messageId) return 'duplicate';
    return 'conflict';
  }

  get(randomId: string): OperationMapping | undefined {
    const value = this.mappings.get(randomId);
    return value ? { ...value } : undefined;
  }
}

export type RecoveryPhase = 'intent_persisted' | 'rpc_started' | 'result_persisted';

export interface RecoveryCursor {
  ownerId: number;
  operationId: string;
  randomId: string;
  uploaderId: number;
  targetPeerKey: string;
  phase: RecoveryPhase;
}

export interface RecoveryStoreAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

const CURSOR_KEY = 'telegram-operation-recovery-cursor';
const DB_NAME = 'teledrive-operation-recovery';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function openRecoveryDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable');
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open operation recovery database'));
  });
}

export class IndexedDbRecoveryStore implements RecoveryStoreAdapter {
  async get<T>(key: string): Promise<T | undefined> {
    const db = await openRecoveryDb();
    try {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      return (await requestAsPromise(transaction.objectStore(STORE_NAME).get(key))) as T | undefined;
    } finally {
      db.close();
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const db = await openRecoveryDb();
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      await requestAsPromise(transaction.objectStore(STORE_NAME).put(value, key));
    } finally {
      db.close();
    }
  }

  async delete(key: string): Promise<void> {
    const db = await openRecoveryDb();
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      await requestAsPromise(transaction.objectStore(STORE_NAME).delete(key));
    } finally {
      db.close();
    }
  }
}

export class RecoveryCursorStore {
  readonly adapter: RecoveryStoreAdapter;

  constructor(adapter: RecoveryStoreAdapter = new IndexedDbRecoveryStore()) {
    this.adapter = adapter;
  }

  load(): Promise<RecoveryCursor | undefined> {
    return this.adapter.get<RecoveryCursor>(CURSOR_KEY);
  }

  save(cursor: RecoveryCursor): Promise<void> {
    return this.adapter.set(CURSOR_KEY, cursor);
  }

  clear(): Promise<void> {
    return this.adapter.delete(CURSOR_KEY);
  }
}

export interface RecoverableOperation {
  operation_id: string;
  version: number;
  result_version?: number | null;
  state: string;
  random_id: string;
  uploader_id: number;
  target_peer_key: string;
}

export interface FrozenReadResult {
  mapping: Record<string, unknown>;
  mediaIdentity: Record<string, unknown>;
}

export interface ReconciledOperationResult {
  operation_id: string;
  version: number;
  result_version?: number | null;
  state: string;
}

export interface RecoveryDependencies {
  store?: RecoveryCursorStore;
  listOperations(): Promise<RecoverableOperation[]>;
  readFrozenResult(operation: RecoverableOperation): Promise<FrozenReadResult | null>;
  persistReconciledOperationResult(params: {
    operationId: string;
    expectedOperationVersion: number;
    mapping: Record<string, unknown>;
    mediaIdentity: Record<string, unknown>;
  }): Promise<ReconciledOperationResult>;
  send(operation: RecoverableOperation): Promise<unknown>;
}

export interface RecoveryOutcome {
  operationId: string;
  status: 'reconciled' | 'pending';
  resultVersion?: number;
}

/**
 * Recovery deliberately never performs a blind resend. A pending/uncertain
 * operation is first reduced against a read of its frozen Telegram identity;
 * only complete authoritative JSON is handed to the metadata API.
 */
export async function recoverPendingOperations(deps: RecoveryDependencies): Promise<RecoveryOutcome[]> {
  const store = deps.store ?? new RecoveryCursorStore();
  const cursor = await store.load();
  const operations = await deps.listOperations();
  const candidates = operations.filter((operation) => {
    if (!cursor) return ['sending', 'recovering', 'retryable', 'uncertain'].includes(operation.state);
    return operation.operation_id === cursor.operationId;
  });

  const outcomes: RecoveryOutcome[] = [];
  for (const operation of candidates) {
    if (!['recovering', 'uncertain', 'sending', 'retryable'].includes(operation.state)) continue;

    const frozen = await deps.readFrozenResult(operation);
    if (!frozen) {
      outcomes.push({ operationId: operation.operation_id, status: 'pending' });
      continue;
    }

    const persisted = await deps.persistReconciledOperationResult({
      operationId: operation.operation_id,
      expectedOperationVersion: operation.version,
      mapping: frozen.mapping,
      mediaIdentity: frozen.mediaIdentity,
    });

    const resultVersion = persisted.result_version ?? undefined;
    if (cursor?.operationId === operation.operation_id && resultVersion !== undefined) {
      await store.save({ ...cursor, phase: 'result_persisted' });
    }
    outcomes.push({
      operationId: operation.operation_id,
      status: 'reconciled',
      ...(resultVersion === undefined ? {} : { resultVersion }),
    });
  }

  return outcomes;
}
