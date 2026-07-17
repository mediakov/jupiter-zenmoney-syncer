/** Service configuration, parsed from environment variables. */
export interface ServiceConfig {
  /** Jupiter account email. Optional — can be provided later via the web UI/API. */
  jupiterEmail: string | null;
  /** Plasma One account email. Optional; omit to run Jupiter-only. */
  plasmaEmail: string | null;
  /** ZenMoney API token. Optional in dry-run mode (no push). */
  zenToken: string | null;
  /** Path to persist the Jupiter session (mount a volume in Docker). */
  sessionFile: string;
  /** Path to persist the Plasma session. Separate file: separate login, separate tokens. */
  plasmaSessionFile: string;
  /** Path to persist UI-provided credentials (ZenMoney token). */
  credFile: string;
  /** How often to sync, in ms. */
  intervalMs: number;
  /** Which years to sync each run (e.g. current + previous to catch late posts). */
  years: number[];
  /** Don't push to ZenMoney — read + convert only (preview). */
  dryRun: boolean;
  /** HTTP port for the control/status server. */
  port: number;
  /** Optional bearer token protecting mutating endpoints (POST /sync, /auth/*). */
  serviceToken: string | null;
  /** Solana RPC used to trace deposit sources for transfer detection. */
  solanaRpc: string;
  /** Cache file for resolved signature → source-address lookups. */
  sigCacheFile: string;
  /** Ledger of already-pushed records, so re-syncs only send new/changed ones. */
  pushLedgerFile: string;
}

/** Parse a duration like "6h", "30m", "90s", or a plain number of ms. */
export function parseDuration(v: string | undefined, fallbackMs: number): number {
  if (!v) return fallbackMs;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(v.trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  switch (m[2]) {
    case "d": return n * 86_400_000;
    case "h": return n * 3_600_000;
    case "m": return n * 60_000;
    case "s": return n * 1_000;
    default: return n; // ms or unitless
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  // Use `||` (not `??`) throughout so an *empty-string* env var — e.g. Docker
  // Compose's `${JUP_EMAIL:-}` when unset — is treated as absent, not as a real
  // value that would override the persisted credentials file.

  // Both emails are optional: either can be provided later via the web UI / API, and
  // running one card without the other is a supported configuration.
  const jupiterEmail = env.JUP_EMAIL || null;
  const plasmaEmail = env.PLASMA_EMAIL || null;

  const dryRun = env.DRY_RUN === "1" || env.DRY_RUN === "true";
  // ZEN_TOKEN is optional: it can be provided later via the web UI / API.
  // Until a token is available (env or UI), syncs read+convert but don't push.
  const zenToken = env.ZEN_TOKEN || null;

  const now = new Date().getUTCFullYear();
  // default to current + previous year so late-posting transactions near a
  // year boundary aren't missed.
  const years = env.SYNC_YEARS
    ? env.SYNC_YEARS.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
    : [now - 1, now];

  return {
    jupiterEmail,
    plasmaEmail,
    zenToken,
    sessionFile: env.SESSION_FILE || "/data/.jup-session.json",
    plasmaSessionFile: env.PLASMA_SESSION_FILE || "/data/.plasma-session.json",
    credFile: env.CRED_FILE || "/data/credentials.json",
    intervalMs: parseDuration(env.SYNC_INTERVAL, 6 * 3_600_000),
    years: years.length ? years : [now - 1, now],
    dryRun,
    port: Number(env.PORT || 8080),
    serviceToken: env.SERVICE_TOKEN || null,
    solanaRpc: env.SOLANA_RPC || "https://api.mainnet-beta.solana.com",
    sigCacheFile: env.SIG_CACHE_FILE || "/data/sig-cache.json",
    pushLedgerFile: env.PUSH_LEDGER_FILE || "/data/push-ledger.json",
  };
}
