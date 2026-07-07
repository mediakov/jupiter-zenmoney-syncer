#!/usr/bin/env -S npx tsx
/**
 * CLI: sync Jupiter Card → ZenMoney.
 *
 *   JUP_EMAIL=you@example.com ZEN_TOKEN=xxxxx npx tsx src/cli.ts [--year 2026] [--dry-run]
 *
 * On first run it asks for the Jupiter email OTP; the Jupiter session is saved
 * to .jup-session.json and reused after.
 */
import { createInterface } from "node:readline/promises";
import { JupiterCard } from "jupiter-card-sdk";
import { ZenMoneyClient } from "./zenClient.js";
import { sync } from "./sync.js";

const email = process.env.JUP_EMAIL;
const token = process.env.ZEN_TOKEN;
if (!email) throw new Error("Set JUP_EMAIL to your Jupiter account email.");
if (!token) throw new Error("Set ZEN_TOKEN to your ZenMoney API token (see README).");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const yearArg = args[args.indexOf("--year") + 1];
const year = args.includes("--year") && yearArg ? Number(yearArg) : undefined;

const jupiter = new JupiterCard({ auth: { kind: "email", email, sessionFile: ".jup-session.json" } });

if (!jupiter.isAuthenticated()) {
  await jupiter.login.sendCode();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question(`Enter the code sent to ${email}: `)).trim();
  await rl.close();
  await jupiter.login.verify(code);
  console.log("Jupiter session established.");
}

const zen = new ZenMoneyClient({ token });

console.log(`Syncing Jupiter Card → ZenMoney${dryRun ? " (dry run)" : ""}…`);
const summary = await sync({ jupiter, zen, year, dryRun });
console.log(
  `${summary.pushed ? "Pushed" : "Prepared"} ${summary.transactions} transactions across ${summary.accounts} account(s).`,
);
