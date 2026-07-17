import { describe, it, expect } from "vitest";
import {
  accountIdFor,
  accountIdsFor,
  toZenAccount,
  toEarnAccount,
  toZenTransaction,
  toScrapeResult,
} from "../src/plasmaConvert.js";
import type { Balance, Card, Money, Transaction, User } from "plasma-card-sdk";

// Shapes mirror real captured Plasma responses; all values are synthetic.
const user: User = { id: "user_1", user_card_account_address: "0xCARDACCT" };
const cards: Card[] = [{ id: "card_1", last_4: "1234", type: "virtual", status: "active" }];
const balance: Balance = {
  balance: "0",
  cash_balance: "100500000", // 100.50 spendable
  earn_balance: "25000000", //  25.00 earning yield
  total_balance: "125500000", // 125.50 = cash + earn
  decimals: 6,
};

const ids = { cash: "0xCARDACCT", earn: "0xCARDACCT:earn" };
const usd = (amount: string, currency = "USDT"): Money => ({ amount, currency, decimals: 6 });

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: "tx_1",
    amount: usd("-10000000"), // -10.00 USDT
    timestamp: "1784214754685",
    status: "completed",
    type: "card_purchase",
    source: "card",
    balance_type: "cash",
    ...overrides,
  } as Transaction;
}

describe("account identity", () => {
  it("uses the card account address — the account-level identity", () => {
    expect(accountIdFor(user)).toBe("0xCARDACCT");
    expect(accountIdsFor(user)).toEqual(ids);
  });

  it("returns null rather than fall back to a card id, which changes on reissue", () => {
    expect(accountIdFor({ id: "u" } as User)).toBeNull();
    expect(accountIdFor({ id: "u", user_card_account_address: "" } as User)).toBeNull();
    expect(accountIdsFor({ id: "u" } as User)).toBeNull();
  });

  it("refuses to invent an account id, which would fork the ledger", () => {
    expect(() => toScrapeResult({ id: "u" } as User, cards, balance, [])).toThrow(/refusing to guess/i);
  });

  it("derives the earn id from the card account, so it is as stable as the account", () => {
    expect(accountIdsFor(user)!.earn).toBe("0xCARDACCT:earn");
  });
});

describe("toZenAccount (card)", () => {
  it("reports the spendable cash balance, not total — earn is its own account now", () => {
    const acct = toZenAccount(cards, balance, ids.cash);
    expect(acct.balance).toBe(100.5); // not 125.50, which would double-count earn
    expect(acct).toMatchObject({ id: "0xCARDACCT", type: "ccard", instrument: "USD", title: "Plasma •1234" });
    expect(acct.syncIds).toEqual(["1234"]);
    expect(acct.savings).toBe(false);
  });

  it("leaves the balance undefined when unreadable — unknown is not zero", () => {
    expect(toZenAccount(cards, { decimals: 6 } as Balance, ids.cash).balance).toBeUndefined();
    expect(toZenAccount(cards, { cash_balance: "oops", decimals: 6 } as Balance, ids.cash).balance).toBeUndefined();
  });

  it("titles a multi-card account without pinning it to one card", () => {
    const two = [...cards, { id: "card_2", last_4: "5678" } as Card];
    expect(toZenAccount(two, balance, ids.cash).title).toBe("Plasma One");
    expect(toZenAccount(two, balance, ids.cash).syncIds).toEqual(["1234", "5678"]);
  });
});

describe("toEarnAccount", () => {
  it("is a savings-flagged checking account holding the earn balance", () => {
    const earn = toEarnAccount(balance, ids.earn);
    expect(earn).toMatchObject({
      id: "0xCARDACCT:earn",
      type: "checking", // not `deposit`: the balance floats, with no rate/term to declare
      title: "Plasma Earn",
      instrument: "USD",
      savings: true,
    });
    expect(earn.balance).toBe(25);
    expect(earn.syncIds).toBeNull(); // no card number belongs to the earn pot
  });

  it("the two accounts together equal Plasma's total_balance", () => {
    const cash = toZenAccount(cards, balance, ids.cash).balance!;
    const earn = toEarnAccount(balance, ids.earn).balance!;
    expect(cash + earn).toBe(125.5);
  });
});

