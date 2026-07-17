import { describe, it, expect } from "vitest";
import { accountIdFor, toZenAccount, toZenTransaction, toScrapeResult } from "../src/plasmaConvert.js";
import type { Balance, Card, Money, Transaction, User } from "plasma-card-sdk";

// Shapes mirror real captured Plasma responses; all values are synthetic.
const user: User = { id: "user_1", user_card_account_address: "0xCARDACCT" };
const cards: Card[] = [{ id: "card_1", last_4: "1234", type: "virtual", status: "active" }];
const balance: Balance = {
  balance: "0",
  cash_balance: "100500000", // 100.50
  earn_balance: "25000000", // 25.00 — so total != cash
  total_balance: "125500000",
  decimals: 6,
};

const usd = (amount: string, currency = "USDT"): Money => ({ amount, currency, decimals: 6 });

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: "tx_1",
    amount: usd("-10000000"), // -10.00 USDT
    timestamp: "1784214754685",
    status: "completed",
    type: "card_purchase",
    source: "card",
    ...overrides,
  } as Transaction;
}

describe("accountIdFor", () => {
  it("uses the card account address — the account-level identity", () => {
    expect(accountIdFor(user)).toBe("0xCARDACCT");
  });

  it("returns null rather than fall back to a card id, which changes on reissue", () => {
    expect(accountIdFor({ id: "u" } as User)).toBeNull();
    expect(accountIdFor({ id: "u", user_card_account_address: "" } as User)).toBeNull();
  });

  it("refuses to invent an account id, which would fork the ledger", () => {
    expect(() => toScrapeResult({ id: "u" } as User, cards, balance, [])).toThrow(/refusing to guess/i);
  });
});

describe("toZenAccount", () => {
  it("reports the spendable cash balance, not total (which includes earn)", () => {
    const acct = toZenAccount(cards, balance, "0xCARDACCT");
    expect(acct.balance).toBe(100.5);
    expect(acct).toMatchObject({ id: "0xCARDACCT", type: "ccard", instrument: "USD", title: "Plasma •1234" });
    expect(acct.syncIds).toEqual(["1234"]);
  });

  it("leaves the balance undefined when unreadable — unknown is not zero", () => {
    expect(toZenAccount(cards, { decimals: 6 } as Balance, "a").balance).toBeUndefined();
    expect(toZenAccount(cards, { cash_balance: "oops", decimals: 6 } as Balance, "a").balance).toBeUndefined();
  });

  it("titles a multi-card account without pinning it to one card", () => {
    const two = [...cards, { id: "card_2", last_4: "5678" } as Card];
    expect(toZenAccount(two, balance, "a").title).toBe("Plasma One");
    expect(toZenAccount(two, balance, "a").syncIds).toEqual(["1234", "5678"]);
  });
});

describe("toZenTransaction", () => {
  it("books a settled card purchase as a negative movement with merchant + mcc", () => {
    const t = toZenTransaction(
      tx({ merchant: { name: "Uber Eats", mcc_code: "5812", category: { name: "Food Delivery", mcc: 5812 } } }),
      "0xCARDACCT",
    );
    expect(t).not.toBeNull();
    expect(t!.id).toBe("plasma:tx_1"); // provider-namespaced, see toZenTransaction
    expect(t!.movements[0].id).toBe("plasma:tx_1");
    expect(t!.movements[0].sum).toBe(-10);
    expect(t!.hold).toBe(false);
    expect(t!.merchant).toEqual({ fullTitle: "Uber Eats", mcc: 5812, location: null });
    expect(t!.comment).toBeNull();
  });

  it("NEVER books a declined transaction — no money moved", () => {
    // Plasma returns declines with a full negative amount. Booking one invents an
    // expense that never happened, and nothing later reverses it.
    const declined = tx({
      status: "declined",
      decline_reason: "The expiration date didn't match.",
      decline_reason_data: { type: "invalid_expiry", message: "The expiration date didn't match." },
    });
    expect(toZenTransaction(declined, "0xCARDACCT")).toBeNull();
  });

  it("marks a pending authorisation as a hold", () => {
    expect(toZenTransaction(tx({ status: "pending" }), "a")!.hold).toBe(true);
  });

  it("normalises USDT and USDT0 to one USD figure so a ledger adds up", () => {
    const purchase = toZenTransaction(tx({ amount: usd("-63610000", "USDT") }), "a");
    const receive = toZenTransaction(
      tx({ id: "tx_2", amount: usd("214792305", "USDT0"), type: "receive", source: "onchain" }),
      "a",
    );
    expect(purchase!.movements[0].sum).toBe(-63.61);
    expect(receive!.movements[0].sum).toBe(214.792305);
  });

  it("carries the foreign-currency leg as an invoice", () => {
    const t = toZenTransaction(
      tx({
        amount: usd("-63610000"),
        fx_details: { local_amount: { amount: "-54570000", currency: "EUR", decimals: 6 }, exchange_rate: 0.857884 },
      }),
      "a",
    );
    expect(t!.movements[0].invoice).toEqual({ sum: -54.57, instrument: "EUR" });
  });

  it("has no invoice for a same-currency purchase", () => {
    expect(toZenTransaction(tx({}), "a")!.movements[0].invoice).toBeNull();
  });

  it("comments an on-chain receive with its type and source", () => {
    const t = toZenTransaction(tx({ type: "receive", source: "onchain", amount: usd("500081608", "USDT0") }), "a");
    expect(t!.comment).toBe("receive · onchain");
    expect(t!.merchant).toBeNull();
  });

  it("skips a record it cannot represent rather than guessing", () => {
    expect(toZenTransaction(tx({ amount: usd("nonsense") }), "a")).toBeNull();
    expect(toZenTransaction(tx({ timestamp: "not-a-date" }), "a")).toBeNull();
    // XPL is not USD-pegged: converting it at par would fabricate a dollar figure.
    expect(toZenTransaction(tx({ amount: { amount: "1000000000000000000", currency: "XPL", decimals: 18 } }), "a")).toBeNull();
  });
});

describe("toScrapeResult", () => {
  it("reports every skipped record with a reason instead of dropping it silently", () => {
    const res = toScrapeResult(user, cards, balance, [
      tx({ id: "ok" }),
      tx({ id: "dead", status: "declined", decline_reason_data: { message: "The expiration date didn't match." } }),
      tx({ id: "bad-date", timestamp: "" }),
      tx({ id: "bad-ccy", amount: { amount: "1", currency: "XPL", decimals: 18 } }),
    ]);
    // Ids are provider-namespaced so they can never collide with a Jupiter id
    // downstream, where stableUuid turns them into permanent ZenMoney record ids.
    expect(res.transactions.map((t) => t.id)).toEqual(["plasma:ok"]);
    expect(res.skipped).toEqual([
      { id: "dead", reason: "declined — no money moved (The expiration date didn't match.)" },
      { id: "bad-date", reason: 'unreadable timestamp ()' },
      { id: "bad-ccy", reason: "unreadable or non-USD amount (currency=XPL, amount=1)" },
    ]);
  });

  it("produces exactly one account for the card", () => {
    const res = toScrapeResult(user, cards, balance, [tx({})]);
    expect(res.accounts).toHaveLength(1);
    expect(res.accounts[0].id).toBe("0xCARDACCT");
  });
});
