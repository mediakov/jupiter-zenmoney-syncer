import { describe, it, expect } from "vitest";
import { SolanaResolver } from "../src/solana.js";

function rpcReturning(result: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))) as unknown as typeof fetch;
}

describe("SolanaResolver.sourceAddress", () => {
  it("uses the SPL transfer authority when present", async () => {
    const s = new SolanaResolver({
      fetch: rpcReturning({
        transaction: { message: { instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { authority: "WALLET_AUTH" } } }] } },
        meta: { innerInstructions: [] },
      }),
    });
    expect(await s.sourceAddress("sig")).toBe("WALLET_AUTH");
  });

  it("falls back to the owner whose token balance dropped (authority null)", async () => {
    const s = new SolanaResolver({
      fetch: rpcReturning({
        transaction: { message: { instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { authority: null } } }] } },
        meta: {
          innerInstructions: [],
          preTokenBalances: [
            { accountIndex: 1, owner: "SENDER", uiTokenAmount: { uiAmountString: "500" } },
            { accountIndex: 2, owner: "RECIPIENT", uiTokenAmount: { uiAmountString: "10" } },
          ],
          postTokenBalances: [
            { accountIndex: 1, owner: "SENDER", uiTokenAmount: { uiAmountString: "0" } },
            { accountIndex: 2, owner: "RECIPIENT", uiTokenAmount: { uiAmountString: "510" } },
          ],
        },
      }),
    });
    expect(await s.sourceAddress("sig")).toBe("SENDER");
  });

  it("returns null when the transaction isn't found", async () => {
    const s = new SolanaResolver({ fetch: rpcReturning(null) });
    expect(await s.sourceAddress("sig")).toBeNull();
  });
});
