import { JupiterCard } from "jupiter-card-sdk";
import { toScrapeResult } from "./convert.js";
import { scrapeToDiff } from "./toDiff.js";
import { ZenMoneyClient } from "./zenClient.js";
import { SolanaResolver } from "./solana.js";
import { resolveDepositSources, SignatureCache } from "./transfers.js";

export interface SyncOptions {
  jupiter: JupiterCard;
  zen: ZenMoneyClient;
  /** Only sync transactions in this calendar year (default: current). */
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
}

/**
 * Read the Jupiter Card account + transactions, convert to ZenMoney, and push
 * via the diff API. Idempotent: re-running updates the same records (stable ids).
 */
export async function sync(opts: SyncOptions): Promise<SyncSummary> {
  const { jupiter, zen } = opts;
  const year = opts.year ?? new Date().getUTCFullYear();

  // 1. read from Jupiter
  const [cards, balance, transactions] = await Promise.all([
    jupiter.cards.list(),
    jupiter.cards.balance(),
    jupiter.transactions.all({ year }),
  ]);

  // 2. shared converter → ZenMoney plugin (movements) format
  const scrape = toScrapeResult(cards, balance, transactions);

  // 3. resolve instruments + user id + existing accounts
  const { map, userId, serverTimestamp, accounts } = await zen.context();

  // trace deposit sources on-chain; matched ones become transfers, rest income
  const solana = opts.solana ?? new SolanaResolver();
  const transferSources = await resolveDepositSources(transactions, { solana, accounts, cache: opts.sigCache });

  // adapt movements → diff format
  const diff = scrapeToDiff(scrape, { instruments: map, userId, transferSources });

  // 4. push (unless dry run)
  if (!opts.dryRun) {
    await zen.push(diff.accounts, diff.transactions, serverTimestamp, diff.deletions);
  }

  return { accounts: diff.accounts.length, transactions: diff.transactions.length, pushed: !opts.dryRun };
}
