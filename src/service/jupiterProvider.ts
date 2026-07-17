import { JupiterCard, parseMoney, signedAmount, transactionDate, type Transaction } from "jupiter-card-sdk";
import { toScrapeResult } from "../convert.js";
import { resolveDepositSources } from "../transfers.js";
import type { CardProvider, ProviderRead, TransferContext } from "./providers.js";

/**
 * The Jupiter card as a {@link CardProvider}.
 *
 * Its quirk is `year`: Jupiter's history is queried a calendar year at a time, so a run
 * covers each configured year and concatenates. Plasma has no such parameter.
 */
export class JupiterProvider implements CardProvider {
  readonly id = "jupiter" as const;
  readonly label = "Jupiter";
  private client: JupiterCard | null = null;
  private _email: string | null;

  constructor(email: string | null, private readonly sessionFile: string) {
    this._email = email;
    if (email) this.client = this.build(email);
  }

  private build(email: string): JupiterCard {
    return new JupiterCard({ auth: { kind: "email", email, sessionFile: this.sessionFile } });
  }

  get email(): string | null {
    return this._email;
  }

  setEmail(email: string): void {
    this._email = email;
    this.client = this.build(email);
  }

  isAuthenticated(): boolean {
    return this.client?.isAuthenticated() ?? false;
  }

  async sendCode(): Promise<void> {
    if (!this.client) throw new Error("Jupiter email not set — provide it first");
    await this.client.login.sendCode();
  }

  async verify(code: string): Promise<void> {
    if (!this.client) throw new Error("Jupiter email not set — provide it first");
    await this.client.login.verify(code);
  }

  async read(years: number[]): Promise<ProviderRead> {
    const client = this.client;
    if (!client) throw new Error("Jupiter email not set — provide it first");

    const [cards, balance] = await Promise.all([client.cards.list(), client.cards.balance()]);
    const txs: Transaction[] = [];
    for (const year of years) txs.push(...(await client.transactions.all({ year })));
    const scrape = toScrapeResult(cards, balance, txs);

    return {
      scrape,
      detail: {
        provider: this.id,
        label: this.label,
        cards: cards.map((c) => ({ last4: c.last4 ?? null, status: c.status ?? null })),
        balances: [
          { label: "Spendable", amount: parseMoney(balance.spendableBalance), currency: balance.currency || "USD" },
          { label: "Withdrawable", amount: parseMoney(balance.withdrawableBalance), currency: balance.currency || "USD" },
        ],
        transactionCount: txs.length,
        transactions: [...txs]
          // Sort on the parsed date: a record with an unreadable timestamp has no place in
          // the ordering, so send it to the end rather than let a compare against
          // `undefined` scramble the sample.
          .sort((a, b) => (transactionDate(b)?.getTime() ?? -Infinity) - (transactionDate(a)?.getTime() ?? -Infinity))
          .slice(0, 25)
          .map((t) => ({
            id: t.id,
            date: transactionDate(t)?.toISOString() ?? null,
            type: t.type ?? null,
            amount: signedAmount(t),
            currency: t.settlementCurrency ?? null,
            merchant: t.card?.merchantName ?? null,
          })),
        skipped: scrape.skipped,
      },
      // Jupiter gives only a signature, so each deposit costs a Solana RPC lookup — hence
      // the cache. Plasma's equivalent needs no network at all.
      resolveTransfers: (ctx: TransferContext) =>
        resolveDepositSources(txs, {
          solana: ctx.solana,
          accounts: ctx.accounts,
          cache: ctx.sigCache,
          log: ctx.log,
        }),
    };
  }
}
