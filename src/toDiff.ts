import type { ScrapeResult, ZenAccount, ZenTransaction } from "./zenTypes.js";
import { stableUuid } from "./ids.js";

/**
 * Adapt the ZenMoney *plugin* (`movements`) format into the ZenMoney *backend*
 * `/v8/diff` format (income/outcome + integer instrument ids + `yyyy-MM-dd`).
 *
 * The diff schema requires `user` (your ZenMoney user id), `changed`/`created`
 * timestamps, and `deleted` on every object; the loan/deposit-only account
 * fields are sent as null. Card-only, so every transaction is single-movement.
 */

/** Maps a currency short-title (e.g. "USD") to ZenMoney's integer Instrument id. */
export type InstrumentMap = (code: string) => number | undefined;

export interface DiffAccount {
  id: string;
  changed: number;
  user: number;
  type: string;
  title: string;
  instrument: number;
  balance: number | null;
  startBalance: number | null;
  creditLimit: number | null;
  inBalance: boolean;
  savings: boolean;
  archive: boolean;
  private: boolean;
  enableCorrection: boolean;
  enableSMS: boolean;
  syncID: string[] | null;
  company: number | null;
  role: number | null;
  // loan/deposit-only fields — null for cards
  capitalization: boolean | null;
  percent: number | null;
  startDate: string | null;
  endDateOffset: number | null;
  endDateOffsetInterval: string | null;
  payoffStep: number | null;
  payoffInterval: string | null;
}

/** A deletion tombstone (`deletion[]` entry) sent to /v8/diff. */
export interface DiffDeletion {
  id: string;
  object: string; // e.g. "transaction"
  stamp: number;
  user: number;
}

export interface DiffTransaction {
  id: string;
  changed: number;
  created: number;
  user: number;
  deleted: boolean;
  date: string; // yyyy-MM-dd
  income: number;
  incomeAccount: string;
  incomeInstrument: number;
  incomeBankID: string | null;
  outcome: number;
  outcomeAccount: string;
  outcomeInstrument: number;
  outcomeBankID: string | null;
  payee: string | null;
  originalPayee: string | null;
  mcc: number | null;
  comment: string | null;
  hold: boolean | null;
  tag: string[] | null;
  merchant: string | null;
  reminderMarker: string | null;
  latitude: number | null;
  longitude: number | null;
  opIncome: number | null;
  opIncomeInstrument: number | null;
  opOutcome: number | null;
  opOutcomeInstrument: number | null;
}

/** An existing ZenMoney account a deposit was traced to (the transfer source). */
export interface SourceAccount {
  accountId: string;
  instrument: number | null;
}

export interface DiffContext {
  instruments: InstrumentMap;
  userId: number;
  /**
   * Deposits (by Jupiter tx id) whose on-chain source was matched to an existing
   * ZenMoney account → emitted as a transfer instead of plain income.
   */
  transferSources?: Map<string, SourceAccount>;
  /**
   * One-off override: stamp transfer transactions with `changed = now` so a
   * later app edit doesn't stop the conversion. Deposits that resolve to a
   * transfer already get a **fresh id** (`transfer:` namespace) so they insert
   * cleanly; ZenMoney permanently tombstones a *deleted* transaction id, so we
   * never try to resurrect the old `tx:` record — we insert a new one and emit a
   * deletion for the old income id. This flag only bumps `changed`.
   */
  reconcile?: boolean;
}

/**
 * `changed` timestamps are **data-derived and stable**, never `Date.now()`.
 * ZenMoney's /v8/diff resolves conflicts by last-write-wins on `changed`, so a
 * stable timestamp makes re-syncs non-destructive: any later edit you make in
 * the ZenMoney app has a newer `changed` and therefore always wins. The syncer
 * only inserts records ZenMoney doesn't have yet.
 *
 * The card account has no meaningful "changed" on Jupiter's side, so it uses a
 * fixed baseline — it's created once and never overwritten (its balance is set
 * at first insert and not force-refreshed).
 */
const ACCOUNT_CHANGED_SEC = 1_600_000_000; // fixed baseline (2020-09), always older than any app edit

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Stable key for a Jupiter transaction (its id, falling back to movement/date). */
function txKeyOf(tx: ZenTransaction): string {
  const m = tx.movements[0];
  return tx.id ?? m.id ?? `${+tx.date}:${m.sum ?? 0}`;
}

function requireInstrument(code: string, instruments: InstrumentMap): number {
  const id = instruments(code);
  if (id == null) throw new Error(`Unknown ZenMoney instrument for currency "${code}"`);
  return id;
}

