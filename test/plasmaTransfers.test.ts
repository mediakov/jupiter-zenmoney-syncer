import { describe, it, expect } from "vitest";
import { resolvePlasmaTransferSources } from "../src/plasmaTransfers.js";
import type { Transaction } from "plasma-card-sdk";
import type { ZenExistingAccount } from "../src/zenClient.js";

// The real sender address from a captured Solana receive; the rest is synthetic.
const SENDER = "A8pXcKQ6Zh7Y3haLJ4JZcgwHC4RB5hhELRXGN7imwfHm";

const receive = (o: Partial<Transaction> = {}): Transaction =>
  ({
    id: "bdfc5eb0-7d33-49f2-8313-b844bdb6f791",
    amount: { amount: "214792305", currency: "USDT0", decimals: 6 },
    timestamp: "1784231122485",
    status: "completed",
    type: "receive",
    source: "onchain",
    balance_type: "cash",
    sender_address: SENDER,
    tx_hash: "0x8380b4198c9871e00cabf164ea30f9eb5f13d93499333cb37c160fc7485e06bb",
    chain: { id: 0, name: "Solana", key: "solana" },
    ...o,
  }) as Transaction;

const acct = (o: Partial<ZenExistingAccount>): ZenExistingAccount =>
  ({ id: "zen-acct-1", instrument: 1, syncID: [], ...o }) as ZenExistingAccount;

describe("resolvePlasmaTransferSources", () => {
  it("keys by the ZenTransaction id, not the raw Plasma id", () => {
    // toDiff looks the map up with the id the converter emitted, which is namespaced.
    // Keying by the raw id here would silently never match, and every transfer would
    // quietly stay income — a failure that looks exactly like "nothing to trace".
    const m = resolvePlasmaTransferSources([receive()], [acct({ syncID: [SENDER] })]);
    expect([...m.keys()]).toEqual(["plasma:bdfc5eb0-7d33-49f2-8313-b844bdb6f791"]);
  });

  it("matches a sender address to an account that carries it as a syncID", () => {
    const m = resolvePlasmaTransferSources([receive()], [acct({ id: "sol-wallet", syncID: [SENDER] })]);
    expect(m.get("plasma:bdfc5eb0-7d33-49f2-8313-b844bdb6f791")).toEqual({ accountId: "sol-wallet", instrument: 1 });
  });

  it("leaves an unmatched receive as income rather than attributing it to a guess", () => {
    const m = resolvePlasmaTransferSources([receive()], [acct({ syncID: ["some-other-wallet"] })]);
    expect(m.size).toBe(0);
  });

  it("ignores a receive with no sender address — there is nothing to trace", () => {
    expect(resolvePlasmaTransferSources([receive({ sender_address: null })], [acct({ syncID: [SENDER] })]).size).toBe(0);
    expect(resolvePlasmaTransferSources([receive({ sender_address: "" })], [acct({ syncID: [SENDER] })]).size).toBe(0);
  });

  it("ignores debits: a counterparty on an outgoing row is a destination, not a source", () => {
    const outgoing = receive({ amount: { amount: "-5000000", currency: "USDT", decimals: 6 }, type: "send" });
    expect(resolvePlasmaTransferSources([outgoing], [acct({ syncID: [SENDER] })]).size).toBe(0);
  });

  it("ignores a declined row — no money moved, so there is no transfer", () => {
    expect(resolvePlasmaTransferSources([receive({ status: "declined" })], [acct({ syncID: [SENDER] })]).size).toBe(0);
  });

  it("needs no network: it is synchronous, because the sender arrives resolved", () => {
    // The contrast with Jupiter, which must ask a Solana RPC what a signature resolved to.
    const result = resolvePlasmaTransferSources([receive()], [acct({ syncID: [SENDER] })]);
    expect(result).toBeInstanceOf(Map); // not a Promise
  });

  it("logs both outcomes, so a deposit never becomes income silently", () => {
    const lines: string[] = [];
    resolvePlasmaTransferSources([receive()], [acct({ syncID: [SENDER] })], (m) => lines.push(m));
    resolvePlasmaTransferSources([receive({ id: "other" })], [acct({ syncID: ["x"] })], (m) => lines.push(m));
    expect(lines[0]).toContain("transfer");
    expect(lines[0]).toContain("Solana"); // the chain it came over
    expect(lines[1]).toContain("income");
  });
});
