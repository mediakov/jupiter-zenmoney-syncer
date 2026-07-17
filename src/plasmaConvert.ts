import {
  localAmount,
  parseMoney,
  transactionDate,
  usdAmount,
  type Balance,
  type Card,
  type Transaction,
  type User,
} from "plasma-card-sdk";
import type { ScrapeResult, ZenAccount, ZenMerchant, ZenTransaction } from "./zenTypes.js";

/**
 * Convert Plasma One card data (from plasma-card-sdk) into ZenMoney plugin
 * (`movements`) format — the Plasma counterpart of `./convert.ts`.
 *
 * Card-only, income/expense:
 *  - One `ccard` USD account; the cards' last-4s go in `syncIds`.
 *  - Card purchases → a single negative movement, with `merchant` and an `invoice`
 *    carrying the local-currency leg when the purchase was in foreign currency.
 *  - On-chain receives → income, with the source noted in the comment.
 *
 * Money is read through the SDK's accessors, never by hand: they return `null` for a
 * record that cannot be interpreted, and a record we cannot interpret is skipped
 * rather than written into the ledger as a guess.
 *
 * Two Plasma-specific rules that differ from Jupiter:
 *
 *  1. **Declined transactions are never booked.** Plasma returns them in the history
 *     with a full (negative) amount, but no money moved — the card was refused. Booking
 *     one would invent an expense that never happened, and it would not self-correct:
 *     nothing later reverses it. They are excluded, and reported as skipped.
 *  2. **Amounts are normalised to USD.** Plasma settles card purchases in `USDT` and
 *     on-chain receives in `USDT0`, which its own balance mixes 1:1 into a USD figure.
 *     `usdAmount` re-denominates both at par, so a ledger built from these adds up;
 *     summing the raw currencies would silently combine two different-looking units.
 */

/**
 * ZenMoney keys an account by this id forever, so it must come from the one stable
 * field. The card account address is Plasma's account-level identity: card ids change
 * when a card is reissued, which would fork the account in the ledger and leave a
 * duplicate that cannot be merged away. `null` means "we do not know" — the caller
 * must not sync rather than substitute something that looks close enough.
 */
