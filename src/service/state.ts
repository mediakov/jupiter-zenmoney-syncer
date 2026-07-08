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

/** How a single transaction was mapped into ZenMoney. */
export type SyncKind = "expense" | "income" | "transfer";

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
      type: string;
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
        /** Old income records retired because the deposit became a transfer. */
        deletions: number;
        /** What was actually sent to ZenMoney this run (the delta; 0 when nothing changed). */
        pushedThisRun: { accounts: number; transactions: number; deletions: number };
        serverTimestamp: number | null;
        /** Per-kind counts + summed amounts over the whole window (context, not "this run"). */
        counts: Record<SyncKind, number>;
        totals: Record<SyncKind, number>;
        /** The transactions actually sent to ZenMoney this run (the delta; empty when nothing changed). */
        sentSample: Array<{
          date: string;
          kind: SyncKind;
          amount: number;
          currency: string;
          account: string;
          /** For transfers: the account the money came from. */
          source: string | null;
          payee: string | null;
          mcc: number | null;
          /** Original-currency amount when the purchase was a conversion, e.g. "-42.00 EUR". */
          op: string | null;
          hold: boolean;
        }>;
        /** How every deposit was handled — the "deposit → transfer" reasoning. */
        deposits: Array<{
          date: string;
          amount: number;
          currency: string;
          result: "transfer" | "income";
          detail: string;
          sig: string | null;
        }>;
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
