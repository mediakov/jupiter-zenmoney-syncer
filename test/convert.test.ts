import { describe, it, expect } from "vitest";
import { toZenAccount, toZenTransaction, toScrapeResult } from "../src/convert.js";
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

describe("toZenAccount", () => {
  it("maps the card account to a ccard USD account", () => {
    const a = toZenAccount(cards, balance);
    expect(a).toMatchObject({ id: "acct_1", type: "ccard", instrument: "USD", balance: 100.5, syncIds: ["1234"] });
    expect(a.title).toContain("1234");
  });
});

describe("toZenTransaction", () => {
  it("DEBIT purchase → negative movement with merchant", () => {
    const z = toZenTransaction(tx({}), "acct_1");
    expect(z.movements[0]).toMatchObject({ account: { id: "acct_1" }, sum: -10, invoice: null });
    expect(z.merchant).toMatchObject({ fullTitle: "COFFEE SHOP", mcc: 5814 });
    expect(z.hold).toBe(false);
  });

  it("CREDIT → positive sum", () => {
    expect(toZenTransaction(tx({ direction: "CREDIT", settlementAmount: "5.00" }), "acct_1").movements[0]!.sum).toBe(5);
  });

  it("foreign-currency purchase carries an invoice", () => {
    const z = toZenTransaction(
      tx({ settlementAmount: "11.00", transactionCurrency: "EUR", transactionAmount: "10.00" }),
      "acct_1",
    );
    expect(z.movements[0]!.sum).toBe(-11);
    expect(z.movements[0]!.invoice).toEqual({ sum: -10, instrument: "EUR" });
  });

  it("pending card auth → hold true", () => {
    const t = tx({});
    t.card!.settlementTimestamp = null;
    expect(toZenTransaction(t, "acct_1").hold).toBe(true);
  });

  it("USDC deposit → income, no merchant, signature in comment", () => {
    const z = toZenTransaction(
      tx({ type: "DEPOSIT", direction: "CREDIT", settlementAmount: "500.00", onchainSignature: "5xSig", card: null }),
      "acct_1",
    );
    expect(z.movements[0]!.sum).toBe(500);
    expect(z.merchant).toBeNull();
    expect(z.comment).toContain("deposit");
    expect(z.comment).toContain("5xSig");
  });
});

describe("toScrapeResult", () => {
  it("returns one account and mapped transactions referencing it", () => {
    const r = toScrapeResult(cards, balance, [tx({}), tx({ id: "tx_2" })]);
    expect(r.accounts).toHaveLength(1);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]!.movements[0]!.account).toEqual({ id: "acct_1" });
  });
});
