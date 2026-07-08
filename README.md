# jupiter-zenmoney-syncer (Path B)

Reads your **Jupiter Card** (via `jupiter-card-sdk`) and pushes accounts +
transactions into **ZenMoney** through its sync API (`POST /v8/diff`). Use it as
a **one-shot CLI**, an embeddable **library**, or a **long-running service**.

```
Jupiter Card ──(jupiter-card-sdk)──▶ shared converter ──(movements→diff adapter)──▶ ZenMoney /v8/diff
```

## Long-running service

An always-on daemon that syncs on a schedule and exposes a small web UI + HTTP API.
`ZEN_TOKEN` is optional at startup — you can connect ZenMoney from the UI instead.

```bash
# Docker (recommended)
JUP_EMAIL=you@example.com docker compose up -d

# or directly
JUP_EMAIL=you@example.com npm run serve
```

**Bootstrap in the browser (easiest):** open **http://localhost:8080** and use the
control panel:
1. **Jupiter** → click *Send login code* → paste the 6-digit code from your email → *Verify*.
2. **ZenMoney** → paste your API token → *Save token*.

Both are persisted (on the `/data` volume). After the first Jupiter code the
session auto-refreshes, so it runs unattended within the ~7-day refresh window as
long as it syncs at least once per window.

**Or bootstrap via the API** (same thing, headless):
```bash
curl -XPOST localhost:8080/auth/send-code
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
| POST | `/auth/send-code` | send the Jupiter login OTP |
| POST | `/auth/verify` | `{ "code": "…" }` complete Jupiter login |
| POST | `/auth/zenmoney` | `{ "token": "…" }` set the ZenMoney API token |

`POST` routes require `Authorization: Bearer $SERVICE_TOKEN` when `SERVICE_TOKEN`
is set (the web UI has an "Admin token" box for it).

**Environment**

| Var | Default | Notes |
|---|---|---|
| `JUP_EMAIL` | — | required |
| `ZEN_TOKEN` | — | required unless `DRY_RUN=1` |
| `SYNC_INTERVAL` | `6h` | e.g. `30m`, `1d` |
| `SYNC_YEARS` | current + previous year | e.g. `2025,2026` |
| `SESSION_FILE` | `/data/.jup-session.json` | mount a volume |
| `DRY_RUN` | — | `1` = read+convert, no push |
| `PORT` | `8080` | control server |
| `SERVICE_TOKEN` | — | protects POST routes |

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
Re-syncs are idempotent — every record uses a deterministic UUID (v5), so running
again updates rather than duplicates.

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
