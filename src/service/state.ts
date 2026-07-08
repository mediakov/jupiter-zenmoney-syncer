/** Live, in-memory service state exposed via GET /status. */
export interface ServiceState {
  startedAt: string;
  /** Jupiter account email in use (env, UI-provided, or null if unset). */
  jupiterEmail: string | null;
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

/** Detailed snapshot of the last sync — what we read and what we pushed. */
export interface SyncDetail {
  at: string;
  jupiter: {
    cards: Array<{ last4: string; status: string }>;
    balance: { currency: string; spendableBalance: number; withdrawableBalance: number } | null;
    transactionCount: number;
    /** A sample of the most recent transactions. */
    transactions: Array<{
      id: string;
      date: string;
      direction: string;
      amount: string;
      currency: string;
      merchant: string | null;
    }>;
  };
  zenmoney:
    | {
        pushed: true;
        accounts: number;
        transactions: number;
        serverTimestamp: number | null;
        /** A sample of the diff transactions actually sent. */
        transactionsSample: Array<{ id: string; date: string; income: number; outcome: number; payee: string | null }>;
      }
    | { pushed: false; reason: string };
}

export function initialState(): ServiceState {
  return {
    startedAt: new Date().toISOString(),
    jupiterEmail: null,
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
