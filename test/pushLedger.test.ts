import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushLedger } from "../src/pushLedger.js";
import type { DiffAccount, DiffDeletion, DiffTransaction } from "../src/toDiff.js";

const acct = (id: string, changed: number) => ({ id, changed }) as DiffAccount;
const tx = (id: string, changed: number) => ({ id, changed }) as DiffTransaction;
const del = (id: string) => ({ id, object: "transaction", stamp: 1, user: 1 }) as DiffDeletion;

describe("PushLedger", () => {
  it("sends everything first, then only new/changed, and persists", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.json");
    const l = new PushLedger(path);
    const accounts = [acct("a", 100)];
    const txs = [tx("t1", 10), tx("t2", 20)];
    const dels = [del("d1")];

    // first run: everything is pending
    let p = l.pending(accounts, txs, dels);
    expect(p.accounts.length).toBe(1);
    expect(p.transactions.length).toBe(2);
    expect(p.deletions.length).toBe(1);
    l.record(p);

    // steady state: nothing new
    p = l.pending(accounts, txs, dels);
    expect(p.accounts.length + p.transactions.length + p.deletions.length).toBe(0);

    // one changed (t2), one new (t3); d1 already sent
    const txs2 = [tx("t1", 10), tx("t2", 999), tx("t3", 30)];
    p = l.pending(accounts, txs2, dels);
    expect(p.transactions.map((t) => t.id).sort()).toEqual(["t2", "t3"]);
    expect(p.deletions.length).toBe(0);
    l.record(p);

    // reload from disk → state survives
    const reloaded = new PushLedger(path);
    const after = reloaded.pending(accounts, txs2, dels);
    expect(after.accounts.length + after.transactions.length + after.deletions.length).toBe(0);
  });

  it("prunes entries that leave the window, and re-sends only if they return", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.json");
    const l = new PushLedger(path);
    const accounts = [acct("a", 100)];
    l.record(l.pending(accounts, [tx("t1", 10), tx("t2", 20)], [del("d1")]));

    // window now only has t2 (t1 + d1 aged out) → they get pruned
    expect(l.retain(accounts, [tx("t2", 20)], [])).toBe(true);
    // nothing pruned the second time → no rewrite
    expect(l.retain(accounts, [tx("t2", 20)], [])).toBe(false);

    // t2 still known (not re-sent); t1/d1 pruned so they'd be re-sent if seen again
    const p = l.pending(accounts, [tx("t1", 10), tx("t2", 20)], [del("d1")]);
    expect(p.transactions.map((t) => t.id)).toEqual(["t1"]);
    expect(p.deletions.map((d) => d.id)).toEqual(["d1"]);
  });
});