describe("toZenTransaction", () => {
  it("books a settled card purchase as a negative movement with merchant + mcc", () => {
    const t = toZenTransaction(
      tx({ merchant: { name: "Uber Eats", mcc_code: "5812", category: { name: "Food Delivery", mcc: 5812 } } }),
      ids,
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
    expect(toZenTransaction(declined, ids)).toBeNull();
  });

  it("marks a pending authorisation as a hold", () => {
    expect(toZenTransaction(tx({ status: "pending" }), ids)!.hold).toBe(true);
  });

  it("normalises USDT and USDT0 to one USD figure so a ledger adds up", () => {
    const purchase = toZenTransaction(tx({ amount: usd("-63610000", "USDT") }), ids);
    const receive = toZenTransaction(
      tx({ id: "tx_2", amount: usd("214792305", "USDT0"), type: "receive", source: "onchain" }),
      ids,
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
      ids,
    );
    expect(t!.movements[0].invoice).toEqual({ sum: -54.57, instrument: "EUR" });
  });

  it("has no invoice for a same-currency purchase", () => {
    expect(toZenTransaction(tx({}), ids)!.movements[0].invoice).toBeNull();
  });

  it("comments an on-chain receive with its type and source", () => {
    const t = toZenTransaction(tx({ type: "receive", source: "onchain", amount: usd("500081608", "USDT0") }), ids);
    expect(t!.comment).toBe("receive · onchain");
    expect(t!.merchant).toBeNull();
  });

  it("skips a record it cannot represent rather than guessing", () => {
    expect(toZenTransaction(tx({ amount: usd("nonsense") }), ids)).toBeNull();
    expect(toZenTransaction(tx({ timestamp: "not-a-date" }), ids)).toBeNull();
    // XPL is not USD-pegged: converting it at par would fabricate a dollar figure.
    expect(toZenTransaction(tx({ amount: { amount: "1000000000000000000", currency: "XPL", decimals: 18 } }), ids)).toBeNull();
  });

  describe("routing by balance_type", () => {
    const accountOf = (t: Transaction) => {
      const m = toZenTransaction(t, ids)!.movements[0].account;
      return "id" in m ? m.id : null;
    };

    it("books cash activity to the card account", () => {
      expect(accountOf(tx({ balance_type: "cash" }))).toBe(ids.cash);
    });

    it("books earn activity to the earn account, not the card", () => {
      // Plasma tags the row itself, so this is read from the API, not inferred.
      expect(accountOf(tx({ balance_type: "earn", type: "receive" }))).toBe(ids.earn);
    });

    it("falls back to the card when the tag is absent or unrecognised", () => {
      expect(accountOf(tx({ balance_type: undefined }))).toBe(ids.cash);
      expect(accountOf(tx({ balance_type: "something_new" }))).toBe(ids.cash);
    });
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
      { id: "bad-date", reason: "unreadable timestamp ()" },
      { id: "bad-ccy", reason: "unreadable or non-USD amount (currency=XPL, amount=1)" },
    ]);
  });

  it("emits both the card and the earn account", () => {
    const res = toScrapeResult(user, cards, balance, [tx({})]);
    expect(res.accounts.map((a) => a.id)).toEqual(["0xCARDACCT", "0xCARDACCT:earn"]);
    expect(res.accounts.map((a) => a.type)).toEqual(["ccard", "checking"]);
  });

  it("still emits the earn account at a zero balance — 0 is a real balance", () => {
    // Dropping it would leave ZenMoney showing the last figure it ever saw, forever.
    const res = toScrapeResult(user, cards, { ...balance, earn_balance: "0" }, []);
    expect(res.accounts).toHaveLength(2);
    expect(res.accounts[1].balance).toBe(0);
  });

  it("omits the earn account when the balance is unknown and nothing was booked to it", () => {
    const res = toScrapeResult(user, cards, { cash_balance: "100500000", decimals: 6 } as Balance, [tx({})]);
    expect(res.accounts.map((a) => a.id)).toEqual(["0xCARDACCT"]);
  });

  it("emits the earn account for an earn row even if its balance is unreadable", () => {
    // Otherwise that movement points at an account absent from the diff, and orphans.
    const res = toScrapeResult(user, cards, { cash_balance: "1", decimals: 6 } as Balance, [
      tx({ id: "e", balance_type: "earn", type: "receive", amount: usd("5000000") }),
    ]);
    expect(res.accounts.map((a) => a.id)).toEqual(["0xCARDACCT", "0xCARDACCT:earn"]);
    expect(res.accounts[1].balance).toBeUndefined();
  });
});