export function accountToDiff(a: ZenAccount, ctx: DiffContext): DiffAccount {
  return {
    id: stableUuid(`account:${a.id}`),
    changed: ACCOUNT_CHANGED_SEC,
    user: ctx.userId,
    type: a.type,
    title: a.title,
    instrument: requireInstrument(a.instrument, ctx.instruments),
    balance: a.balance ?? null,
    startBalance: null,
    creditLimit: a.creditLimit ?? null,
    inBalance: true,
    savings: a.savings ?? false,
    archive: false,
    private: false,
    enableCorrection: false,
    enableSMS: false,
    syncID: a.syncIds,
    company: null,
    role: null,
    capitalization: null,
    percent: null,
    startDate: null,
    endDateOffset: null,
    endDateOffsetInterval: null,
    payoffStep: null,
    payoffInterval: null,
  };
}

export function transactionToDiff(tx: ZenTransaction, accountInstrument: string, ctx: DiffContext): DiffTransaction {
  const m = tx.movements[0];
  const sum = m.sum ?? 0;
  // A deposit whose on-chain source matched an existing ZenMoney account.
  const source = sum > 0 ? ctx.transferSources?.get(tx.id ?? "") : undefined;

  // Normally `changed` is the transaction's own time (stable → app edits always
  // win). In reconcile mode, transfers use "now" so they override an existing
  // income record or a deletion tombstone — a deliberate, scoped one-off.
  const changed = source && ctx.reconcile ? Math.floor(Date.now() / 1000) : Math.floor(tx.date.getTime() / 1000);
  const instrId = requireInstrument(accountInstrument, ctx.instruments);
  const accId = "id" in m.account ? stableUuid(`account:${m.account.id}`) : stableUuid(`ref:${m.account.syncIds.join(",")}`);
  const payee = tx.merchant?.fullTitle ?? tx.merchant?.title ?? null;

  let opIncome: number | null = null;
  let opIncomeInstrument: number | null = null;
  let opOutcome: number | null = null;
  let opOutcomeInstrument: number | null = null;
  if (m.invoice) {
    const opInstr = requireInstrument(m.invoice.instrument, ctx.instruments);
    if (m.invoice.sum > 0) {
      opIncome = m.invoice.sum;
      opIncomeInstrument = opInstr;
    } else {
      opOutcome = -m.invoice.sum;
      opOutcomeInstrument = opInstr;
    }
  }

  // A resolved deposit is a *transfer*: give it its own id namespace so it
  // inserts as a fresh record. ZenMoney permanently tombstones a deleted id, so
  // reusing the old `tx:` id (if the user deleted the income record) would never
  // resurrect — a distinct `transfer:` id sidesteps that entirely.
  const txKey = txKeyOf(tx);
  return {
    id: stableUuid(`${source ? "transfer" : "tx"}:${txKey}`),
    changed,
    created: changed,
    user: ctx.userId,
    deleted: false,
    date: ymd(tx.date),
    income: sum > 0 ? sum : 0,
    incomeAccount: accId,
    incomeInstrument: instrId,
    incomeBankID: null,
    outcome: source ? sum : sum < 0 ? -sum : 0,
    outcomeAccount: source ? source.accountId : accId,
    outcomeInstrument: source ? (source.instrument ?? instrId) : instrId,
    outcomeBankID: null,
    payee: source ? null : payee,
    originalPayee: payee,
    mcc: tx.merchant?.mcc ?? null,
    comment: tx.comment,
    hold: tx.hold,
    tag: null,
    merchant: null,
    reminderMarker: null,
    latitude: null,
    longitude: null,
    opIncome,
    opIncomeInstrument,
    opOutcome,
    opOutcomeInstrument,
  };
}

export function scrapeToDiff(
  result: ScrapeResult,
  ctx: DiffContext,
): { accounts: DiffAccount[]; transactions: DiffTransaction[]; deletions: DiffDeletion[] } {
  const accounts = result.accounts.map((a) => accountToDiff(a, ctx));
  const instrumentByAccount = new Map(result.accounts.map((a) => [a.id, a.instrument]));
  const transactions = result.transactions.map((tx) => {
    const first = tx.movements[0].account;
    const code = "id" in first ? (instrumentByAccount.get(first.id) ?? "USD") : "USD";
    return transactionToDiff(tx, code, ctx);
  });

  // A deposit that resolved to a transfer is now inserted under a `transfer:` id.
  // Retire any prior plain-income record (the `tx:` id) so the two don't both
  // show — for a deposit that was only ever a transfer this deletes a
  // never-existed id (a harmless no-op).
  const stamp = Math.floor(Date.now() / 1000);
  const deletions: DiffDeletion[] = [];
  for (const tx of result.transactions) {
    const sum = tx.movements[0].sum ?? 0;
    if (sum > 0 && ctx.transferSources?.has(tx.id ?? "")) {
      deletions.push({ id: stableUuid(`tx:${txKeyOf(tx)}`), object: "transaction", stamp, user: ctx.userId });
    }
  }
  return { accounts, transactions, deletions };
}
