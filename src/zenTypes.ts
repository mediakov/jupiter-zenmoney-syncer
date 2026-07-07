/**
 * ZenMoney **plugin** data model (the `movements` format). Distinct from the
 * backend `/v8/diff` format in `./toDiff.ts`.
 *
 * Refs:
 *  - https://github.com/zenmoney/ZenPlugins/blob/master/docs/README.md
 *  - https://github.com/zenmoney/ZenPlugins/blob/master/docs/transactionsExamples.md
 */

export type AccountType = "ccard" | "checking" | "card" | "cash" | "loan" | "deposit" | "debt" | "emoney";

export interface ZenAccount {
  id: string;
  type: AccountType;
  title: string;
  instrument: string;
  balance?: number;
  available?: number;
  creditLimit?: number;
  syncIds: string[] | null;
  savings?: boolean;
}

export interface ZenInvoice {
  sum: number;
  instrument: string;
}

export interface ZenAccountReference {
  type: AccountType | null;
  instrument: string;
  company?: null;
  syncIds: string[];
}

export interface ZenMovement {
  id: string | null;
  account: { id: string } | ZenAccountReference;
  invoice: ZenInvoice | null;
  sum: number | null;
  fee: number | null;
}

export interface ZenMerchant {
  fullTitle?: string;
  title?: string;
  city?: string | null;
  country?: string | null;
  mcc: number | null;
  location?: { latitude: number; longitude: number } | null;
}

export interface ZenTransaction {
  id?: string;
  date: Date;
  hold: boolean | null;
  merchant: ZenMerchant | null;
  movements: [ZenMovement] | [ZenMovement, ZenMovement];
  comment: string | null;
}

export interface ScrapeResult {
  accounts: ZenAccount[];
  transactions: ZenTransaction[];
}
