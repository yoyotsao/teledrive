/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TELEGRAM_API_ID: string
  readonly VITE_TELEGRAM_API_HASH: string
  readonly VITE_TELEGRAM_SESSION: string
  readonly VITE_API_URL: string
  readonly VITE_E2E_TEST_HOOKS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  __TELEDRIVE_FAILOVER_TEST__?: {
    start(): Promise<void>;
    releaseIdleAccount(): Promise<void>;
    settleLateSource(): Promise<void>;
    finishTarget(): Promise<void>;
    snapshot(): { sourceFinalizeCalls: number; targetFinalizeCalls: number; migrations: number };
  };
}
