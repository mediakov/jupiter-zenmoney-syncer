import { describe, it, expect } from "vitest";
import { accountIdFor, toZenAccount, toZenTransaction, toScrapeResult } from "../src/convert.js";
import type { Card, CardBalance, Transaction } from "jupiter-card-sdk";

const cards: Card[] = [
  {
    id: "card_1",
    customerId: "cust_1",
    provider: "visa",
    cardAccountId: "acct_1",
    status: "ACTIVE",
    design: "default",
    imageUrl: "",
    last4: "1234",
    expirationMonth: "07",
    expirationYear: "2028",
    createdAt: "",
    updatedAt: "",
  },
];
const balance: CardBalance = { currency: "USD", spendableBalance: 100.5, withdrawableBalance: 100.5 };

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: "tx_1",
    cardId: "card_1",
    type: "CARD",
    direction: "DEBIT",
    settlementCurrency: "USD",
    settlementAmount: "10.00",
    transactionCurrency: "USD",
    transactionAmount: "10.00",
    providerTransactionId: "p1",
    onchainSignature: null,
    transactionTimestamp: "2026-07-01T12:00:00.000Z",
    card: {
      last4: "1234",
      merchantName: "COFFEE SHOP",
      merchantLogoUrl: "",
      merchantCategoryCode: "5814",
      status: "SETTLED",
      settlementTimestamp: "2026-07-01T12:01:00.000Z",
      fees: {
        localAmount: "10.00",
        localCurrency: "USD",
        finalAmountUsd: "10.00",
        visaConversionFeeUsd: "0",
        visaConversionRate: "1",
        amountBeforeFeeUsd: "10.00",
        exchangeRate: "1",
      },
    },
    deposit: null,
    withdrawal: null,
    qr: null,
    ...overrides,
  };
}

/** Assert a transaction converted, and hand back the result. */
function converted(t: Transaction, accountId = "acct_1") {
  const z = toZenTransaction(t, accountId);
  if (z === null) throw new Error("expected the transaction to convert");
  return z;
}

describe("toZenAccount", () => {
  it("maps the card account to a ccard USD account", () => {
    const a = toZenAccount(cards, balance, "acct_1");
    expect(a).toMatchObject({ id: "acct_1", type: "ccard", instrument: "USD", balance: 100.5, syncIds: ["1234"] });
    expect(a.title).toContain("1234");
  });

  // An absent balance is unknown, not zero: writing a 0 asserts a figure Jupiter
  // never sent, and the panel would show a confidently wrong balance.
  it("leaves the balance out when Jupiter did not send one", () => {
    const a = toZenAccount(cards, { currency: "USD" }, "acct_1");
    expect(a.balance).toBeUndefined();
  });
});

describe("accountIdFor", () => {
  it("uses cardAccountId", () => {
    expect(accountIdFor(cards)).toBe("acct_1");
  });

  // ZenMoney keys the account by this id forever. Falling back to the card id (as the
  // old code did) would change the account's identity and duplicate it permanently.
  it("returns null rather than substituting another id", () => {
    expect(accountIdFor([{ ...cards[0]!, cardAccountId: null }])).toBeNull();
    expect(accountIdFor([])).toBeNull();
  });
});

describe("toZenTransaction", () => {
  it("DEBIT purchase → negative movement with merchant", () => {
    const z = converted(tx({}));
    expect(z.movements[0]).toMatchObject({ account: { id: "acct_1" }, sum: -10, invoice: null });
    expect(z.merchant).toMatchObject({ fullTitle: "COFFEE SHOP", mcc: 5814 });
    expect(z.hold).toBe(false);
  });

  it("CREDIT → positive sum", () => {
    expect(converted(tx({ direction: "CREDIT", settlementAmount: "5.00" })).movements[0]!.sum).toBe(5);
  });

  it("foreign-currency purchase carries an invoice", () => {
    const z = converted(tx({ settlementAmount: "11.00", transactionCurrency: "EUR", transactionAmount: "10.00" }));
    expect(z.movements[0]!.sum).toBe(-11);
    expect(z.movements[0]!.invoice).toEqual({ sum: -10, instrument: "EUR" });
  });

  it("pending card auth → hold true", () => {
    const t = tx({});
    t.card!.settlementTimestamp = null;
    expect(converted(t).hold).toBe(true);
  });

  it("USDC deposit → income, no merchant, signature in comment", () => {
    const z = converted(
      tx({ type: "DEPOSIT", direction: "CREDIT", settlementAmount: "500.00", onchainSignature: "5xSig", card: null }),
    );
    expect(z.movements[0]!.sum).toBe(500);
    expect(z.merchant).toBeNull();
    expect(z.comment).toContain("deposit");
    expect(z.comment).toContain("5xSig");
  });

  // The bug that shipped: `direction === "CREDIT" ? 1 : -1` made an unknown direction
  // an expense, so income was booked as a debit.
  it("refuses a direction it does not understand instead of calling it a debit", () => {
    expect(toZenTransaction(tx({ direction: "REVERSAL" }), "acct_1")).toBeNull();
    expect(toZenTransaction(tx({ direction: null }), "acct_1")).toBeNull();
  });

  // The other bug that shipped: num() turned a bad amount into 0, and a 0 posts.
  it("refuses an unreadable amount instead of booking 0", () => {
    expect(toZenTransaction(tx({ settlementAmount: "" }), "acct_1")).toBeNull();
    expect(toZenTransaction(tx({ settlementAmount: "n/a" }), "acct_1")).toBeNull();
  });

  it("refuses an unreadable date instead of an Invalid Date", () => {
    expect(toZenTransaction(tx({ transactionTimestamp: "nope" }), "acct_1")).toBeNull();
  });
});

describe("toScrapeResult", () => {
  it("returns one account and mapped transactions referencing it", () => {
    const r = toScrapeResult(cards, balance, [tx({}), tx({ id: "tx_2" })]);
    expect(r.accounts).toHaveLength(1);
    expect(r.transactions).toHaveLength(2);
    expect(r.skipped).toEqual([]);
    expect(r.transactions[0]!.movements[0]!.account).toEqual({ id: "acct_1" });
  });

  // A skipped record must be reported. Silently omitting it is indistinguishable from
  // "Jupiter had nothing to send", which is how data loss goes unnoticed.
  it("reports what it could not convert rather than dropping it quietly", () => {
    const r = toScrapeResult(cards, balance, [tx({}), tx({ id: "tx_bad", direction: "MYSTERY" })]);
    expect(r.transactions).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.id).toBe("tx_bad");
    expect(r.skipped[0]!.reason).toContain("MYSTERY");
  });

  it("refuses to sync at all rather than invent an account id", () => {
    const noAcct = [{ ...cards[0]!, cardAccountId: null }];
    expect(() => toScrapeResult(noAcct, balance, [tx({})])).toThrow(/cardAccountId/);
  });
});
