import { PlasmaCard, parseMoney, transactionDate, usdAmount } from "plasma-card-sdk";
import { toScrapeResult } from "../plasmaConvert.js";
import { resolvePlasmaTransferSources } from "../plasmaTransfers.js";
import type { CardProvider, ProviderRead, TransferContext } from "./providers.js";

/**
 * The Plasma One card as a {@link CardProvider}.
 *
 * Differences worth knowing, all of them observed rather than assumed:
 *  - History is not year-scoped; `years` is ignored and the cursor is walked to the end.
 *  - It holds two pots (cash + earn), so it reports two balances and produces two ZenMoney
 *    accounts.
 *  - Its deposits carry `sender_address` already resolved, so tracing them needs no RPC.
 */
export class PlasmaProvider implements CardProvider {
  readonly id = "plasma" as const;
  readonly label = "Plasma One";
  private client: PlasmaCard | null = null;
  private _email: string | null;

  constructor(email: string | null, private readonly sessionFile: string) {
    this._email = email;
    if (email) this.client = this.build(email);
  }

  private build(email: string): PlasmaCard {
    return new PlasmaCard({ auth: { kind: "email", email, sessionFile: this.sessionFile } });
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
    if (!this.client) throw new Error("Plasma email not set — provide it first");
    await this.client.login.sendCode();
  }

  async verify(code: string): Promise<void> {
    if (!this.client) throw new Error("Plasma email not set — provide it first");
    await this.client.login.verify(code);
  }

  /** `years` is accepted for interface symmetry and ignored: Plasma has no year filter. */
  async read(_years: number[]): Promise<ProviderRead> {
    const client = this.client;
    if (!client) throw new Error("Plasma email not set — provide it first");

    // `user` carries the card account address — the account identity the converter keys on.
    const [user, cards, balance, txs] = await Promise.all([
      client.account.user(),
      client.cards.list(),
      client.account.balance(),
      client.transactions.all({ includeDustReceives: true }),
    ]);
    const scrape = toScrapeResult(user, cards, balance, txs);
    const usd = (amount: string | undefined) =>
      parseMoney({ amount: amount ?? "", currency: "USD", decimals: balance.decimals ?? 6 });

    return {
      scrape,
      detail: {
        provider: this.id,
        label: this.label,
        cards: cards.map((c) => ({ last4: c.last_4 ?? null, status: c.status ?? null })),
        // Cash and earn are shown separately because they are separate accounts downstream;
        // `total` is included as the figure the Plasma app itself shows.
        balances: [
          { label: "Cash", amount: usd(balance.cash_balance), currency: "USD" },
          { label: "Earn", amount: usd(balance.earn_balance), currency: "USD" },
          { label: "Total", amount: usd(balance.total_balance), currency: "USD" },
        ],
        transactionCount: txs.length,
        transactions: [...txs]
          .sort((a, b) => (transactionDate(b)?.getTime() ?? -Infinity) - (transactionDate(a)?.getTime() ?? -Infinity))
          .slice(0, 25)
          .map((t) => ({
            id: t.id,
            date: transactionDate(t)?.toISOString() ?? null,
            type: t.type ?? null,
            // usdAmount, not the raw figure: it normalises the USDT / USDT0 split, and
            // returns null rather than pretend a non-dollar token is dollars.
            amount: usdAmount(t),
            currency: t.amount?.currency ?? null,
            merchant: t.merchant?.name ?? null,
          })),
        skipped: scrape.skipped,
      },
      // No RPC, no cache: `sender_address` is on the record already.
      resolveTransfers: async (ctx: TransferContext) =>
        resolvePlasmaTransferSources(txs, ctx.accounts, ctx.log),
    };
  }
}
