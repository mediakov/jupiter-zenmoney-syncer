import type { ScrapeResult, ZenAccount, ZenTransaction } from "./zenTypes.js";
import { stableUuid } from "./ids.js";

/**
 * Adapt the ZenMoney *plugin* (`movements`) format produced by the shared
 * converter into the ZenMoney *backend* `/v8/diff` format
 * (income/outcome + integer instrument ids + `yyyy-MM-dd` dates).
 *
 * Card-only, so every transaction is single-movement: a negative sum is an
 * outcome (expense), a positive sum is an income. `invoice` (original currency)
 * maps to the `op*` fields.
 */

/** Maps a currency short-title (e.g. "USD") to ZenMoney's integer Instrument id. */
export type InstrumentMap = (code: string) => number | undefined;

export interface DiffAccount {
  id: string;
  user?: number;
  type: string;
  title: string;
  instrument: number;
  balance: number | null;
  startBalance: number | null;
  creditLimit: number | null;
  inBalance: boolean;
  savings: boolean;
  archive: boolean;
  enableCorrection: boolean;
  enableSMS: boolean;
  syncID: string[] | null;
}

export interface DiffTransaction {
  id: string;
  date: string; // yyyy-MM-dd
  income: number;
  incomeAccount: string;
  incomeInstrument: number;
  outcome: number;
  outcomeAccount: string;
  outcomeInstrument: number;
  payee: string | null;
  mcc: number | null;
  comment: string | null;
  hold: boolean | null;
  opIncome?: number;
  opIncomeInstrument?: number;
  opOutcome?: number;
  opOutcomeInstrument?: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function requireInstrument(code: string, instruments: InstrumentMap): number {
  const id = instruments(code);
  if (id == null) throw new Error(`Unknown ZenMoney instrument for currency "${code}"`);
  return id;
}

export function accountToDiff(a: ZenAccount, instruments: InstrumentMap): DiffAccount {
  return {
    id: stableUuid(`account:${a.id}`),
    type: a.type,
    title: a.title,
    instrument: requireInstrument(a.instrument, instruments),
    balance: a.balance ?? null,
    startBalance: null,
    creditLimit: a.creditLimit ?? null,
    inBalance: true,
    savings: a.savings ?? false,
    archive: false,
    enableCorrection: false,
    enableSMS: false,
    syncID: a.syncIds,
  };
}

export function transactionToDiff(
  tx: ZenTransaction,
  accountInstrument: string,
  instruments: InstrumentMap,
): DiffTransaction {
  const m = tx.movements[0];
  const sum = m.sum ?? 0;
  const instrId = requireInstrument(accountInstrument, instruments);
  const accId = "id" in m.account ? stableUuid(`account:${m.account.id}`) : stableUuid(`ref:${m.account.syncIds.join(",")}`);

  const base: DiffTransaction = {
    id: stableUuid(`tx:${tx.id ?? m.id ?? `${+tx.date}:${sum}`}`),
    date: ymd(tx.date),
    income: sum > 0 ? sum : 0,
    incomeAccount: accId,
    incomeInstrument: instrId,
    outcome: sum < 0 ? -sum : 0,
    outcomeAccount: accId,
    outcomeInstrument: instrId,
    payee: tx.merchant?.fullTitle ?? tx.merchant?.title ?? null,
    mcc: tx.merchant?.mcc ?? null,
    comment: tx.comment,
    hold: tx.hold,
  };

  // original-currency amount → op* fields
  if (m.invoice) {
    const opInstr = requireInstrument(m.invoice.instrument, instruments);
    const opSum = m.invoice.sum;
    if (opSum > 0) {
      base.opIncome = opSum;
      base.opIncomeInstrument = opInstr;
    } else {
      base.opOutcome = -opSum;
      base.opOutcomeInstrument = opInstr;
    }
  }
  return base;
}

export function scrapeToDiff(
  result: ScrapeResult,
  instruments: InstrumentMap,
): { accounts: DiffAccount[]; transactions: DiffTransaction[] } {
  const accounts = result.accounts.map((a) => accountToDiff(a, instruments));
  const instrumentByAccount = new Map(result.accounts.map((a) => [a.id, a.instrument]));
  const transactions = result.transactions.map((tx) => {
    const first = tx.movements[0].account;
    const code = "id" in first ? (instrumentByAccount.get(first.id) ?? "USD") : "USD";
    return transactionToDiff(tx, code, instruments);
  });
  return { accounts, transactions };
}
