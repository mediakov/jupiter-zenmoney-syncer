import { JupiterCard } from "jupiter-card-sdk";
import { toScrapeResult } from "../convert.js";
import { scrapeToDiff } from "../toDiff.js";
import { ZenMoneyClient } from "../zenClient.js";
import { SolanaResolver } from "../solana.js";
import { SignatureCache, resolveDepositSources } from "../transfers.js";
import { PushLedger } from "../pushLedger.js";
import type { ServiceConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { initialState, type ServiceState, type SyncDetail, type SyncKind } from "./state.js";

type Logger = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

/**
 * The long-running syncer: a periodic loop that reads Jupiter and pushes to
 * ZenMoney, plus headless auth bootstrap. Errors in one run never crash the
 * service — they're recorded in state and the loop continues.
 */
export class SyncService {
  private jupiter: JupiterCard | null;
  private jupiterEmail: string | null;
  private readonly creds: CredentialStore;
  private readonly solana: SolanaResolver;
  private readonly sigCache: SignatureCache;
  private readonly ledger: PushLedger;
  private zen: ZenMoneyClient | null;
  private readonly state: ServiceState = initialState();
  private lastDetail: SyncDetail | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ServiceConfig,
    private readonly log: Logger = () => {},
  ) {
    this.creds = new CredentialStore(config.credFile);
    // Jupiter email: env takes precedence, else a previously UI-provided one.
    this.jupiterEmail = config.jupiterEmail ?? this.creds.jupiterEmail ?? null;
    this.jupiter = this.jupiterEmail ? this.buildJupiter(this.jupiterEmail) : null;
    this.solana = new SolanaResolver({ rpc: config.solanaRpc });
    this.sigCache = new SignatureCache(config.sigCacheFile);
    this.ledger = new PushLedger(config.pushLedgerFile);
    // ZenMoney token: env takes precedence, else a previously UI-provided one.
    const token = config.zenToken ?? this.creds.zenToken ?? null;
    this.zen = token ? new ZenMoneyClient({ token }) : null;
    this.state.jupiterEmail = this.jupiterEmail;
    this.state.authenticated = this.jupiter?.isAuthenticated() ?? false;
    this.state.zenConnected = this.zen != null;
    this.state.status = this.state.authenticated ? "idle" : "needs-auth";
  }

  private buildJupiter(email: string): JupiterCard {
    return new JupiterCard({ auth: { kind: "email", email, sessionFile: this.config.sessionFile } });
  }

  /** Set (or change) the Jupiter account email (from the web UI/API); rebuilds the client. */
  setJupiterEmail(email: string): void {
    this.jupiterEmail = email;
    this.creds.setJupiterEmail(email);
    this.jupiter = this.buildJupiter(email);
    this.state.jupiterEmail = email;
    this.state.authenticated = this.jupiter.isAuthenticated();
    this.state.status = this.state.authenticated ? "idle" : "needs-auth";
    this.log("info", `Jupiter email set: ${email}`);
  }

  /** Store a ZenMoney API token (from the web UI/API) and start using it. */
  setZenToken(token: string): void {
    this.creds.setZenToken(token);
    this.zen = new ZenMoneyClient({ token });
    this.state.zenConnected = true;
    this.log("info", "ZenMoney token set");
  }

  getState(): Readonly<ServiceState> {
    return this.state;
  }

  /** Detail of the last sync: what we read from Jupiter and pushed to ZenMoney. */
  getLastDetail(): SyncDetail | null {
    return this.lastDetail;
  }

  /** Begin the schedule; runs an initial sync if already authenticated. */
  start(): void {
    this.log("info", `service started; interval ${this.config.intervalMs}ms, years ${this.config.years.join(",")}`);
    const tick = () => {
      this.state.nextSyncAt = new Date(Date.now() + this.config.intervalMs).toISOString();
      void this.runSync();
    };
    this.timer = setInterval(tick, this.config.intervalMs);
    if (this.jupiter?.isAuthenticated()) tick();
    else this.log("warn", "not authenticated — set the Jupiter email, then POST /auth/send-code and /auth/verify");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Send the Jupiter login OTP to the configured email. */
  async sendCode(): Promise<void> {
    if (!this.jupiter) throw new Error("Jupiter email not set — provide it first");
    await this.jupiter.login.sendCode();
    this.log("info", `OTP sent to ${this.jupiterEmail}`);
  }

  /** Complete Jupiter login with the emailed code, then kick off a sync. */
  async verifyCode(code: string): Promise<void> {
    if (!this.jupiter) throw new Error("Jupiter email not set — provide it first");
    await this.jupiter.login.verify(code);
    this.state.authenticated = true;
    this.state.status = "idle";
    this.log("info", "authenticated");
    void this.runSync();
  }

  /** Run one sync across all configured years. Safe to call concurrently (guarded). */
  async runSync(): Promise<void> {
    if (this.running) return;
    const jup = this.jupiter;
    if (!jup || !jup.isAuthenticated()) {
      this.state.status = "needs-auth";
      this.state.authenticated = false;
      return;
    }
    this.running = true;
    this.state.status = "syncing";
    try {
      const [cards, balance] = await Promise.all([jup.cards.list(), jup.cards.balance()]);
      const txs = [];
      for (const year of this.config.years) txs.push(...(await jup.transactions.all({ year })));
      const scrape = toScrapeResult(cards, balance, txs);

      // what we received from Jupiter (sample the most recent transactions)
      const jupiterDetail: SyncDetail["jupiter"] = {
        cards: cards.map((c) => ({ last4: c.last4, status: c.status })),
        balance: { currency: balance.currency, spendableBalance: balance.spendableBalance, withdrawableBalance: balance.withdrawableBalance },
        transactionCount: txs.length,
        transactions: [...txs]
          .sort((a, b) => (a.transactionTimestamp < b.transactionTimestamp ? 1 : -1))
          .slice(0, 25)
          .map((t) => ({
            id: t.id,
            date: t.transactionTimestamp,
            type: t.type,
            direction: t.direction,
            amount: t.settlementAmount,
            currency: t.settlementCurrency,
            merchant: t.card?.merchantName ?? null,
          })),
      };

      let pushed = false;
      let zenmoneyDetail: SyncDetail["zenmoney"];
      if (this.zen && !this.config.dryRun) {
        const { map, userId, serverTimestamp, accounts } = await this.zen.context();
        // trace deposit sources → map matching ones to transfers (else income)
        const transferSources = await resolveDepositSources(txs, {
          solana: this.solana,
          accounts,
          cache: this.sigCache,
          log: (m) => this.log("info", m),
        });
        const diff = scrapeToDiff(scrape, { instruments: map, userId, transferSources });
        // Only send what's new or changed since our last successful push — don't
        // re-transmit the whole window every sync.
        const toPush = this.ledger.pending(diff.accounts, diff.transactions, diff.deletions);
        const hasNew = toPush.accounts.length > 0 || toPush.transactions.length > 0 || toPush.deletions.length > 0;
        let resp: Awaited<ReturnType<ZenMoneyClient["push"]>> | null = null;
        if (hasNew) {
          resp = await this.zen.push(toPush.accounts, toPush.transactions, serverTimestamp, toPush.deletions);
          this.ledger.record(toPush);
        }
        pushed = true;

        // Reconstruct how each Jupiter transaction was classified, in human terms.
        const amt = (s: string | number | null | undefined) => (Number.isFinite(Number(s)) ? Number(s) : 0);
        const acctTitle = new Map(accounts.map((a) => [a.id, a.title]));
        const cardTitle = scrape.accounts[0]?.title ?? "Jupiter Card";
        const cardCcy = balance.currency || "USD";
        const mapped = txs.map((t) => {
          const credit = t.direction === "CREDIT";
          const src = t.type !== "CARD" && credit ? transferSources.get(t.id) : undefined;
          const kind: SyncKind = src ? "transfer" : credit ? "income" : "expense";
          return {
            date: t.transactionTimestamp,
            kind,
            amount: Math.abs(amt(t.settlementAmount)),
            currency: t.settlementCurrency || cardCcy,
            account: cardTitle,
            source: src ? (acctTitle.get(src.accountId) ?? "source account") : null,
            payee: t.card?.merchantName ?? null,
            mcc: t.card?.merchantCategoryCode ? Number(t.card.merchantCategoryCode) || null : null,
            op:
              t.transactionCurrency && t.transactionCurrency !== t.settlementCurrency
                ? `${amt(t.transactionAmount).toFixed(2)} ${t.transactionCurrency}`
                : null,
            hold: t.card ? t.card.settlementTimestamp === null : false,
          };
        });

        const counts: Record<SyncKind, number> = { expense: 0, income: 0, transfer: 0 };
        const totals: Record<SyncKind, number> = { expense: 0, income: 0, transfer: 0 };
        for (const m of mapped) {
          counts[m.kind] += 1;
          totals[m.kind] += m.amount;
        }

        const deposits = txs
          .filter((t) => t.type !== "CARD" && t.direction === "CREDIT")
          .sort((a, b) => (a.transactionTimestamp < b.transactionTimestamp ? 1 : -1))
          .map((t) => {
            const src = transferSources.get(t.id);
            const sig = t.onchainSignature ?? null;
            return {
              date: t.transactionTimestamp,
              amount: Math.abs(amt(t.settlementAmount)),
              currency: t.settlementCurrency || cardCcy,
              result: (src ? "transfer" : "income") as "transfer" | "income",
              detail: src
                ? `→ ${acctTitle.get(src.accountId) ?? "source account"}`
                : sig
                  ? "no matching account — kept as income"
                  : "no on-chain signature — kept as income",
              sig,
            };
          });

        zenmoneyDetail = {
          pushed: true,
          accounts: diff.accounts.length,
          transactions: diff.transactions.length,
          deletions: diff.deletions.length,
          pushedThisRun: {
            accounts: toPush.accounts.length,
            transactions: toPush.transactions.length,
            deletions: toPush.deletions.length,
          },
          serverTimestamp: resp?.serverTimestamp ?? serverTimestamp,
          counts,
          totals,
          transactionsSample: [...mapped].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 25),
          deposits,
        };
      } else {
        zenmoneyDetail = { pushed: false, reason: this.config.dryRun ? "dry-run" : "no ZenMoney token" };
      }

      this.lastDetail = { at: new Date().toISOString(), jupiter: jupiterDetail, zenmoney: zenmoneyDetail };
      this.state.lastResult = { accounts: scrape.accounts.length, transactions: scrape.transactions.length, pushed };
      this.state.lastSyncOk = true;
      this.state.lastError = null;
      this.state.syncCount += 1;
      const sent = zenmoneyDetail.pushed ? zenmoneyDetail.pushedThisRun : null;
      this.log("info", `sync ok: ${scrape.transactions.length} tx in window, sent ${sent ? sent.transactions : 0} new/changed`);
    } catch (e) {
      this.state.lastSyncOk = false;
      this.state.lastError = e instanceof Error ? e.message : String(e);
      this.log("error", `sync failed: ${this.state.lastError}`);
      // if the Jupiter session died beyond refresh, surface it for re-auth
      if (!this.jupiter?.isAuthenticated()) {
        this.state.authenticated = false;
        this.state.status = "needs-auth";
      }
    } finally {
      this.running = false;
      this.state.lastSyncAt = new Date().toISOString();
      if (this.state.status === "syncing") this.state.status = this.state.lastSyncOk ? "idle" : "error";
    }
  }
}
