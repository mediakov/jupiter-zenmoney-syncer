import { scrapeToDiff, type SourceAccount } from "../toDiff.js";
import { ZenMoneyClient } from "../zenClient.js";
import { SolanaResolver } from "../solana.js";
import { SignatureCache } from "../transfers.js";
import { PushLedger } from "../pushLedger.js";
import type { ScrapeResult, ZenTransaction } from "../zenTypes.js";
import type { ServiceConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { JupiterProvider } from "./jupiterProvider.js";
import { PlasmaProvider } from "./plasmaProvider.js";
import { isConfigured, type CardProvider, type ProviderDetail, type ProviderId, type ProviderRead } from "./providers.js";
import { initialState, type ServiceState, type SyncDetail, type SyncKind } from "./state.js";

type Logger = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

/**
 * The long-running syncer: a periodic loop that reads every configured card and pushes to
 * ZenMoney, plus headless auth bootstrap. Errors in one run never crash the service —
 * they're recorded in state and the loop continues.
 *
 * Multi-card by construction. Each card is a {@link CardProvider} with its own login,
 * session file and OTP, and a card that is not configured, or not yet authenticated, is
 * skipped rather than blocking the others: one expired session must not stop the other
 * card from syncing.
 */
export class SyncService {
  private readonly providers: CardProvider[];
  private readonly creds: CredentialStore;
  private readonly solana: SolanaResolver;
  private readonly sigCache: SignatureCache;
  private readonly ledger: PushLedger;
  private zen: ZenMoneyClient | null;
  private readonly state: ServiceState;
  private lastDetail: SyncDetail | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ServiceConfig,
    private readonly log: Logger = () => {},
  ) {
    this.creds = new CredentialStore(config.credFile);
    // Env takes precedence, else a previously UI-provided email.
    this.providers = [
      new JupiterProvider(config.jupiterEmail ?? this.creds.jupiterEmail ?? null, config.sessionFile),
      new PlasmaProvider(config.plasmaEmail ?? this.creds.plasmaEmail ?? null, config.plasmaSessionFile),
    ];
    this.solana = new SolanaResolver({ rpc: config.solanaRpc });
    this.sigCache = new SignatureCache(config.sigCacheFile);
    this.ledger = new PushLedger(config.pushLedgerFile);
    const token = config.zenToken ?? this.creds.zenToken ?? null;
    this.zen = token ? new ZenMoneyClient({ token }) : null;
    this.state = initialState(this.providerStates());
    this.state.zenConnected = this.zen != null;
    this.state.status = this.needsAuth() ? "needs-auth" : "idle";
  }

  private providerStates() {
    return this.providers.map((p) => ({
      id: p.id,
      label: p.label,
      email: p.email,
      authenticated: p.isAuthenticated(),
    }));
  }

  /** The cards that are configured AND logged in — the ones a sync can actually read. */
  private ready(): CardProvider[] {
    return this.providers.filter((p) => isConfigured(p) && p.isAuthenticated());
  }

  /** True when a card has an email but no session: a human needs to enter an OTP. */
  private needsAuth(): boolean {
    return this.providers.some((p) => isConfigured(p) && !p.isAuthenticated());
  }

  private provider(id: string): CardProvider {
    const p = this.providers.find((x) => x.id === id);
    if (!p) throw new Error(`unknown provider "${id}"`);
    return p;
  }

  private refreshProviderState(): void {
    this.state.providers = this.providerStates();
  }

  /** Set (or change) a card's account email (from the web UI/API); rebuilds its client. */
  setEmail(id: ProviderId, email: string): void {
    const p = this.provider(id);
    p.setEmail(email);
    if (id === "jupiter") this.creds.setJupiterEmail(email);
    else this.creds.setPlasmaEmail(email);
    this.refreshProviderState();
    this.state.status = this.needsAuth() ? "needs-auth" : "idle";
    this.log("info", `${p.label} email set: ${email}`);
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

  /** Detail of the last sync: what each card returned and what was pushed to ZenMoney. */
  getLastDetail(): SyncDetail | null {
    return this.lastDetail;
  }

  /** Begin the schedule; runs an initial sync if any card is already authenticated. */
  start(): void {
    this.log("info", `service started; interval ${this.config.intervalMs}ms, years ${this.config.years.join(",")}`);
    const tick = () => {
      this.state.nextSyncAt = new Date(Date.now() + this.config.intervalMs).toISOString();
      void this.runSync();
    };
    this.timer = setInterval(tick, this.config.intervalMs);
    if (this.ready().length > 0) tick();
    const pending = this.providers.filter((p) => isConfigured(p) && !p.isAuthenticated());
    for (const p of pending) {
      this.log("warn", `${p.label} not authenticated — POST /auth/${p.id}/send-code, then /auth/${p.id}/verify`);
    }
    if (this.providers.every((p) => !isConfigured(p))) {
      this.log("warn", "no card configured — set an email via the UI or JUP_EMAIL / PLASMA_EMAIL");
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Send a card's login OTP to its configured email. */
  async sendCode(id: ProviderId): Promise<void> {
    const p = this.provider(id);
    await p.sendCode();
    this.log("info", `${p.label} OTP sent to ${p.email}`);
  }

  /** Complete a card's login with its emailed code, then kick off a sync. */
  async verifyCode(id: ProviderId, code: string): Promise<void> {
    const p = this.provider(id);
    await p.verify(code);
    this.refreshProviderState();
    this.state.status = this.needsAuth() ? "needs-auth" : "idle";
    this.log("info", `${p.label} authenticated`);
    void this.runSync();
  }

  /** Run one sync across every ready card. Safe to call concurrently (guarded). */
  async runSync(): Promise<void> {
    if (this.running) return;
    const ready = this.ready();
    if (ready.length === 0) {
      this.state.status = "needs-auth";
      this.refreshProviderState();
      return;
    }
    this.running = true;
    this.state.status = "syncing";
    try {
      // 1. read every ready card
      const reads: ProviderRead[] = [];
      for (const p of ready) reads.push(await p.read(this.config.years));

      const scrape: ScrapeResult = {
        accounts: reads.flatMap((r) => r.scrape.accounts),
        transactions: reads.flatMap((r) => r.scrape.transactions),
      };
      const sources: ProviderDetail[] = reads.map((r) => r.detail);

      for (const d of sources) {
        if (d.skipped.length > 0) {
          this.log(
            "warn",
            `${d.label}: ${d.skipped.length} record(s) not booked: ` +
              d.skipped.map((s) => `${s.id} (${s.reason})`).join("; "),
          );
        }
      }

      // 2. push
      let pushed = false;
      let zenmoneyDetail: SyncDetail["zenmoney"];
      if (this.zen && !this.config.dryRun) {
        const { map, userId, serverTimestamp, accounts } = await this.zen.context();

        // Each card traces its own deposits — Jupiter via a Solana lookup, Plasma from the
        // record. One map: the keys are converter ids, which are provider-namespaced.
        const transferSources = new Map<string, SourceAccount>();
        for (const r of reads) {
          const found = await r.resolveTransfers({
            accounts,
            solana: this.solana,
            sigCache: this.sigCache,
            log: (m) => this.log("info", m),
          });
          for (const [k, v] of found) transferSources.set(k, v);
        }

        const diff = scrapeToDiff(scrape, { instruments: map, userId, transferSources });
        // Only send what's new or changed since our last successful push.
        const toPush = this.ledger.pending(diff.accounts, diff.transactions, diff.deletions);
        const hasNew = toPush.accounts.length > 0 || toPush.transactions.length > 0 || toPush.deletions.length > 0;
        let resp: Awaited<ReturnType<ZenMoneyClient["push"]>> | null = null;
        if (hasNew) {
          resp = await this.zen.push(toPush.accounts, toPush.transactions, serverTimestamp, toPush.deletions);
          this.ledger.record(toPush);
        }
        this.ledger.retain(diff.accounts, diff.transactions, diff.deletions);
        pushed = true;

        // 3. reconstruct how each record was classified, in human terms.
        //
        // Built from the CONVERTED transactions and the diff — not from any card's raw
        // records. Those are provider-specific, and the two lists are index-aligned with
        // the diff only after conversion; reading raw would both re-implement each card's
        // quirks here and risk misreporting which rows were pushed.
        const acctTitle = new Map(accounts.map((a) => [a.id, a.title]));
        const titleByAccountId = new Map(scrape.accounts.map((a) => [a.id, a.title]));
        const providerOf = (tx: ZenTransaction): ProviderId | null =>
          tx.id?.startsWith("plasma:") ? "plasma" : reads.some((r) => r.scrape.transactions.includes(tx)) ? "jupiter" : null;

        const mapped = scrape.transactions.map((tx, i) => {
          const d = diff.transactions[i]!;
          const m = tx.movements[0];
          const isTransfer = d.income > 0 && d.outcome > 0;
          const kind: SyncKind = isTransfer ? "transfer" : d.income > 0 ? "income" : "expense";
          const own = "id" in m.account ? titleByAccountId.get(m.account.id) : undefined;
          const payee = d.payee ?? d.originalPayee;
          return {
            date: tx.date.toISOString(),
            kind,
            amount: Math.abs(m.sum ?? 0),
            currency: scrape.accounts.find((a) => "id" in m.account && a.id === m.account.id)?.instrument ?? "USD",
            account: own ?? "card",
            // For a transfer: where the money came from — either another of our own
            // accounts (earn → cash) or an existing ZenMoney account (a traced deposit).
            source: isTransfer ? (titleByAccountId.get(sourceIdOf(tx)) ?? acctTitle.get(d.outcomeAccount) ?? "source account") : null,
            payee: isTransfer ? null : payee,
            mcc: d.mcc,
            op: d.opOutcome != null ? `${d.opOutcome.toFixed(2)} op` : null,
            hold: tx.hold === true,
            provider: providerOf(tx),
          };
        });

        const counts: Record<SyncKind, number> = { expense: 0, income: 0, transfer: 0 };
        const totals: Record<SyncKind, number> = { expense: 0, income: 0, transfer: 0 };
        for (const m of mapped) {
          counts[m.kind] += 1;
          totals[m.kind] += m.amount;
        }

        const pushedIds = new Set(toPush.transactions.map((t) => t.id));
        const sentMapped = mapped.filter((_, i) => pushedIds.has(diff.transactions[i]!.id));

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
          sentSample: [...sentMapped].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 25),
          deposits: mapped
            .filter((m) => m.kind === "income" || (m.kind === "transfer" && m.source != null))
            .slice(0, 25)
            .map((m) => ({
              date: m.date,
              amount: m.amount,
              currency: m.currency,
              result: (m.kind === "transfer" ? "transfer" : "income") as "transfer" | "income",
              detail: m.source ? `→ ${m.source}` : "no matching account — kept as income",
              sig: null,
            })),
        };
      } else {
        zenmoneyDetail = { pushed: false, reason: this.config.dryRun ? "dry-run" : "no ZenMoney token" };
      }

      this.lastDetail = { at: new Date().toISOString(), sources, zenmoney: zenmoneyDetail };
      const sentCount = zenmoneyDetail.pushed ? zenmoneyDetail.pushedThisRun.transactions : 0;
      this.state.lastResult = {
        accounts: scrape.accounts.length,
        transactions: scrape.transactions.length,
        sent: sentCount,
        pushed,
      };
      this.state.lastSyncOk = true;
      this.state.lastError = null;
      this.state.syncCount += 1;
      this.log(
        "info",
        `sync ok (${ready.map((p) => p.label).join(" + ")}): ${scrape.transactions.length} tx in window, sent ${sentCount} new/changed`,
      );
    } catch (e) {
      this.state.lastSyncOk = false;
      this.state.lastError = e instanceof Error ? e.message : String(e);
      this.log("error", `sync failed: ${this.state.lastError}`);
    } finally {
      this.running = false;
      this.refreshProviderState();
      this.state.lastSyncAt = new Date().toISOString();
      // A session can die mid-run beyond what a refresh can fix; surface it for re-auth.
      if (this.needsAuth()) this.state.status = "needs-auth";
      else if (this.state.status === "syncing") this.state.status = this.state.lastSyncOk ? "idle" : "error";
    }
  }
}

/** The other leg of a two-movement transfer (earn → cash), if this is one. */
function sourceIdOf(tx: ZenTransaction): string {
  const second = tx.movements[1];
  if (!second) return "";
  const out = (tx.movements[0].sum ?? 0) < 0 ? tx.movements[0] : second;
  return "id" in out.account ? out.account.id : "";
}
