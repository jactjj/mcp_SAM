/**
 * Error raised for any SAM API failure. `message` is safe to show to Claude:
 * it never contains tokens or credentials.
 */
export class SamApiError extends Error {
  override name = "SamApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly code:
      | "auth_failed"
      | "forbidden"
      | "not_found"
      | "bad_request"
      | "conflict"
      | "rate_limited"
      | "server_error"
      | "network_error"
      | "timeout"
      | "invalid_response",
  ) {
    super(message);
  }
}

/** Errors detected before any call to SAM (bad input, unknown field, policy). */
export class ValidationError extends Error {
  override name = "ValidationError";
}

const MAX_DETAIL_CHARS = 300;

/** Extracts a short, human readable message from an API error body. */
export function extractApiMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.slice(0, MAX_DETAIL_CHARS) || undefined;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["error", "message", "msg", "details", "hint"]) {
      const v = b[key];
      if (typeof v === "string" && v.trim()) return v.slice(0, MAX_DETAIL_CHARS);
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).message === "string") {
        return String((v as Record<string, unknown>).message).slice(0, MAX_DETAIL_CHARS);
      }
    }
  }
  return undefined;
}

export function errorFromStatus(status: number, body: unknown): SamApiError {
  const detail = extractApiMessage(body);
  const suffix = detail ? ` (${detail})` : "";
  if (status === 400 || status === 422) return new SamApiError(`Requête refusée par SAM${suffix}`, status, "bad_request");
  if (status === 401) return new SamApiError(`Authentification SAM refusée${suffix}`, status, "auth_failed");
  if (status === 403) {
    return new SamApiError(`Accès refusé par SAM : permission insuffisante ou rôle SAM manquant${suffix}`, status, "forbidden");
  }
  if (status === 404) return new SamApiError(`Élément introuvable dans SAM${suffix}`, status, "not_found");
  if (status === 409) return new SamApiError(`Conflit signalé par SAM${suffix}`, status, "conflict");
  if (status === 429) return new SamApiError(`Trop de requêtes vers SAM, réessayer plus tard${suffix}`, status, "rate_limited");
  return new SamApiError(`Erreur du serveur SAM (HTTP ${status})${suffix}`, status, "server_error");
}
