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

export interface DiffContext {
  instruments: InstrumentMap;
  userId: number;
  nowSec?: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function requireInstrument(code: string, instruments: InstrumentMap): number {
  const id = instruments(code);
  if (id == null) throw new Error(`Unknown ZenMoney instrument for currency "${code}"`);
  return id;
}

export function accountToDiff(a: ZenAccount, ctx: DiffContext): DiffAccount {
  const now = ctx.nowSec ?? Math.floor(Date.now() / 1000);
  return {
    id: stableUuid(`account:${a.id}`),
    changed: now,
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
  const now = ctx.nowSec ?? Math.floor(Date.now() / 1000);
  const m = tx.movements[0];
  const sum = m.sum ?? 0;
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

  return {
    id: stableUuid(`tx:${tx.id ?? m.id ?? `${+tx.date}:${sum}`}`),
    changed: now,
    created: now,
    user: ctx.userId,
    deleted: false,
    date: ymd(tx.date),
    income: sum > 0 ? sum : 0,
    incomeAccount: accId,
    incomeInstrument: instrId,
    incomeBankID: null,
    outcome: sum < 0 ? -sum : 0,
    outcomeAccount: accId,
    outcomeInstrument: instrId,
    outcomeBankID: null,
    payee,
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
): { accounts: DiffAccount[]; transactions: DiffTransaction[] } {
  const accounts = result.accounts.map((a) => accountToDiff(a, ctx));
  const instrumentByAccount = new Map(result.accounts.map((a) => [a.id, a.instrument]));
  const transactions = result.transactions.map((tx) => {
    const first = tx.movements[0].account;
    const code = "id" in first ? (instrumentByAccount.get(first.id) ?? "USD") : "USD";
    return transactionToDiff(tx, code, ctx);
  });
  return { accounts, transactions };
}
