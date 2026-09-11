import { useCallback, useEffect, useRef, useState } from 'react';
import { createRenderScheduler } from '../lib/renderScheduler';
import type { UploadDestination } from '../lib/uploadIdentity';
import {
  createUploadQueuePublisher,
  createUploadQueueStore,
  initialUploadQueueState,
  type UploadAction,
  type UploadQueueStore,
  type UploadQueueState,
} from '../lib/uploadQueue';

export interface UploadQueueApi {
  state: UploadQueueState;
  /** 同步套用並回傳新的 snapshot，讓呼叫端立刻讀 state.resolutions[id]。 */
  dispatch: (action: UploadAction) => UploadQueueState;
  enqueueFile: (file: File, destination: UploadDestination) => string;
  holdFile: (id: string, file: File) => void;
  releaseFile: (id: string) => void;
}

export function useUploadQueue(): UploadQueueApi {
  const storeRef = useRef<UploadQueueStore | null>(null);
  if (storeRef.current === null) storeRef.current = createUploadQueueStore(initialUploadQueueState);
  const store = storeRef.current;
  const [snapshot, setSnapshot] = useState<UploadQueueState>(() => store.snapshot());
  const scheduler = useRef(createRenderScheduler()).current;
  const publisherRef = useRef<ReturnType<typeof createUploadQueuePublisher> | null>(null);
  if (publisherRef.current === null) {
    publisherRef.current = createUploadQueuePublisher(store, scheduler, setSnapshot);
  }
  const publisher = publisherRef.current;
  // File 參照只活在這裡，永遠不進 React 顯示狀態。
  const filesRef = useRef(new Map<string, File>());

  useEffect(() => () => publisher.cancel(), [publisher]);

  const dispatch = useCallback((action: UploadAction): UploadQueueState => {
    return publisher.dispatch(action);
  }, [publisher]);

  const enqueueFile = useCallback((file: File, destination: UploadDestination): string => {
    const id = crypto.randomUUID();
    dispatch({
      type: 'enqueue', id, name: file.name, size: file.size,
      lastModified: file.lastModified, destination, now: Date.now(),
    });
    return id;
  }, [dispatch]);

  const holdFile = useCallback((id: string, file: File) => { filesRef.current.set(id, file); }, []);
  const releaseFile = useCallback((id: string) => { filesRef.current.delete(id); }, []);

  useEffect(() => {
    if (import.meta.env.VITE_E2E_TEST_HOOKS !== '1') return;

    let disposed = false;
    let bridge: Window['__TELEDRIVE_FAILOVER_TEST__'];
    void import('../testing/failoverHarness').then(({ createFailoverHarness }) => {
      if (disposed) return;
      bridge = createFailoverHarness(dispatch);
      window.__TELEDRIVE_FAILOVER_TEST__ = bridge;
    });

    return () => {
      disposed = true;
      if (window.__TELEDRIVE_FAILOVER_TEST__ === bridge) delete window.__TELEDRIVE_FAILOVER_TEST__;
    };
  }, [dispatch]);

  return { state: snapshot, dispatch, enqueueFile, holdFile, releaseFile };
}
