import type { AccountConfig } from "../config.js";

/**
 * Maps an authenticated MCP principal (the account id carried by the MCP access token)
 * to the SAM account used for API calls. Each account gets its own JWT, cache and
 * permissions on the SAM side.
 */
export interface SamCredentials {
  /** Stable identifier of the SAM account (never the password). */
  accountId: string;
  label: string;
  email: string;
  password: string;
}

export interface CredentialsProvider {
  getCredentials(principal: string): Promise<SamCredentials>;
}

export class UnknownAccountError extends Error {
  override name = "UnknownAccountError";
}

/** Accounts declared in the environment (SAM_ACCOUNT_<N>_*). */
export class EnvCredentialsProvider implements CredentialsProvider {
  private readonly byId: Map<string, SamCredentials>;

  constructor(accounts: Pick<AccountConfig, "id" | "label" | "email" | "password">[]) {
    this.byId = new Map(
      accounts.map((a) => [a.id, { accountId: a.id, label: a.label, email: a.email ?? "", password: a.password ?? "" }]),
    );
  }

  async getCredentials(principal: string): Promise<SamCredentials> {
    const c = this.byId.get(principal);
    if (!c) throw new UnknownAccountError("Compte inconnu");
    return c;
  }
}
