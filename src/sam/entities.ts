/**
 * Entities exposed by the SAM REST API (`/crm-api/{entity}`), as documented.
 * The list is closed: tools can only reach these endpoints.
 */
export const SAM_ENTITIES = [
  "clients",
  "leads",
  "distributeurs",
  "commerciaux",
  "taches",
  "rdv",
  "products",
  "documents",
  "client-products",
  "client-comments",
  "lead-comments",
  "notifications",
] as const;

export type SamEntity = (typeof SAM_ENTITIES)[number];

export function isSamEntity(value: string): value is SamEntity {
  return (SAM_ENTITIES as readonly string[]).includes(value);
}

/** Filter operators supported by the API (`champ=op.valeur`). */
export const FILTER_OPERATORS = ["eq", "not", "gte", "lte", "like", "null"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface Filter {
  field: string;
  op: FilterOperator;
  value?: string | number | boolean | undefined;
}

/** Query parameters reserved by the API; they cannot be used as filter field names. */
export const RESERVED_QUERY_PARAMS = new Set(["limit", "offset", "search", "order", "select"]);

export const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
