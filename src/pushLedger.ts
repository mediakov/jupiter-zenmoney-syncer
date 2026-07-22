import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DiffAccount, DiffDeletion, DiffTransaction } from "./toDiff.js";

interface LedgerData {
  /** account/transaction id → the `changed` value we last successfully pushed. */
  accounts: Record<string, number>;
  transactions: Record<string, number>;
  /** deletion ids we've already sent (a deletion only needs sending once). */
  deletions: string[];
  /**
   * Ids we last pushed as a HOLD (a pending authorisation). Tracked so that a hold which
   * later vanishes from the source — e.g. a merchant re-authorises and the provider issues a
   * brand-new id, orphaning the old one — can be deleted from ZenMoney instead of lingering
   * as a duplicate. Only holds: a settled record that ages out of the window is real history
   * and is never auto-deleted.
   */
  holds: string[];
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
  private data: LedgerData = { accounts: {}, transactions: {}, deletions: [], holds: [] };
  private delSet: Set<string>;
  private holdSet: Set<string>;

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.data = { accounts: {}, transactions: {}, deletions: [], holds: [], ...JSON.parse(readFileSync(path, "utf8")) };
      } catch {
        this.data = { accounts: {}, transactions: {}, deletions: [], holds: [] };
      }
    }
    this.delSet = new Set(this.data.deletions);
    this.holdSet = new Set(this.data.holds);
  }

  /**
   * Deletions for holds we previously pushed that are no longer in the current source set.
   *
   * A pending authorisation that disappears has either settled under a new id or been
   * re-authorised (again, a new id) — the old record is stale and would otherwise show as a
   * duplicate. Safe because a partial/failed read throws upstream rather than returning a
   * short list, so this only ever runs against a complete set of current transactions.
   */
  staleHoldDeletions(currentTransactionIds: Set<string>, userId: number, stamp: number): DiffDeletion[] {
    const stale: DiffDeletion[] = [];
    for (const id of this.holdSet) {
      if (!currentTransactionIds.has(id)) stale.push({ id, object: "transaction", stamp, user: userId });
    }
    return stale;
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
    // A tracked hold no longer in the window is dropped from the set too — either it was just
    // deleted (its deletion is in `deletions`) or it settled/aged out under the same id.
    for (const id of [...this.holdSet]) if (!keepT.has(id)) { this.holdSet.delete(id); changed = true; }
    if (changed) {
      this.data.holds = [...this.holdSet];
      this.flush();
    }
    return changed;
  }

  /** Record a successful push and persist. */
  record(set: PushSet): void {
    for (const a of set.accounts) this.data.accounts[a.id] = a.changed;
    for (const t of set.transactions) {
      this.data.transactions[t.id] = t.changed;
      // Track whether this id is currently a hold, so a later disappearance can be cleaned
      // up. A record that settled (hold no longer true) drops out of the hold set.
      if (t.hold === true) this.holdSet.add(t.id);
      else this.holdSet.delete(t.id);
    }
    for (const d of set.deletions) {
      if (!this.delSet.has(d.id)) {
        this.delSet.add(d.id);
        this.data.deletions.push(d.id);
      }
      // A deleted record is no longer a hold to track.
      this.holdSet.delete(d.id);
    }
    this.data.holds = [...this.holdSet];
    this.flush();
  }

  private flush(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }
}
