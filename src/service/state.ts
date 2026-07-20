import type { ProviderDetail, ProviderId } from "./providers.js";

/** Per-card connection state. Each card logs in on its own. */
export interface ProviderState {
  id: ProviderId;
  label: string;
  /** Account email in use (env, UI-provided, or null if unset). */
  email: string | null;
  /** A session is established for this card. */
  authenticated: boolean;
  /** Whether this card is switched on for syncing (UI toggle). A disabled card is skipped. */
  enabled: boolean;
}

/** Live, in-memory service state exposed via GET /status. */
export interface ServiceState {
  startedAt: string;
  /**
   * One entry per card. Replaces the old single `jupiterEmail`/`authenticated` pair:
   * with two cards there is no one answer to "are we authenticated", and collapsing them
   * would hide a card that needs a login behind one that does not.
   */
  providers: ProviderState[];
  /** ZenMoney token available (env or UI-provided). */
  zenConnected: boolean;
  /** `needs-auth` means at least one CONFIGURED card has no session. */
  status: "starting" | "needs-auth" | "idle" | "syncing" | "error";
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  lastResult: { accounts: number; transactions: number; sent: number; pushed: boolean } | null;
  nextSyncAt: string | null;
  syncCount: number;
}

/** How a single transaction was mapped into ZenMoney. */
export type SyncKind = "expense" | "income" | "transfer";

/** Detailed snapshot of the last sync — what we read and what we pushed. */
export interface SyncDetail {
  at: string;
  /**
   * What each card returned this run — one entry per card that was read. Replaces the old
   * `jupiter` block; the fields are nullable throughout because that mirrors what the APIs
   * actually return. Showing "—" is honest; inventing a 0 or "" is not.
   */
  sources: ProviderDetail[];
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
          /** Which card it came from, so a merged feed stays readable. */
          provider: ProviderId | null;
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

export function initialState(providers: ProviderState[] = []): ServiceState {
  return {
    startedAt: new Date().toISOString(),
    providers,
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
