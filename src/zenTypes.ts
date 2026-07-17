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

export interface ZenLocation {
  latitude: number;
  longitude: number;
}

/**
 * A merchant whose parts the source already gives us separately. Use this when the API
 * hands over a clean name plus a city/country (Plasma does).
 */
export interface ZenParsedMerchant {
  title: string;
  city: string | null;
  country: string | null;
  mcc: number | null;
  location: ZenLocation | null;
  category?: string;
}

/**
 * A merchant we only have the raw descriptor for, e.g. "NL AMSTERDAM UBER 748264".
 * ZenMoney parses the title/city/country out of `fullTitle` itself — which is exactly
 * why you must not hand it a pre-split city alongside one.
 */
export interface ZenNonParsedMerchant {
  fullTitle: string;
  mcc: number | null;
  location: ZenLocation | null;
  category?: string;
}

/**
 * The two forms are alternatives, not a grab-bag: ZenMoney reads `fullTitle` OR the
 * parsed fields, never both. Modelling it as a union stops a hybrid — a `fullTitle`
 * carrying a separate `city` — from typechecking, which is what we had been emitting.
 */
export type ZenMerchant = ZenParsedMerchant | ZenNonParsedMerchant;

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
