import {
  isHold,
  parseMoney,
  signedAmount,
  signedOriginalAmount,
  transactionDate,
  type Card,
  type CardBalance,
  type Transaction,
} from "jupiter-card-sdk";
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
 *
 * Money is read through the SDK's accessors, never by hand: they return `null` for a
 * record that cannot be interpreted, and a record we cannot interpret is skipped
 * rather than written into the ledger as a guess.
 */

/**
 * ZenMoney keys an account by this id forever. It must come from the one stable
 * field — substituting the card id or a literal when `cardAccountId` is missing would
 * change the account's identity and leave a duplicate in the ledger that cannot be
 * merged away. `null` means "we do not know", and the caller must not sync.
 */
export function accountIdFor(cards: Card[]): string | null {
  const id = cards[0]?.cardAccountId;
  return id != null && id !== "" ? id : null;
}

/**
 * Normalise a currency for ZenMoney, which has no `USDC` instrument.
 *
 * Jupiter's API returns mixed case (`usdc` and `USDC`) and settles the card in USD, with USDC
 * as its 1:1 on-chain rail. Folding USDC into USD (and upper-casing) keeps a USDC deposit from
 * producing an invoice in an instrument ZenMoney cannot resolve — which otherwise fails the
 * whole diff push, not just that record. A genuine FX leg like EUR is only upper-cased.
 */
export function normalizeCurrency(code: string | null | undefined): string {
  const c = (typeof code === "string" ? code : "").toUpperCase();
  return c === "USDC" ? "USD" : c;
}

export function toZenAccount(cards: Card[], balance: CardBalance, accountId: string): ZenAccount {
  const last4s = cards.map((c) => c.last4).filter((x): x is string => x != null && x !== "");
  return {
    id: accountId,
    type: "ccard",
    title: cards.length > 1 ? "Jupiter Card" : `Jupiter •${last4s[0] ?? "card"}`,
    instrument: normalizeCurrency(balance.currency) || "USD",
    // An absent balance is unknown, not zero — leave the field out entirely rather
    // than assert a figure the API never gave us.
    balance: parseMoney(balance.spendableBalance) ?? undefined,
    syncIds: last4s.length ? last4s : null,
    savings: false,
  };
}

/**
 * Card-purchase statuses that mean money actually moved (or is committed as a hold).
 *
 * `COMPLETED` is settled; `AUTHORIZED` is a pending hold that will settle. Anything else on
 * a card row — `INSUFFICIENT_FUNDS` and every other decline — is money that never left the
 * account, and must not become an expense. Observed live; kept as an ALLOWLIST on purpose,
 * so a status we have not seen is skipped and surfaced rather than booked on a guess.
 */
const BOOKABLE_CARD_STATUS = new Set(["COMPLETED", "AUTHORIZED"]);

/**
 * Why a card transaction must not be booked, or null if it may be. Declines carry a full
 * amount and a valid date — nothing about the number itself says the charge was refused —
 * so the only signal is `card.status`, which the SDK leaves untyped.
 *
 * Only CARD rows have a status; on-chain deposits/withdrawals have none and always moved
 * money. A CARD row with no status at all keeps the prior behaviour (booked): the field is
 * absent on some older records, and we do not want to start dropping history.
 */
export function unbookableReason(tx: Transaction): string | null {
  if (tx.type !== "CARD") return null;
  const status = tx.card?.status;
  if (status == null || status === "") return null;
  if (BOOKABLE_CARD_STATUS.has(status.toUpperCase())) return null;
  return `card ${status.toLowerCase()} — no money moved`;
}

/**
 * `null` when the transaction cannot be represented honestly — a declined card charge, an
 * unknown direction, an unparseable amount, or a bad timestamp. Booking one of those would
 * put a wrong number in the ledger: the old code turned a malformed amount into `0`, treated
 * every non-`CREDIT` direction as money leaving the account, and booked declines as expenses.
 */
export function toZenTransaction(tx: Transaction, accountId: string): ZenTransaction | null {
  if (unbookableReason(tx) !== null) return null;
  const sum = signedAmount(tx);
  const date = transactionDate(tx);
  if (sum === null || date === null) return null;

  // Record the original-currency leg only when it truly differs from the settlement currency
  // after normalisation: a USDC deposit settled in USD is 1:1, so it collapses to no invoice
  // rather than one in the unbookable `USDC` instrument.
  const original = signedOriginalAmount(tx);
  const originalCurrency = original === null ? null : normalizeCurrency(original.currency);
  const invoice =
    original === null || originalCurrency === normalizeCurrency(tx.settlementCurrency)
      ? null
      : { sum: original.sum, instrument: originalCurrency! };

  let merchant: ZenMerchant | null = null;
  if (tx.card?.merchantName) {
    const mcc = parseMoney(tx.card.merchantCategoryCode);
    merchant = { fullTitle: tx.card.merchantName, mcc: mcc ?? null, location: null };
  }

  return {
    id: tx.id,
    date,
    hold: isHold(tx),
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

/** Transactions that could not be represented, and were therefore left out. */
export interface SkippedTransaction {
  id: string;
  reason: string;
}

export interface ConversionResult extends ScrapeResult {
  /** Never silently empty: a skipped record is reported so it can be investigated. */
  skipped: SkippedTransaction[];
}

export function toScrapeResult(cards: Card[], balance: CardBalance, transactions: Transaction[]): ConversionResult {
  const accountId = accountIdFor(cards);
  if (accountId === null) {
    // Inventing an id here is what creates a permanent duplicate account downstream.
    throw new Error("Jupiter returned cards without a cardAccountId; refusing to guess an account id");
  }

  const converted: ScrapeResult["transactions"] = [];
  const skipped: SkippedTransaction[] = [];

  for (const tx of transactions) {
    const zen = toZenTransaction(tx, accountId);
    if (zen === null) {
      const declined = unbookableReason(tx);
      skipped.push({
        id: tx.id,
        reason:
          declined ??
          (signedAmount(tx) === null
            ? `unreadable amount or direction (direction=${tx.direction ?? "—"}, amount=${tx.settlementAmount ?? "—"})`
            : `unreadable timestamp (${tx.transactionTimestamp ?? "—"})`),
      });
      continue;
    }
    converted.push(zen);
  }

  return {
    accounts: [toZenAccount(cards, balance, accountId)],
    transactions: converted,
    skipped,
  };
}
