import type { Card, CardBalance, Transaction } from "jupiter-card-sdk";
import type { ScrapeResult, ZenAccount, ZenMerchant, ZenTransaction } from "./zenTypes.js";

/**
 * Convert Jupiter Card data (from jupiter-card-sdk) into ZenMoney plugin
 * (`movements`) format.
 *
 * Card-only, income/expense:
 *  - One `ccard` USD account; all cards' last4 go in `syncIds`.
 *  - Card purchases → single negative (DEBIT) / positive (CREDIT) movement, with
 *    `merchant` and an `invoice` when the transaction currency differs from USD.
 *  - USDC deposits/withdrawals (non-CARD types) → income/expense with no merchant
 *    and the on-chain signature in the comment.
 */

export function accountIdFor(cards: Card[]): string {
  return cards[0]?.cardAccountId ?? cards[0]?.id ?? "jupiter-card";
}

export function toZenAccount(cards: Card[], balance: CardBalance): ZenAccount {
  const last4s = cards.map((c) => c.last4).filter(Boolean);
  return {
    id: accountIdFor(cards),
    type: "ccard",
    title: cards.length > 1 ? "Jupiter Card" : `Jupiter •${last4s[0] ?? "card"}`,
    instrument: balance.currency || "USD",
    balance: balance.spendableBalance,
    syncIds: last4s.length ? last4s : null,
    savings: false,
  };
}

function num(s: string | number | undefined | null): number {
  const n = typeof s === "number" ? s : Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function toZenTransaction(tx: Transaction, accountId: string): ZenTransaction {
  const sign = tx.direction === "CREDIT" ? 1 : -1;
  const sum = sign * num(tx.settlementAmount);

  const invoice =
    tx.transactionCurrency && tx.transactionCurrency !== tx.settlementCurrency
      ? { sum: sign * num(tx.transactionAmount), instrument: tx.transactionCurrency }
      : null;

  let merchant: ZenMerchant | null = null;
  if (tx.card?.merchantName) {
    const mcc = num(tx.card.merchantCategoryCode);
    merchant = { fullTitle: tx.card.merchantName, mcc: mcc || null, location: null };
  }

  const hold = tx.card ? tx.card.settlementTimestamp === null : false;

  return {
    id: tx.id,
    date: new Date(tx.transactionTimestamp),
    hold,
    merchant,
    comment: commentFor(tx),
    movements: [{ id: tx.id, account: { id: accountId }, invoice, sum, fee: 0 }],
  };
}

function commentFor(tx: Transaction): string | null {
  if (tx.type === "CARD") return null;
  const parts: string[] = [];
  if (tx.type) parts.push(tx.type.toLowerCase());
  if (tx.onchainSignature) parts.push(`sig:${tx.onchainSignature}`);
  return parts.length ? parts.join(" · ") : null;
}

export function toScrapeResult(cards: Card[], balance: CardBalance, transactions: Transaction[]): ScrapeResult {
  const accountId = accountIdFor(cards);
  return {
    accounts: [toZenAccount(cards, balance)],
    transactions: transactions.map((tx) => toZenTransaction(tx, accountId)),
  };
}
