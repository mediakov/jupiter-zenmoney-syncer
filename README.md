# jupiter-zenmoney-syncer (Path B)

A standalone Node service that reads your **Jupiter Card** (via `jupiter-card-sdk`)
and pushes accounts + transactions into **ZenMoney** through its sync API
(`POST /v8/diff`). Runs anywhere — a laptop, a cron, a small server.

```
Jupiter Card ──(jupiter-card-sdk)──▶ shared converter ──(movements→diff adapter)──▶ ZenMoney /v8/diff
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
- ⏳ Live push requires your real `ZEN_TOKEN` + Jupiter OTP — not exercised in CI.
  Use `--dry-run` first to inspect the payload.

## Model

Card-only, income/expense: one `ccard` USD account; card purchases → expense
with merchant + MCC (+ original-currency `op*` on conversions); USDC
deposits/withdrawals → income/expense with the on-chain signature in the comment.
