/**
 * Resolve a Solana transaction signature to the **source wallet** that sent the
 * funds — used to turn a Jupiter deposit into a ZenMoney transfer.
 *
 * A Jupiter USDC deposit is an SPL `transfer`/`transferChecked`; the sender is
 * the instruction's `authority` (the signing wallet). We pick the transfer whose
 * amount best matches the deposit, falling back to the first, then to a native
 * SOL transfer's `source`.
 */
export interface SolanaResolverOptions {
  /** RPC endpoint (default: public mainnet). */
  rpc?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface ParsedInstruction {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

export class SolanaResolver {
  private readonly rpc: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SolanaResolverOptions = {}) {
    this.rpc = opts.rpc ?? "https://api.mainnet-beta.solana.com";
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * Return the source wallet address for a signature, or null if it can't be
   * resolved (bad sig, RPC error, no transfer found).
   * @param expectedAmount optional UI amount to disambiguate multiple transfers.
   */
  async sourceAddress(signature: string, expectedAmount?: number): Promise<string | null> {
    let tx: any;
    try {
      const res = await this.fetchImpl(this.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const j: any = await res.json();
      if (j.error || !j.result) return null;
      tx = j.result;
    } catch {
      return null;
    }

    const instrs: ParsedInstruction[] = [
      ...(tx.transaction?.message?.instructions ?? []),
      ...(tx.meta?.innerInstructions?.flatMap((i: any) => i.instructions) ?? []),
    ];

    // SPL token transfers — pick the one closest to expectedAmount, else first
    const transfers = instrs.filter(
      (i) => i.program === "spl-token" && i.parsed && /transfer/i.test(i.parsed.type ?? ""),
    );
    if (transfers.length) {
      let best = transfers[0]!;
      if (expectedAmount != null) {
        const amt = (t: ParsedInstruction) => {
          const info = t.parsed?.info as any;
          const ui = info?.tokenAmount?.uiAmount ?? (info?.amount ? Number(info.amount) / 1e6 : undefined);
          return typeof ui === "number" ? Math.abs(ui - expectedAmount) : Number.POSITIVE_INFINITY;
        };
        best = transfers.reduce((a, b) => (amt(b) < amt(a) ? b : a), transfers[0]!);
      }
      const auth = (best.parsed?.info as any)?.authority;
      if (typeof auth === "string") return auth;
    }

    // native SOL transfer fallback
    const sol = instrs.find((i) => i.program === "system" && i.parsed?.type === "transfer");
    const src = (sol?.parsed?.info as any)?.source;
    return typeof src === "string" ? src : null;
  }
}
