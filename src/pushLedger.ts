import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DiffAccount, DiffDeletion, DiffTransaction } from "./toDiff.js";

interface LedgerData {
  /** account/transaction id → the `changed` value we last successfully pushed. */
  accounts: Record<string, number>;
  transactions: Record<string, number>;
  /** deletion ids we've already sent (a deletion only needs sending once). */
  deletions: string[];
}

export interface PushSet {
  accounts: DiffAccount[];
  transactions: DiffTransaction[];
  deletions: DiffDeletion[];
}

/**
 * Remembers what we've already pushed to ZenMoney so re-syncs send only new or
 * changed records instead of re-transmitting the whole window every time.
 *
 * A record is "already pushed" when its id maps to the same `changed` value; a
 * deletion is "already sent" once its id is recorded. Persisted to a file on the
 * data volume (0600). If the file is lost, the next sync simply re-sends
 * everything once and rebuilds the ledger — the push is idempotent either way.
 */
export class PushLedger {
  private data: LedgerData = { accounts: {}, transactions: {}, deletions: [] };
  private delSet: Set<string>;

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.data = { accounts: {}, transactions: {}, deletions: [], ...JSON.parse(readFileSync(path, "utf8")) };
      } catch {
        this.data = { accounts: {}, transactions: {}, deletions: [] };
      }
    }
    this.delSet = new Set(this.data.deletions);
  }

  /** Keep only the records that are new or whose `changed` differs from last push. */
  pending(accounts: DiffAccount[], transactions: DiffTransaction[], deletions: DiffDeletion[]): PushSet {
    return {
      accounts: accounts.filter((a) => this.data.accounts[a.id] !== a.changed),
      transactions: transactions.filter((t) => this.data.transactions[t.id] !== t.changed),
      deletions: deletions.filter((d) => !this.delSet.has(d.id)),
    };
  }

  /**
   * Drop ledger entries whose id is no longer in the current window (e.g. a
   * transaction that aged out of SYNC_YEARS), keeping the file bounded to the
   * active set. Only rewrites the file if something was actually pruned, so a
   * steady-state sync stays write-free. Returns true if anything was removed.
   */
  retain(accounts: DiffAccount[], transactions: DiffTransaction[], deletions: DiffDeletion[]): boolean {
    const keepA = new Set(accounts.map((a) => a.id));
    const keepT = new Set(transactions.map((t) => t.id));
    const keepD = new Set(deletions.map((d) => d.id));
    let changed = false;
    for (const id of Object.keys(this.data.accounts)) if (!keepA.has(id)) { delete this.data.accounts[id]; changed = true; }
    for (const id of Object.keys(this.data.transactions)) if (!keepT.has(id)) { delete this.data.transactions[id]; changed = true; }
    const keptDeletions = this.data.deletions.filter((id) => keepD.has(id));
    if (keptDeletions.length !== this.data.deletions.length) {
      this.data.deletions = keptDeletions;
      this.delSet = new Set(keptDeletions);
      changed = true;
    }
    if (changed) this.flush();
    return changed;
  }

  /** Record a successful push and persist. */
  record(set: PushSet): void {
    for (const a of set.accounts) this.data.accounts[a.id] = a.changed;
    for (const t of set.transactions) this.data.transactions[t.id] = t.changed;
    for (const d of set.deletions) {
      if (!this.delSet.has(d.id)) {
        this.delSet.add(d.id);
        this.data.deletions.push(d.id);
      }
    }
    this.flush();
  }

  private flush(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }
}
