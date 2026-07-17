import { directionSign, type Transaction } from "plasma-card-sdk";
import { matchAccount } from "./transfers.js";
import type { SourceAccount } from "./toDiff.js";
import type { ZenExistingAccount } from "./zenClient.js";

/**
 * Map Plasma's on-chain receives to the ZenMoney account they came from, so a deposit
 * from an account you already track is booked as a transfer rather than as income
 * appearing from nowhere.
 *
 * This is the Plasma counterpart of `resolveDepositSources`, and it is much smaller for
 * one reason: **the source arrives already resolved.** Jupiter gives only an on-chain
 * signature, so tracing a deposit costs a Solana RPC round-trip per signature — hence its
 * resolver is async and needs a cache. Plasma hands over `sender_address` on the record
 * itself, so there is nothing to look up: no network, no cache, no failure mode where the
 * RPC lacks the history.
 *
 * The matching rule is shared (`matchAccount`), so both cards behave identically: an exact
 * syncID wins; an ambiguous last-4 is treated as no match and the deposit stays income
 * rather than being attributed to a guess.
 *
 * Lives in its own module because `jupiter-card-sdk` and `plasma-card-sdk` both export
 * `Transaction` and `directionSign` — importing both into `transfers.ts` would collide.
 */
export function resolvePlasmaTransferSources(
  txs: Transaction[],
  accounts: ZenExistingAccount[],
  log?: (msg: string) => void,
): Map<string, SourceAccount> {
  const out = new Map<string, SourceAccount>();

  for (const t of txs) {
    const sender = t.sender_address;
    // Credits only: an outbound row's counterparty is a destination, not a source, and
    // toDiff applies a transfer source only to a positive sum anyway.
    if (typeof sender !== "string" || sender === "" || directionSign(t) !== 1) continue;
    if (t.status === "declined") continue;

    const match = matchAccount(sender, accounts);
    // Key by the ZenTransaction id, NOT the raw Plasma id: toDiff looks this map up with
    // the id the converter emitted, and that one is provider-namespaced.
    const key = `plasma:${t.id}`;
    const via = t.chain?.name ? ` via ${t.chain.name}` : "";
    if (match) {
      out.set(key, match);
      log?.(`plasma receive ${t.id.slice(0, 8)} from …${sender.slice(-6)}${via} → account ${match.accountId.slice(0, 8)} (transfer)`);
    } else {
      log?.(`plasma receive ${t.id.slice(0, 8)} from …${sender.slice(-6)}${via} — no matching account (income)`);
    }
  }

  return out;
}
