# jupiter-zenmoney-syncer (Path B)

Reads your **Jupiter Card** (via `jupiter-card-sdk`) and pushes accounts +
transactions into **ZenMoney** through its sync API (`POST /v8/diff`). Use it as
a **one-shot CLI**, an embeddable **library**, or a **long-running service**.

```
Jupiter Card ──(jupiter-card-sdk)──▶ shared converter ──(movements→diff adapter)──▶ ZenMoney /v8/diff
```

## Long-running service

An always-on daemon that syncs on a schedule and exposes a small web UI + HTTP API.
Both `JUP_EMAIL` and `ZEN_TOKEN` are optional at startup — you can connect
Jupiter and ZenMoney entirely from the UI instead.

```bash
# Docker (recommended) — works great in OrbStack
cp .env.example .env      # fill in SOLANA_RPC etc. (all optional; gitignored)
docker compose up -d

# or directly
npm run serve
```

### Recommended setup: OrbStack + a menu-bar tray

The intended deployment on a Mac: run the service as a container in
[OrbStack](https://orbstack.dev) (which relaunches it on login and publishes
`localhost:8080` for you), and drive it from a lightweight **SwiftBar menu-bar
agent** — status icon, last/next sync, and a *Sync now* button, right in the
menu bar. The tray is a pure HTTP client, so it works the same whether the
service runs in Docker or via `npm run serve`. Setup: [`menubar/`](menubar/).

> Uptime note: a syncer only needs to run inside Jupiter's ~7-day session window.
> A container in OrbStack covers that as long as the Mac is on most days; for true
> 24/7, run the same image on an always-on host (Pi / NAS / small VPS).

**Bootstrap in the browser (easiest):** open **http://localhost:8080** and use the
control panel:
1. **Jupiter** → enter your account email → click *Send code* → paste the 6-digit code from your email → *Verify*.
2. **ZenMoney** → paste your API token → *Save token*.

All are persisted (on the `/data` volume). After the first Jupiter code the
session auto-refreshes, so it runs unattended within the ~7-day refresh window as
long as it syncs at least once per window.

**Or bootstrap via the API** (same thing, headless):
```bash
curl -XPOST localhost:8080/auth/send-code -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -XPOST localhost:8080/auth/verify   -H 'content-type: application/json' -d '{"code":"123456"}'
curl -XPOST localhost:8080/auth/zenmoney -H 'content-type: application/json' -d '{"token":"ZEN_API_TOKEN"}'
```

**Endpoints**

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | web control panel (connect Jupiter + ZenMoney) |
| GET | `/health` | liveness |
| GET | `/status` | last sync result, timestamps, per-connection auth state |
| POST | `/sync` | trigger an immediate sync |
| POST | `/auth/send-code` | `{ "email"?: "…" }` set the Jupiter email (if given) and send the login OTP |
| POST | `/auth/verify` | `{ "code": "…" }` complete Jupiter login |
| POST | `/auth/zenmoney` | `{ "token": "…" }` set the ZenMoney API token |

`POST` routes require `Authorization: Bearer $SERVICE_TOKEN` when `SERVICE_TOKEN`
is set (the web UI has an "Admin token" box for it).

**Environment**

| Var | Default | Notes |
|---|---|---|
| `JUP_EMAIL` | — | optional; can be set later via the UI/API |
| `ZEN_TOKEN` | — | required unless `DRY_RUN=1`; can be set later via the UI/API |
| `SYNC_INTERVAL` | `6h` | e.g. `30m`, `1d` |
| `SYNC_YEARS` | current + previous year | e.g. `2025,2026` |
| `SESSION_FILE` | `/data/.jup-session.json` | mount a volume |
| `DRY_RUN` | — | `1` = read+convert, no push |
| `PORT` | `8080` | control server |
| `SERVICE_TOKEN` | — | protects POST routes |
| `SOLANA_RPC` | public mainnet | RPC for deposit-source tracing (see below) |
| `SIG_CACHE_FILE` | `/data/sig-cache.json` | caches resolved signatures |

### As a library
```ts
import { sync, ZenMoneyClient } from "jupiter-zenmoney-syncer";
await sync({ jupiter, zen, year: 2026 });
```

## How it works

1. `jupiter-card-sdk` reads cards, balance, and transactions.
2. `jupiter-card-sdk/zenmoney` converts them to ZenMoney's `movements` format
   (the **shared core**, also used by the ZenPlugins plugin).
3. `src/toDiff.ts` adapts `movements` → the backend diff format (income/outcome
   + integer instrument ids + `yyyy-MM-dd`), with **deterministic UUIDs** so
   re-runs update the same records instead of duplicating.
4. `src/zenClient.ts` resolves the instrument table and pushes the diff.

## Setup

```bash
npm install         # links jupiter-card-sdk from ../jupiter-card-sdk
```

You need two credentials:

- **Jupiter** — your account email (`JUP_EMAIL`). First run asks for the emailed
  OTP; the session is saved to `.jup-session.json` and refreshed automatically.
- **ZenMoney** — an API OAuth token (`ZEN_TOKEN`). Register a consumer and get a
  token per the [ZenMoney API docs](https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API);
  the token is sent as `Authorization: Bearer`.

## Run

```bash
# preview what would be sent (no write to ZenMoney):
JUP_EMAIL=you@example.com ZEN_TOKEN=xxx npx tsx src/cli.ts --dry-run

# sync the current year:
JUP_EMAIL=you@example.com ZEN_TOKEN=xxx npx tsx src/cli.ts

# a specific year:
JUP_EMAIL=you@example.com ZEN_TOKEN=xxx npx tsx src/cli.ts --year 2026
```

Schedule it (e.g. daily) with cron/launchd once the session file exists.

