import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderId } from "./providers.js";

/**
 * Persists UI-provided settings (the ZenMoney token, each card's email, and whether a card
 * is enabled) so they survive restarts — the same idea as the session files. Treat the file
 * like a secret; it's created 0600 and belongs on the mounted /data volume.
 */
export interface StoredCredentials {
  zenToken?: string;
  jupiterEmail?: string;
  plasmaEmail?: string;
  /**
   * Per-card on/off, set from the UI. Absent means "not chosen from the UI" — the service
   * then falls back to the SYNC_PROVIDERS default. Once toggled, this value is authoritative
   * and survives restarts, which is the whole point of a UI switch.
   */
  providerEnabled?: Partial<Record<ProviderId, boolean>>;
}

export class CredentialStore {
  private data: StoredCredentials = {};

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        this.data = {};
      }
    }
  }

  get zenToken(): string | undefined {
    return this.data.zenToken;
  }

  setZenToken(token: string): void {
    this.data.zenToken = token;
    this.flush();
  }

  get jupiterEmail(): string | undefined {
    return this.data.jupiterEmail;
  }

  get plasmaEmail(): string | undefined {
    return this.data.plasmaEmail;
  }

  setPlasmaEmail(email: string): void {
    this.data.plasmaEmail = email;
    this.flush();
  }

  setJupiterEmail(email: string): void {
    this.data.jupiterEmail = email;
    this.flush();
  }

  /** UI on/off for a card, or undefined when the UI has never set it. */
  providerEnabled(id: ProviderId): boolean | undefined {
    return this.data.providerEnabled?.[id];
  }

  setProviderEnabled(id: ProviderId, enabled: boolean): void {
    this.data.providerEnabled = { ...this.data.providerEnabled, [id]: enabled };
    this.flush();
  }

  private flush(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }
}
