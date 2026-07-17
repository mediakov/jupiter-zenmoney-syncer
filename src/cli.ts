#!/usr/bin/env -S npx tsx
/**
 * CLI: sync your cards → ZenMoney.
 *
 *   JUP_EMAIL=you@example.com ZEN_TOKEN=xxxxx npx tsx src/cli.ts [--year 2026] [--dry-run]
 *   PLASMA_EMAIL=you@example.com ZEN_TOKEN=xxxxx npx tsx src/cli.ts
 *
 * Set either or both: whichever cards are configured get synced, together, into the
 * same ZenMoney ledger as separate accounts.
 *
 * On first run each card asks for its emailed OTP; the sessions are saved to
 * .jup-session.json / .plasma-session.json and reused after (both refresh themselves).
 */
import { createInterface } from "node:readline/promises";
import { JupiterCard } from "jupiter-card-sdk";
import { PlasmaCard } from "plasma-card-sdk";
import { ZenMoneyClient } from "./zenClient.js";
import { sync } from "./sync.js";

const jupEmail = process.env.JUP_EMAIL;
const plasmaEmail = process.env.PLASMA_EMAIL;
const token = process.env.ZEN_TOKEN;
if (!jupEmail && !plasmaEmail) throw new Error("Set JUP_EMAIL and/or PLASMA_EMAIL to your account email(s).");
if (!token) throw new Error("Set ZEN_TOKEN to your ZenMoney API token (see README).");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const yearArg = args[args.indexOf("--year") + 1];
const year = args.includes("--year") && yearArg ? Number(yearArg) : undefined;

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(prompt)).trim();
  await rl.close();
  return answer;
}

let jupiter: JupiterCard | undefined;
if (jupEmail) {
  jupiter = new JupiterCard({ auth: { kind: "email", email: jupEmail, sessionFile: ".jup-session.json" } });
  if (!jupiter.isAuthenticated()) {
    await jupiter.login.sendCode();
    await jupiter.login.verify(await ask(`Enter the Jupiter code sent to ${jupEmail}: `));
    console.log("Jupiter session established.");
  }
}

let plasma: PlasmaCard | undefined;
if (plasmaEmail) {
  plasma = new PlasmaCard({ auth: { kind: "email", email: plasmaEmail, sessionFile: ".plasma-session.json" } });
  if (!plasma.isAuthenticated()) {
    await plasma.login.sendCode();
    await plasma.login.verify(await ask(`Enter the Plasma code sent to ${plasmaEmail}: `));
    console.log("Plasma session established.");
  }
}

const zen = new ZenMoneyClient({ token });

const which = [jupiter && "Jupiter", plasma && "Plasma"].filter(Boolean).join(" + ");
console.log(`Syncing ${which} → ZenMoney${dryRun ? " (dry run)" : ""}…`);
const summary = await sync({ jupiter, plasma, zen, year, dryRun });
console.log(
  `${summary.pushed ? "Pushed" : "Prepared"} ${summary.transactions} transactions across ${summary.accounts} account(s).`,
);

// Never let a skipped record vanish quietly: a decline is expected, an unreadable row
// is a bug worth seeing.
if (summary.skipped.length) {
  console.log(`\n${summary.skipped.length} record(s) not booked:`);
  for (const s of summary.skipped) console.log(`  ${s.id}: ${s.reason}`);
}
