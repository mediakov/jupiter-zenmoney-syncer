import { JupiterCard } from "jupiter-card-sdk";
import { PlasmaCard } from "plasma-card-sdk";
import { toScrapeResult, type ConversionResult } from "./convert.js";
import { toScrapeResult as plasmaToScrapeResult } from "./plasmaConvert.js";
import { scrapeToDiff, type SourceAccount } from "./toDiff.js";
import { ZenMoneyClient } from "./zenClient.js";
import { SolanaResolver } from "./solana.js";
import { resolveDepositSources, SignatureCache } from "./transfers.js";
import { resolvePlasmaTransferSources } from "./plasmaTransfers.js";
import type { ScrapeResult } from "./zenTypes.js";

export interface SyncOptions {
  /** Jupiter Card client. Optional — omit to sync only Plasma. */
  jupiter?: JupiterCard;
  /** Plasma One client. Optional — omit to sync only Jupiter. */
  plasma?: PlasmaCard;
  zen: ZenMoneyClient;
  /** Only sync Jupiter transactions in this calendar year (default: current). */
  year?: number;
  /** If true, don't push — just return what would be sent. */
  dryRun?: boolean;
  /** Solana resolver for deposit→transfer detection (default: public mainnet RPC). */
  solana?: SolanaResolver;
  /** Optional signature-resolution cache. */
  sigCache?: SignatureCache;
}

export interface SyncSummary {
  accounts: number;
  transactions: number;
  pushed: boolean;
  /** Records deliberately not booked (declines, unreadable rows), per provider. */
  skipped: ConversionResult["skipped"];
}

/**
 * Read the configured cards, convert to ZenMoney, and push via the diff API.
 * Idempotent: re-running updates the same records (stable ids).
 *
 * Both cards feed one diff. Each contributes its own `ccard` account, and every
 * transaction references its own account id, so the two never mix — but they are pushed
 * together, in one call, against one `serverTimestamp`.
 */
export async function sync(opts: SyncOptions): Promise<SyncSummary> {
  const { jupiter, plasma, zen } = opts;
  if (!jupiter && !plasma) throw new Error("sync: configure at least one of `jupiter` or `plasma`");
  const year = opts.year ?? new Date().getUTCFullYear();

  const scrapes: ConversionResult[] = [];
  // Raw transactions, kept for on-chain source tracing below.
  let jupiterTxs: Awaited<ReturnType<JupiterCard["transactions"]["all"]>> = [];
  let plasmaTxs: Awaited<ReturnType<PlasmaCard["transactions"]["all"]>> = [];

  if (jupiter) {
    const [cards, balance, transactions] = await Promise.all([
      jupiter.cards.list(),
      jupiter.cards.balance(),
      jupiter.transactions.all({ year }),
    ]);
    jupiterTxs = transactions;
    scrapes.push(toScrapeResult(cards, balance, transactions));
  }

  if (plasma) {
    // `user` carries the card account address — the account identity the converter keys on.
    const [user, cards, balance, transactions] = await Promise.all([
      plasma.account.user(),
      plasma.cards.list(),
      plasma.account.balance(),
      plasma.transactions.all({ includeDustReceives: true }),
    ]);
    plasmaTxs = transactions;
    scrapes.push(plasmaToScrapeResult(user, cards, balance, transactions));
  }

  const scrape: ScrapeResult = {
    accounts: scrapes.flatMap((s) => s.accounts),
    transactions: scrapes.flatMap((s) => s.transactions),
  };
  const skipped = scrapes.flatMap((s) => s.skipped);

  // resolve instruments + user id + existing accounts
  const { map, userId, serverTimestamp, accounts } = await zen.context();

  // Trace deposit sources; matched ones become transfers, the rest stay income.
  //
  // Both cards, by different routes to the same answer: Jupiter gives only a signature, so
  // its source costs a Solana RPC lookup (async, cached); Plasma puts `sender_address` on
  // the record, so its sources are free. One map either way — the keys are the ids the
  // converters emitted, which are provider-namespaced and cannot collide.
  const solana = opts.solana ?? new SolanaResolver();
  const transferSources = new Map<string, SourceAccount>([
    ...(jupiterTxs.length
      ? await resolveDepositSources(jupiterTxs, { solana, accounts, cache: opts.sigCache })
      : []),
    ...resolvePlasmaTransferSources(plasmaTxs, accounts),
  ]);

  const diff = scrapeToDiff(scrape, { instruments: map, userId, transferSources });

  if (!opts.dryRun) {
    await zen.push(diff.accounts, diff.transactions, serverTimestamp, diff.deletions);
  }

  return {
    accounts: diff.accounts.length,
    transactions: diff.transactions.length,
    pushed: !opts.dryRun,
    skipped,
  };
}
