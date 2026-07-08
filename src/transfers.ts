import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Transaction } from "jupiter-card-sdk";
import type { ZenExistingAccount } from "./zenClient.js";
import type { SourceAccount } from "./toDiff.js";
import type { SolanaResolver } from "./solana.js";

/**
 * Match a source wallet address to an existing ZenMoney account. Strong match:
 * a syncID equals the full address. Weak match (per the deposit spec): a syncID
 * ends with the same last-4 characters. An ambiguous last-4 (>1 account) is
 * treated as no match, so the deposit falls back to income rather than guessing.
 */
export function matchAccount(sourceAddress: string, accounts: ZenExistingAccount[]): SourceAccount | null {
  for (const a of accounts) {
    if (a.syncID?.some((s) => s === sourceAddress)) return { accountId: a.id, instrument: a.instrument };
  }
  const last4 = sourceAddress.slice(-4);
  const hits = accounts.filter((a) => a.syncID?.some((s) => s.slice(-4) === last4));
  return hits.length === 1 ? { accountId: hits[0]!.id, instrument: hits[0]!.instrument } : null;
}

/** Persistent signature → source-address cache (resolution is immutable). */
export class SignatureCache {
  private data: Record<string, string | null> = {};
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        this.data = {};
      }
    }
  }
  get(sig: string): string | null | undefined {
    return sig in this.data ? this.data[sig] : undefined;
  }
  set(sig: string, addr: string | null): void {
    this.data[sig] = addr;
    if (!this.path) return;
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }
}

export interface ResolveOptions {
  solana: SolanaResolver;
  accounts: ZenExistingAccount[];
  cache?: SignatureCache;
  log?: (msg: string) => void;
}

/**
 * For each deposit (CREDIT with an on-chain signature), resolve its source
 * wallet and, if it maps to an existing ZenMoney account, record it so the
 * deposit is emitted as a transfer. Deposits that don't resolve or don't match
 * are simply absent → they stay as income.
 *
 * Returns a map keyed by Jupiter transaction id.
 */
export async function resolveDepositSources(
  txs: Transaction[],
  opts: ResolveOptions,
): Promise<Map<string, SourceAccount>> {
  const out = new Map<string, SourceAccount>();
  const deposits = txs.filter((t) => t.onchainSignature && t.direction === "CREDIT" && t.type !== "CARD");
  for (const t of deposits) {
    const sig = t.onchainSignature!;
    let addr = opts.cache?.get(sig);
    if (!addr) {
      // only cache successful resolutions — an unresolved sig (e.g. the RPC
      // lacks that history) should be retried next run, perhaps with a better RPC.
      addr = await opts.solana.sourceAddress(sig, Number(t.settlementAmount));
      if (addr) opts.cache?.set(sig, addr);
    }
    if (!addr) continue;
    const match = matchAccount(addr, opts.accounts);
    if (match) {
      out.set(t.id, match);
      opts.log?.(`deposit ${t.id.slice(0, 8)} traced to …${addr.slice(-6)} → account ${match.accountId.slice(0, 8)} (transfer)`);
    } else {
      opts.log?.(`deposit ${t.id.slice(0, 8)} source …${addr.slice(-6)} — no matching account (income)`);
    }
  }
  return out;
}