export function accountIdFor(user: User): string | null {
  const id = user.user_card_account_address;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * The two ZenMoney accounts one Plasma balance maps to.
 *
 * Plasma keeps two pots under one login — spendable `cash` and yield-bearing `earn` —
 * and tags every transaction with the `balance_type` it hit. Modelling them as one
 * account would make a move between them look like money appearing or vanishing.
 *
 * The earn id is derived from the card account address rather than invented, so it is
 * as stable as the account itself.
 */
export interface PlasmaAccountIds {
  cash: string;
  earn: string;
}

export function accountIdsFor(user: User): PlasmaAccountIds | null {
  const cash = accountIdFor(user);
  return cash === null ? null : { cash, earn: `${cash}:earn` };
}

function money(amount: string | undefined, balance: Balance): number | null {
  return parseMoney({ amount: amount ?? "", currency: "USD", decimals: balance.decimals ?? 6 });
}

export function toZenAccount(cards: Card[], balance: Balance, accountId: string): ZenAccount {
  const last4s = cards.map((c) => c.last_4).filter((x): x is string => x != null && x !== "");
  return {
    id: accountId,
    type: "ccard",
    title: cards.length > 1 ? "Plasma One" : `Plasma •${last4s[0] ?? "card"}`,
    instrument: "USD",
    // `cash_balance` is the card's spendable money. It is NOT `total_balance`, which also
    // includes `earn_balance` (now its own account, so counting it here would double it),
    // and not `balance`, which was 0 while the card held funds.
    // An unreadable balance is unknown, not zero — leave the field out rather than assert
    // a figure the API never gave us.
    balance: money(balance.cash_balance, balance) ?? undefined,
    syncIds: last4s.length ? last4s : null,
    savings: false,
  };
}

/**
 * The yield-bearing pot, as a savings-flagged `checking` account: its balance floats
 * rather than being a fixed-term deposit, so `deposit` (which ZenMoney expects to carry
 * a rate, capitalization and end date) would misdescribe it.
 *
 * Together with the card account this sums to Plasma's `total_balance`.
 */
export function toEarnAccount(balance: Balance, earnAccountId: string): ZenAccount {
  return {
    id: earnAccountId,
    type: "checking",
    title: "Plasma Earn",
    instrument: "USD",
    balance: money(balance.earn_balance, balance) ?? undefined,
    syncIds: null,
    savings: true,
  };
}

/** Reasons a Plasma record is deliberately not booked. */
export type SkipReason = "declined" | "unreadable";

/**
 * Which of the two accounts a transaction belongs to.
 *
 * Plasma tags each row with the balance it moved, so this is read, not inferred. An
 * absent or unrecognised value falls back to the card: every row observed so far is
 * `cash`, and the card is where card activity lives. That fallback is an attribution
 * guess, not an amount guess — the figure and date stay exact either way.
 */
export function accountIdForTx(tx: Transaction, accounts: PlasmaAccountIds): string {
  return tx.balance_type === "earn" ? accounts.earn : accounts.cash;
}

/**
 * `null` when the transaction must not be booked — either it was declined (no money
 * moved) or it cannot be represented honestly (unreadable amount, currency, or date).
 */
export function toZenTransaction(tx: Transaction, accounts: PlasmaAccountIds): ZenTransaction | null {
  if (tx.status === "declined") return null;

  const sum = usdAmount(tx);
  const date = transactionDate(tx);
  if (sum === null || date === null) return null;

  // The foreign-currency leg, e.g. a EUR purchase settled in USDT. Structured on the
  // API, so it is read, never parsed out of a string.
  const local = localAmount(tx);
  const localSum = parseMoney(local);
  const invoice = local && localSum !== null ? { sum: localSum, instrument: local.currency } : null;

  let merchant: ZenMerchant | null = null;
  if (tx.merchant?.name) {
    merchant = { fullTitle: tx.merchant.name, mcc: mccFor(tx), location: null };
  }

  // Namespace the id by provider. Downstream, `stableUuid("tx:<id>")` turns this into
  // the ZenMoney record id, permanently. Jupiter ids flow through the same function, so
  // an unprefixed id that happened to collide with a Jupiter one would silently fuse two
  // unrelated transactions into a single record. Prefixing costs nothing and removes the
  // class of bug; Jupiter's own ids are deliberately left alone, since changing them
  // would re-insert its whole history as duplicates.
  const id = `plasma:${tx.id}`;

  return {
    id,
    date,
    // A pending authorisation is a hold: the money is committed but not settled.
    hold: tx.status === "pending",
    merchant,
    comment: commentFor(tx),
    movements: [{ id, account: { id: accountIdForTx(tx, accounts) }, invoice, sum, fee: 0 }],
  };
}

/**
 * The merchant category code. `category.mcc` is already a number; `mcc_code` is the
 * same value as a string. Prefer the number, fall back to parsing, and return null
 * rather than coerce a non-numeric value into one.
 */
function mccFor(tx: Transaction): number | null {
  const fromCategory = tx.merchant?.category?.mcc;
  if (typeof fromCategory === "number" && Number.isFinite(fromCategory)) return fromCategory;
  const raw = tx.merchant?.mcc_code;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

function commentFor(tx: Transaction): string | null {
  if (tx.type === "card_purchase") return null;
  const parts: string[] = [];
  if (tx.type) parts.push(String(tx.type).replace(/_/g, " "));
  if (tx.source) parts.push(String(tx.source));
  // Not yet observed on a real receive; included defensively so an on-chain reference
  // is carried through if the API does provide one.
  const hash = tx.tx_hash;
  if (typeof hash === "string" && hash !== "") parts.push(`tx:${hash}`);
  return parts.length ? parts.join(" · ") : null;
}

/** Transactions that were deliberately left out, and why. */
export interface SkippedTransaction {
  id: string;
  reason: string;
}

export interface ConversionResult extends ScrapeResult {
  /** Never silently empty: a skipped record is reported so it can be investigated. */
  skipped: SkippedTransaction[];
}

export function toScrapeResult(
  user: User,
  cards: Card[],
  balance: Balance,
  transactions: Transaction[],
): ConversionResult {
  const accounts = accountIdsFor(user);
  if (accounts === null) {
    // Inventing an id here is what creates a permanent duplicate account downstream.
    throw new Error("Plasma returned a user without user_card_account_address; refusing to guess an account id");
  }

  const converted: ScrapeResult["transactions"] = [];
  const skipped: SkippedTransaction[] = [];

  for (const tx of transactions) {
    const zen = toZenTransaction(tx, accounts);
    if (zen === null) {
      skipped.push({ id: tx.id, reason: skipReasonFor(tx) });
      continue;
    }
    converted.push(zen);
  }

  // Emit the earn account when its balance is readable — 0 is a real balance, and an
  // account that stops being sent would sit in ZenMoney at a stale figure forever.
  // Also emit it when any row was booked to it even if the balance is not readable:
  // otherwise that movement points at an account absent from the diff, and orphans.
  const hasEarnBalance = money(balance.earn_balance, balance) !== null;
  const hasEarnRow = converted.some((t) => "id" in t.movements[0].account && t.movements[0].account.id === accounts.earn);
  const zenAccounts = [toZenAccount(cards, balance, accounts.cash)];
  if (hasEarnBalance || hasEarnRow) zenAccounts.push(toEarnAccount(balance, accounts.earn));

  return {
    accounts: zenAccounts,
    transactions: converted,
    skipped,
  };
}

function skipReasonFor(tx: Transaction): string {
  if (tx.status === "declined") {
    const why = tx.decline_reason_data?.message ?? tx.decline_reason;
    return `declined — no money moved${why ? ` (${why})` : ""}`;
  }
  if (usdAmount(tx) === null) {
    return `unreadable or non-USD amount (currency=${tx.amount?.currency ?? "—"}, amount=${tx.amount?.amount ?? "—"})`;
  }
  return `unreadable timestamp (${tx.timestamp ?? "—"})`;
}
