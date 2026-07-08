import { describe, it, expect, vi } from "vitest";
import { matchAccount, resolveDepositSources } from "../src/transfers.js";
import { transactionToDiff } from "../src/toDiff.js";
import type { SolanaResolver } from "../src/solana.js";
import type { ZenExistingAccount } from "../src/zenClient.js";
import type { Transaction } from "jupiter-card-sdk";
import type { ZenTransaction } from "../src/zenTypes.js";

const accounts: ZenExistingAccount[] = [
  { id: "wallet-uuid", instrument: 3, title: "Phantom", syncID: ["5j8FFP2S5S9VcFiEkyDgSDJBcs7aU5p1DqADbjEXrs9z"] },
  { id: "bank-uuid", instrument: 1, title: "Bank", syncID: ["1234567890"] },
];

describe("matchAccount", () => {
  it("matches on the full address", () => {
    expect(matchAccount("5j8FFP2S5S9VcFiEkyDgSDJBcs7aU5p1DqADbjEXrs9z", accounts)).toEqual({ accountId: "wallet-uuid", instrument: 3 });
  });
  it("matches on the last-4", () => {
    expect(matchAccount("SomeOtherWalletThatEndsInrs9z", accounts)).toEqual({ accountId: "wallet-uuid", instrument: 3 });
  });
  it("no match → null", () => {
    expect(matchAccount("Nope0000", accounts)).toBeNull();
  });
  it("ambiguous last-4 (2 accounts) → null (falls back to income)", () => {
    const dup = [...accounts, { id: "x", instrument: 1, title: "X", syncID: ["zzzzrs9z"] }];
    expect(matchAccount("aaaaaaaars9z", dup)).toBeNull();
  });
});

function deposit(id: string, sig: string | null, amount = "500.03"): Transaction {
  return {
    id, cardId: "c", type: "DEPOSIT", direction: "CREDIT", settlementCurrency: "USDC", settlementAmount: amount,
    transactionCurrency: "USDC", transactionAmount: amount, providerTransactionId: "p", onchainSignature: sig,
    transactionTimestamp: "2026-07-04T14:27:16.001Z", card: null, deposit: null, withdrawal: null, qr: null,
  };
}

describe("resolveDepositSources", () => {
  it("maps a deposit whose source matches an account; skips unmatched", async () => {
    const solana = {
      sourceAddress: vi.fn(async (sig: string) =>
        sig === "sigA" ? "5j8FFP2S5S9VcFiEkyDgSDJBcs7aU5p1DqADbjEXrs9z" : "UnknownWallet9999"),
    } as unknown as SolanaResolver;
    const map = await resolveDepositSources([deposit("txA", "sigA"), deposit("txB", "sigB")], { solana, accounts });
    expect(map.get("txA")).toEqual({ accountId: "wallet-uuid", instrument: 3 });
    expect(map.has("txB")).toBe(false); // resolved but no matching account → income
  });

  it("skips deposits with no signature", async () => {
    const solana = { sourceAddress: vi.fn() } as unknown as SolanaResolver;
    const map = await resolveDepositSources([deposit("txC", null)], { solana, accounts });
    expect(map.size).toBe(0);
    expect(solana.sourceAddress).not.toHaveBeenCalled();
  });
});

describe("transactionToDiff transfer emission", () => {
  const ztx: ZenTransaction = {
    id: "txA", date: new Date("2026-07-04T14:27:16.001Z"), hold: false, merchant: null, comment: "deposit",
    movements: [{ id: "txA", account: { id: "acct_1" }, invoice: null, sum: 500.03, fee: 0 }],
  };
  const instruments = (c: string) => ({ USD: 1, USDC: 3 })[c.toUpperCase()];

  it("with a source → transfer (income to card, outcome from source)", () => {
    const d = transactionToDiff(ztx, "USD", {
      instruments, userId: 1, transferSources: new Map([["txA", { accountId: "wallet-uuid", instrument: 3 }]]),
    });
    expect(d.income).toBe(500.03);
    expect(d.outcome).toBe(500.03);
    expect(d.outcomeAccount).toBe("wallet-uuid"); // real ZenMoney account id, not hashed
    expect(d.outcomeInstrument).toBe(3);
  });

  it("without a source → plain income (single account)", () => {
    const d = transactionToDiff(ztx, "USD", { instruments, userId: 1 });
    expect(d.income).toBe(500.03);
    expect(d.outcome).toBe(0);
    expect(d.outcomeAccount).not.toBe("wallet-uuid");
  });

  it("transfer changed is stable normally, but 'now' under reconcile", () => {
    const src = new Map([["txA", { accountId: "wallet-uuid", instrument: 3 }]]);
    const normal = transactionToDiff(ztx, "USD", { instruments, userId: 1, transferSources: src });
    expect(normal.changed).toBeLessThan(Math.floor(Date.now() / 1000) - 60); // stable (tx date)
    const forced = transactionToDiff(ztx, "USD", { instruments, userId: 1, transferSources: src, reconcile: true });
    expect(forced.changed).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5); // ≈ now
  });
});
