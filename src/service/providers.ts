import type { ConversionResult } from "../convert.js";
import type { SourceAccount } from "../toDiff.js";
import type { SolanaResolver } from "../solana.js";
import type { SignatureCache } from "../transfers.js";
import type { ZenExistingAccount } from "../zenClient.js";

/** The cards this service can sync. Add one by implementing {@link CardProvider}. */
export type ProviderId = "jupiter" | "plasma";

/**
 * What a provider read, in terms the UI can show without knowing whose card it is.
 *
 * `balances` is a LIST rather than a fixed shape because providers hold money in
 * different pots — Jupiter has one spendable balance, Plasma has cash and earn — and
 * flattening that into a single field would have to pick a winner and lie about the rest.
 */
export interface ProviderDetail {
  provider: ProviderId;
  label: string;
  cards: Array<{ last4: string | null; status: string | null }>;
  balances: Array<{ label: string; amount: number | null; currency: string }>;
  transactionCount: number;
  /** A sample of the most recent transactions, newest first. */
  transactions: Array<{
    id: string;
    date: string | null;
    type: string | null;
    /** Signed: negative is money out. Null when the record could not be read. */
    amount: number | null;
    currency: string | null;
    merchant: string | null;
  }>;
  /**
   * Records deliberately not booked — a decline, or something unreadable. Surfaced
   * rather than dropped quietly: a silent skip looks exactly like "there was nothing
   * there".
   */
  skipped: Array<{ id: string; reason: string }>;
}

/** Everything needed to work out which deposits came from an account you already track. */
export interface TransferContext {
  accounts: ZenExistingAccount[];
  solana: SolanaResolver;
  sigCache?: SignatureCache;
  log?: (msg: string) => void;
}

export interface ProviderRead {
  /** Converted to the shared plugin (`movements`) format. */
  scrape: ConversionResult;
  detail: ProviderDetail;
  /**
   * Deposits traced back to an existing ZenMoney account, keyed by the id the converter
   * emitted (provider-namespaced). Deliberately a step of its own rather than part of
   * `read`: it needs the ZenMoney account list, which is fetched after reading. The
   * closure keeps the raw records so callers never have to handle a provider's own types.
   */
  resolveTransfers(ctx: TransferContext): Promise<Map<string, SourceAccount>>;
}

/**
 * One card, behind an interface the service can drive without knowing which it is.
 *
 * Auth is per provider on purpose: each card has its own login, its own session file, and
 * its own OTP. One of them being unauthenticated must never stop the other from syncing —
 * hence {@link isAuthenticated} per provider rather than one flag for the service.
 */
export interface CardProvider {
  readonly id: ProviderId;
  /** Human name for the UI, e.g. "Jupiter". */
  readonly label: string;
  /** The account email, or null when it has not been set yet. */
  readonly email: string | null;
  /** Set (or change) the account email; rebuilds the underlying client. */
  setEmail(email: string): void;
  isAuthenticated(): boolean;
  sendCode(): Promise<void>;
  verify(code: string): Promise<void>;
  read(years: number[]): Promise<ProviderRead>;
}

/** True when a provider has an email and can therefore at least attempt a login. */
export function isConfigured(p: CardProvider): boolean {
  return p.email !== null && p.email !== "";
}
