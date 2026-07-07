import { JupiterCard } from "jupiter-card-sdk";
import { toScrapeResult } from "./convert.js";
import { scrapeToDiff } from "./toDiff.js";
import { ZenMoneyClient } from "./zenClient.js";

export interface SyncOptions {
  jupiter: JupiterCard;
  zen: ZenMoneyClient;
  /** Only sync transactions in this calendar year (default: current). */
  year?: number;
  /** If true, don't push — just return what would be sent. */
  dryRun?: boolean;
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

  // 3. resolve instruments, then adapt movements → diff format
  const { map, serverTimestamp } = await zen.instruments();
  const diff = scrapeToDiff(scrape, map);

  // 4. push (unless dry run)
  if (!opts.dryRun) {
    await zen.push(diff.accounts, diff.transactions, serverTimestamp);
  }

  return { accounts: diff.accounts.length, transactions: diff.transactions.length, pushed: !opts.dryRun };
}
