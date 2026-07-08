/** Live, in-memory service state exposed via GET /status. */
export interface ServiceState {
  startedAt: string;
  /** Jupiter session established. */
  authenticated: boolean;
  /** ZenMoney token available (env or UI-provided). */
  zenConnected: boolean;
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
    zenConnected: false,
    status: "starting",
    lastSyncAt: null,
    lastSyncOk: null,
    lastError: null,
    lastResult: null,
    nextSyncAt: null,
    syncCount: 0,
  };
}
