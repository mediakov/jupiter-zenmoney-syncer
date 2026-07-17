import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Persists UI-provided credentials (the ZenMoney API token and the Jupiter
 * account email) so they survive restarts — the same idea as the Jupiter session
 * file. Treat the file like a secret; it's created 0600 and belongs on the
 * mounted /data volume.
 */
export interface StoredCredentials {
  zenToken?: string;
  jupiterEmail?: string;
  plasmaEmail?: string;
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

  private flush(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }
}
