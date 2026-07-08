/** Live, in-memory service state exposed via GET /status. */
export interface ServiceState {
  startedAt: string;
  authenticated: boolean;
  /** "ok" | "syncing" | "error" | "needs-auth". */
  status: "starting" | "needs-auth" | "idle" | "syncing" | "error";
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  lastResult: { accounts: number; transactions: number; pushed: boolean } | null;
  nextSyncAt: string | null;
  syncCount: number;
}

export function initialState(): ServiceState {
  return {
    startedAt: new Date().toISOString(),
    authenticated: false,
    status: "starting",
    lastSyncAt: null,
    lastSyncOk: null,
    lastError: null,
    lastResult: null,
    nextSyncAt: null,
    syncCount: 0,
  };
}
