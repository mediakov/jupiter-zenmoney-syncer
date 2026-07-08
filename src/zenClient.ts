import type { DiffAccount, DiffTransaction, InstrumentMap } from "./toDiff.js";

const ZEN_DIFF_URL = "https://api.zenmoney.ru/v8/diff/";

interface Instrument {
  id: number;
  shortTitle: string;
}

interface DiffResponse {
  serverTimestamp: number;
  instrument?: Instrument[];
  user?: Array<{ id: number }>;
  [k: string]: unknown;
}

export interface ZenMoneyClientOptions {
  /** ZenMoney OAuth access token (Bearer). */
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Minimal client for the ZenMoney sync API (`POST /v8/diff`).
 * Docs: https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API
 */
export class ZenMoneyClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ZenMoneyClientOptions) {
    this.url = opts.baseUrl ?? ZEN_DIFF_URL;
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  private async diff(body: Record<string, unknown>): Promise<DiffResponse> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ZenMoney diff ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as DiffResponse;
  }

  /**
   * Fetch the instrument table + the account owner's user id (both required to
   * build a valid diff). Returns `{ map, userId, serverTimestamp }`.
   */
  async context(): Promise<{ map: InstrumentMap; userId: number; serverTimestamp: number }> {
    const res = await this.diff({
      currentClientTimestamp: this.now(),
      serverTimestamp: this.now() - 1,
      forceFetch: ["instrument", "user"],
    });
    const byCode = new Map<string, number>();
    for (const i of res.instrument ?? []) byCode.set(i.shortTitle.toUpperCase(), i.id);
    const userId = res.user?.[0]?.id;
    if (userId == null) throw new Error("ZenMoney: could not determine user id (no user in diff response)");
    return {
      map: (code: string) => byCode.get(code.toUpperCase()),
      userId,
      serverTimestamp: res.serverTimestamp,
    };
  }

  /** Push accounts + transactions. Idempotent given stable ids. */
  async push(
    accounts: DiffAccount[],
    transactions: DiffTransaction[],
    serverTimestamp: number,
  ): Promise<DiffResponse> {
    return this.diff({
      currentClientTimestamp: this.now(),
      serverTimestamp,
      account: accounts,
      transaction: transactions,
    });
  }
}
