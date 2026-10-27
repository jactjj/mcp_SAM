import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/**
 * What a signed token is for. Each purpose uses its own key derived from MCP_AUTH_SECRET,
 * so a token issued for one purpose (e.g. an OAuth client id) can never be replayed as
 * another (e.g. an access token).
 */
export type TokenPurpose = "client" | "authreq" | "code" | "access" | "refresh" | "confirm" | "upload";

const encoder = new TextEncoder();

/**
 * Stateless signed tokens (JWT HS256). Nothing is stored server side, which keeps the
 * Worker free of databases; rotating MCP_AUTH_SECRET revokes every token at once.
 */
export class TokenSigner {
  private readonly keys = new Map<TokenPurpose, Promise<Uint8Array<ArrayBuffer>>>();

  constructor(
    private readonly secret: string,
    private readonly issuer = "sam-mcp",
  ) {}

  private key(purpose: TokenPurpose): Promise<Uint8Array<ArrayBuffer>> {
    let k = this.keys.get(purpose);
    if (!k) {
      k = (async () => {
        const base = await crypto.subtle.importKey("raw", encoder.encode(this.secret), { name: "HMAC", hash: "SHA-256" }, false, [
          "sign",
        ]);
        const derived = await crypto.subtle.sign("HMAC", base, encoder.encode(`sam-mcp:${purpose}:v1`));
        return new Uint8Array(derived);
      })();
      this.keys.set(purpose, k);
    }
    return k;
  }

  /** Deterministic MAC of `data` (used to derive OAuth client secrets without storing them). */
  async mac(purpose: TokenPurpose, data: string): Promise<string> {
    const raw = await this.key(purpose);
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`mac:${data}`))));
  }

  async sign(purpose: TokenPurpose, claims: JWTPayload, ttlSeconds?: number): Promise<string> {
    const jwt = new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "HS256", typ: purpose })
      .setIssuer(this.issuer)
      .setAudience(purpose)
      .setIssuedAt()
      .setJti(crypto.randomUUID());
    if (ttlSeconds !== undefined) jwt.setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds);
    return jwt.sign(await this.key(purpose));
  }

  /** Returns the payload, or undefined if the token is invalid, expired or for another purpose. */
  async verify<T extends object = JWTPayload>(purpose: TokenPurpose, token: string): Promise<(JWTPayload & T) | undefined> {
    if (!token || token.length > 8192) return undefined;
    try {
      const { payload } = await jwtVerify(token, await this.key(purpose), {
        issuer: this.issuer,
        audience: purpose,
        algorithms: ["HS256"],
      });
      return payload as JWTPayload & T;
    } catch {
      return undefined;
    }
  }
}

/** Constant-time string comparison (via HMAC digests, so lengths do not leak either). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return base64Url(new Uint8Array(digest));
}

export function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** JSON with sorted keys, so that equal objects always produce the same digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Best-effort single-use registry for short-lived token ids (authorization codes,
 * confirmation tokens). It lives in memory, so it protects within one instance; the
 * short token lifetimes bound the remaining replay window across instances.
 */
export class UsedTokenRegistry {
  private readonly used = new Map<string, number>();
  constructor(private readonly max = 5000) {}

  /** Returns false if the id was already consumed. */
  consume(jti: string, expiresAtSec: number): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.used.size > this.max) {
      for (const [k, exp] of this.used) if (exp < nowSec) this.used.delete(k);
    }
    if (this.used.has(jti)) return false;
    this.used.set(jti, expiresAtSec);
    return true;
  }
}