## Programmatic use

```ts
import { JupiterCard } from "jupiter-card-sdk";
import { ZenMoneyClient, sync } from "jupiter-zenmoney-syncer";

const jupiter = new JupiterCard({ auth: { kind: "email", email, sessionFile: ".jup-session.json" } });
const zen = new ZenMoneyClient({ token: process.env.ZEN_TOKEN! });
await sync({ jupiter, zen, year: 2026 });
```

## Status

- ✅ Adapter (`movements`→diff, sign conventions, `op*` currency fields, stable
  ids) is unit-tested (`npm test`).
- ✅ **Live push validated** against `api.zenmoney.ru` end-to-end (real card
  account + transactions accepted). Use `DRY_RUN=1` to preview without pushing.

## Model

Card-only, income/expense: one `ccard` USD account; card purchases → expense
with merchant + MCC (+ original-currency `op*` on conversions); USDC
deposits/withdrawals → income/expense with the on-chain signature in the comment.
**Non-destructive & idempotent.** Every record uses a deterministic UUID (v5), and
`changed` timestamps are the record's own (data-derived), never `now`. Since
ZenMoney resolves conflicts by last-write-wins on `changed`, any edit you make in
the ZenMoney app has a newer timestamp and **always wins** — re-syncs never
overwrite your categories, comments, renames, or splits. The syncer only inserts
records ZenMoney doesn't have yet; the card account is created once (its balance
is set at first insert, not force-refreshed).

## How the account id is decided

ZenMoney identifies every account by a UUID, and the syncer must produce the
**same** id on every run — otherwise each sync would create a new account and
duplicate it. So the id is derived deterministically from stable Jupiter data:

1. **Anchor** — Jupiter's `cardAccountId` (the money account behind your card).
   It's the same on every sync and shared across all your physical/virtual cards,
   so it's the natural "one account" key. Fallbacks if absent: the card's own id,
   then the literal `"jupiter-card"`.
2. **Hash to a UUID** — the anchor is run through a deterministic UUID v5
   (`stableUuid("account:" + anchor)`), because ZenMoney requires UUID-format ids.
   Same input → same UUID, forever.

```
Jupiter cardAccountId  "acct_abc123"
      ↓ deterministic hash (UUID v5)
ZenMoney account id    "35e61a15-…-a84347347674"   ← identical every sync
```

Every transaction is stamped with that same account UUID (via `accountIdFor()` in
`src/convert.ts`), so they all land in the one card account and ZenMoney updates
it in place rather than duplicating. Transaction ids are derived the same way
(`stableUuid("tx:" + jupiterTxId)`).

**Card-only:** all transactions go to this single account; the per-transaction
`cardId` (which physical card) isn't used to pick a different account. If you had
more than one distinct Jupiter account (`cardAccountId`), `accountIdFor()` would
need to key each transaction by its own account.

## Deposits as transfers

A USDC deposit into the card can be recorded as a **transfer** from the wallet
that funded it, instead of plain income — but only when the source can be
identified and matched to one of your ZenMoney accounts:

1. The Jupiter deposit carries an on-chain **signature** (`onchainSignature`).
2. `SolanaResolver` looks the signature up on-chain and reads the **source wallet**
   (the `authority` of the SPL token transfer).
3. That address is matched to an existing **ZenMoney account** — by a `syncID`
   equal to the full address, or (per spec) whose **last 4 characters** match.
4. If matched → the deposit is emitted as a transfer (money **out** of that
   account, **in** to the card). **Otherwise it stays income** — no guessing.

A resolved deposit is inserted under its own id namespace (`transfer:<jupiterId>`)
rather than the plain `tx:<jupiterId>` income id, and the syncer emits a
**deletion** for that old income id. This matters because ZenMoney *permanently
tombstones a deleted transaction id* — once you delete a record in the app, no
push (even with a newer `changed` + `deleted:false`) can resurrect it. Using a
fresh id sidesteps the tombstone, so converting a deposit income→transfer works
whether the old record was left in place (it's deleted and replaced) or you'd
already deleted it by hand (the fresh transfer just inserts).

### To enable it, tag your source accounts
Add the funding wallet's address (or just its **last 4 chars**) to the `syncID`
of the ZenMoney account that represents it (e.g. your "Stablecoins Solana"
account). Until then, deposits resolve but match nothing and remain income.
An ambiguous last-4 (two accounts) is treated as *no match* on purpose.

### Use a full-history RPC
The default public RPC (`api.mainnet-beta.solana.com`) is rate-limited and
**prunes old transactions**, so deposits older than a few days often won't
resolve. For reliable tracing set `SOLANA_RPC` to a full-history provider
(Helius, QuickNode, Triton, …). Successful lookups are cached; unresolved ones
are retried next run.

## ZenMoney diff format notes

The ZenMoney `/v8/diff` API rejects incomplete objects with
`validationError`. These are the non-obvious required fields it needs (learned by
iterating on the real API), all handled in `src/toDiff.ts`:

**Account** — `user` (your ZenMoney user id), `private` (bool), and the
loan/deposit-only fields sent as `null` (`capitalization`, `percent`, `startDate`,
`endDateOffset`, `endDateOffsetInterval`, `payoffStep`, `payoffInterval`), plus
`changed`, `inBalance`, `savings`, `archive`, `enableCorrection`, `enableSMS`.

**Transaction** — `user`, `changed`, `created`, `deleted`, and
`incomeBankID` / `outcomeBankID` (nullable), alongside the
income/outcome/instrument/account fields and `date` (`yyyy-MM-dd`).

The **user id** is fetched from the diff response (`context()` uses
`forceFetch: ["instrument", "user"]` → `user[0].id`), and the **instrument id**
for each currency is resolved from the same response's instrument table.
