import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SamRecord } from "../sam/client.js";

/** Keys never returned to Claude, whatever the entity. */
const HIDDEN_KEY = /pass(word)?|secret|token|api[-_]?key|hash|salt|otp/i;

export const LIST_MAX_STRING = 300;
export const DETAIL_MAX_STRING = 2000;
export const MAX_OUTPUT_CHARS = 40_000;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [tronqué, ${s.length} caractères]` : s;
}

function sanitizeValue(v: unknown, maxString: number, depth: number): unknown {
  if (typeof v === "string") return truncate(v, maxString);
  if (Array.isArray(v)) {
    if (depth >= 3) return `[${v.length} élément(s)]`;
    const items = v.slice(0, 20).map((x) => sanitizeValue(x, maxString, depth + 1));
    if (v.length > 20) items.push(`… ${v.length - 20} élément(s) de plus`);
    return items;
  }
  if (v && typeof v === "object") {
    if (depth >= 3) return "[objet]";
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!HIDDEN_KEY.test(k)) out[k] = sanitizeValue(val, maxString, depth + 1);
    }
    return out;
  }
  return v;
}

/**
 * Removes sensitive keys, truncates long text and optionally keeps only `fields`
 * (the record id is always kept so Claude can reference the record).
 */
export function sanitizeRecord(rec: SamRecord, maxString: number, fields?: string[]): SamRecord {
  const keep = fields && fields.length > 0 ? new Set([...fields, "id"]) : undefined;
  const out: SamRecord = {};
  for (const [k, v] of Object.entries(rec)) {
    if (HIDDEN_KEY.test(k)) continue;
    if (keep && !keep.has(k)) continue;
    out[k] = sanitizeValue(v, maxString, 1);
  }
  return out;
}

export function jsonResult(payload: Record<string, unknown>): CallToolResult {
  let text = JSON.stringify(payload, null, 2);
  if (text.length > MAX_OUTPUT_CHARS && Array.isArray(payload.items)) {
    const items = [...(payload.items as unknown[])];
    while (items.length > 1 && text.length > MAX_OUTPUT_CHARS) {
      items.pop();
      text = JSON.stringify({ ...payload, items, returned: items.length, truncated: true }, null, 2);
    }
  }
  if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [réponse tronquée]`;
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
