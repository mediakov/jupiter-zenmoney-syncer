import { describe, it, expect } from "vitest";
import { scrapeToDiff, transactionToDiff, accountToDiff } from "../src/toDiff.js";
import { stableUuid } from "../src/ids.js";
import type { ScrapeResult, ZenAccount, ZenTransaction } from "../src/zenTypes.js";

const instruments = (code: string) => ({ USD: 1, EUR: 2, USDC: 3 })[code.toUpperCase()];
const ctx = { instruments, userId: 7 };

const account: ZenAccount = {
  id: "acct_1",
  type: "ccard",
  title: "Jupiter •1234",
  instrument: "USD",
  balance: 100.5,
  syncIds: ["1234"],
  savings: false,
};

function ztx(over: Partial<ZenTransaction> & { sum: number; invoice?: { sum: number; instrument: string } | null }): ZenTransaction {
  const { sum, invoice = null, ...rest } = over;
  return {
    id: "tx_1",
    date: new Date("2026-07-01T12:00:00.000Z"),
    hold: false,
    merchant: { fullTitle: "COFFEE", mcc: 5814, location: null },
    comment: null,
    movements: [{ id: "tx_1", account: { id: "acct_1" }, invoice, sum, fee: 0 }],
    ...rest,
  };
}

describe("accountToDiff", () => {
  it("maps to diff account with integer instrument + stable id", () => {
    const d = accountToDiff(account, ctx);
    expect(d.instrument).toBe(1);
    expect(d.type).toBe("ccard");
    expect(d.syncID).toEqual(["1234"]);
    expect(d.id).toBe(stableUuid("account:acct_1"));
  });
  it("throws on unknown currency", () => {
    expect(() => accountToDiff({ ...account, instrument: "XXX" }, ctx)).toThrow(/instrument/i);
  });
});

describe("transactionToDiff", () => {
  it("negative sum → outcome", () => {
    const d = transactionToDiff(ztx({ sum: -10 }), "USD", ctx);
    expect(d.outcome).toBe(10);
    expect(d.income).toBe(0);
    expect(d.outcomeInstrument).toBe(1);
    expect(d.payee).toBe("COFFEE");
    expect(d.mcc).toBe(5814);
    expect(d.date).toBe("2026-07-01");
  });

  it("positive sum → income", () => {
    const d = transactionToDiff(ztx({ sum: 5 }), "USD", ctx);
    expect(d.income).toBe(5);
    expect(d.outcome).toBe(0);
  });

  it("invoice → op fields (foreign outcome)", () => {
    const d = transactionToDiff(ztx({ sum: -11, invoice: { sum: -10, instrument: "EUR" } }), "USD", ctx);
    expect(d.opOutcome).toBe(10);
    expect(d.opOutcomeInstrument).toBe(2);
  });

  it("same transaction id → same diff id (idempotent)", () => {
    const a = transactionToDiff(ztx({ sum: -10 }), "USD", ctx);
    const b = transactionToDiff(ztx({ sum: -10 }), "USD", ctx);
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(stableUuid("tx:tx_1"));
  });

  it("changed is the transaction's own time (stable, non-destructive)", () => {
    const d = transactionToDiff(ztx({ sum: -10 }), "USD", ctx);
    const expected = Math.floor(new Date("2026-07-01T12:00:00.000Z").getTime() / 1000);
    expect(d.changed).toBe(expected);
    expect(d.created).toBe(expected);
    // and it must NOT be "now"
    expect(d.changed).toBeLessThan(Math.floor(Date.now() / 1000) - 60);
  });
});

describe("accountToDiff (non-destructive)", () => {
  it("uses a fixed baseline changed, not now", () => {
    const d = accountToDiff(account, ctx);
    expect(d.changed).toBe(1_600_000_000);
  });
});

describe("scrapeToDiff", () => {
  it("converts a full scrape result", () => {
    const scrape: ScrapeResult = { accounts: [account], transactions: [ztx({ sum: -10 }), ztx({ sum: 5, id: "tx_2" })] };
    const d = scrapeToDiff(scrape, ctx);
    expect(d.accounts).toHaveLength(1);
    expect(d.transactions).toHaveLength(2);
    expect(d.transactions[0]!.outcomeAccount).toBe(stableUuid("account:acct_1"));
  });
});

describe("two-movement transfer (plugin-native)", () => {
  const ctx = { instruments: (c: string) => ({ USD: 1, EUR: 2 })[c], userId: 7 };
  const transfer = {
    id: "plasma:earn1",
    date: new Date("2026-07-17T11:17:11Z"),
    hold: false,
    merchant: null,
    comment: null,
    movements: [
      { id: "plasma:earn1", account: { id: "0xACCT" }, invoice: null, sum: -10, fee: 0 },
      { id: "plasma:earn1:earn", account: { id: "0xACCT:earn" }, invoice: null, sum: 10, fee: 0 },
    ],
  } as const;

  it("becomes one record with income and outcome on different accounts", () => {
    const d = transactionToDiff(transfer as never, "USD", ctx as never);
    expect(d.outcome).toBe(10);
    expect(d.income).toBe(10);
    expect(d.outcomeAccount).not.toBe(d.incomeAccount);
    // Not an expense: a transfer has no payee.
    expect(d.payee).toBeNull();
  });

  it("uses the transfer id namespace, so it never collides with a plain tx record", () => {
    const d = transactionToDiff(transfer as never, "USD", ctx as never);
    const asExpense = transactionToDiff(
      { ...transfer, movements: [transfer.movements[0]] } as never,
      "USD",
      ctx as never,
    );
    expect(d.id).not.toBe(asExpense.id);
  });

  it("a single-movement expense is unchanged (Jupiter's path is untouched)", () => {
    const d = transactionToDiff({ ...transfer, movements: [transfer.movements[0]] } as never, "USD", ctx as never);
    expect(d.outcome).toBe(10);
    expect(d.income).toBe(0);
    expect(d.outcomeAccount).toBe(d.incomeAccount);
  });
});
