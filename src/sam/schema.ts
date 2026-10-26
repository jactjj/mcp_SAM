import type { Logger } from "../logger.js";
import type { SamClient } from "./client.js";
import { isRecord } from "./client.js";
import { type SamEntity, FIELD_NAME_PATTERN, SAM_ENTITIES } from "./entities.js";
import { ValidationError } from "./errors.js";

/**
 * Field description as reported by `GET /crm-api/schema`.
 * The exact response format of that endpoint is not documented, so the parser below
 * accepts several common shapes and keeps only what it actually finds: it never adds fields.
 */
export interface FieldInfo {
  name: string;
  type?: string | undefined;
  required?: boolean | undefined;
  readOnly?: boolean | undefined;
  enumValues?: string[] | undefined;
  description?: string | undefined;
}

export interface EntitySchema {
  entity: SamEntity;
  fields: Map<string, FieldInfo>;
  /**
   * declared = described by /crm-api/schema ;
   * observed = learned from the keys of real records (the live API only lists entity names).
   */
  source: "declared" | "observed";
  /** Number of records the observed fields come from. */
  sampleSize?: number;
}

export type NormalizedSchema = Map<SamEntity, EntitySchema>;

/**
 * Fields managed by SAM; never accepted in create/update payloads.
 * deleted_at / deleted_by are SAM's soft delete: writing them would be a deletion.
 */
export const SERVER_MANAGED_FIELDS = new Set(["id", "created_at", "updated_at", "deleted_at", "deleted_by"]);

/** Records sampled to learn the fields of an entity when /crm-api/schema does not describe them. */
export const OBSERVED_SAMPLE_SIZE = 25;

function valueType(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object") return "json";
  return "string";
}

/** Builds the field list from real records: union of their keys, type = the non-null type seen. */
export function inferFields(records: Record<string, unknown>[]): Map<string, FieldInfo> {
  const types = new Map<string, Set<string>>();
  for (const r of records) {
    for (const [k, v] of Object.entries(r)) {
      if (!FIELD_NAME_PATTERN.test(k)) continue;
      if (!types.has(k)) types.set(k, new Set());
      const t = valueType(v);
      if (t) types.get(k)?.add(t);
    }
  }
  const out = new Map<string, FieldInfo>();
  for (const [name, set] of types) {
    // Mixed or unknown (always null) types are left unchecked.
    out.set(name, { name, type: set.size === 1 ? [...set][0] : undefined, readOnly: SERVER_MANAGED_FIELDS.has(name) || undefined });
  }
  return out;
}

const NAME_KEYS = ["name", "column_name", "field", "key", "column"];
const TYPE_KEYS = ["type", "data_type", "format", "udt_name"];
const ENUM_KEYS = ["enum", "values", "options", "allowed_values"];
const FIELD_CONTAINER_KEYS = ["fields", "columns", "properties", "attributes"];

const normKey = (k: string) => k.trim().toLowerCase().replace(/_/g, "-");

function matchEntity(key: string): SamEntity | undefined {
  const k = normKey(key);
  return SAM_ENTITIES.find((e) => e === k);
}

function parseFieldObject(name: string | undefined, raw: unknown): FieldInfo | undefined {
  if (typeof raw === "string") {
    if (name && FIELD_NAME_PATTERN.test(name)) return { name, type: raw };
    if (!name && FIELD_NAME_PATTERN.test(raw)) return { name: raw };
    return undefined;
  }
  if (!isRecord(raw)) return name && FIELD_NAME_PATTERN.test(name) ? { name } : undefined;
  const fieldName = name ?? NAME_KEYS.map((k) => raw[k]).find((v): v is string => typeof v === "string");
  if (!fieldName || !FIELD_NAME_PATTERN.test(fieldName)) return undefined;
  const type = TYPE_KEYS.map((k) => raw[k]).find((v): v is string => typeof v === "string");
  const enumRaw = ENUM_KEYS.map((k) => raw[k]).find((v): v is unknown[] => Array.isArray(v));
  const enumValues = enumRaw?.filter((v): v is string => typeof v === "string");
  const required =
    typeof raw.required === "boolean"
      ? raw.required
      : typeof raw.is_required === "boolean"
        ? raw.is_required
        : undefined;
  const readOnlyRaw = raw.read_only ?? raw.readOnly ?? raw.readonly ?? raw.generated ?? raw.is_generated;
  return {
    name: fieldName,
    type,
    required,
    readOnly: typeof readOnlyRaw === "boolean" ? readOnlyRaw : undefined,
    enumValues: enumValues && enumValues.length > 0 ? enumValues : undefined,
    description: typeof raw.description === "string" ? raw.description.slice(0, 200) : undefined,
  };
}

function parseFields(raw: unknown): Map<string, FieldInfo> {
  const out = new Map<string, FieldInfo>();
  const add = (f: FieldInfo | undefined) => {
    if (f) out.set(f.name, f);
  };
  let container: unknown = raw;
  if (isRecord(raw)) {
    const key = FIELD_CONTAINER_KEYS.find((k) => raw[k] !== undefined);
    if (key) container = raw[key];
  }
  if (Array.isArray(container)) {
    for (const item of container) add(parseFieldObject(undefined, item));
  } else if (isRecord(container)) {
    for (const [k, v] of Object.entries(container)) add(parseFieldObject(k, v));
  }
  return out;
}

/** Converts the raw `/crm-api/schema` payload into known entities and fields. */
export function normalizeSchema(raw: unknown): NormalizedSchema {
  const result: NormalizedSchema = new Map();
  let root: unknown = raw;
  for (let i = 0; i < 2 && isRecord(root); i++) {
    const wrapper = ["entities", "schema", "data", "tables"].find((k) => root && isRecord(root) && root[k] !== undefined);
    if (!wrapper) break;
    root = (root as Record<string, unknown>)[wrapper];
  }

  const addEntity = (key: string, value: unknown) => {
    const entity = matchEntity(key);
    if (!entity) return;
    const fields = parseFields(value);
    if (fields.size > 0) result.set(entity, { entity, fields, source: "declared" });
  };

  if (Array.isArray(root)) {
    for (const item of root) {
      if (!isRecord(item)) continue;
      const key = ["entity", "endpoint", "name", "table", "table_name"]
        .map((k) => item[k])
        .find((v): v is string => typeof v === "string" && matchEntity(v) !== undefined);
      if (key) addEntity(key, item);
    }
  } else if (isRecord(root)) {
    for (const [k, v] of Object.entries(root)) addEntity(k, v);
  }
  return result;
}

export type FieldValue = string | number | boolean | null | (string | number)[];

function typeMatches(type: string | undefined, value: FieldValue): boolean {
  if (value === null || !type) return true;
  const t = type.toLowerCase();
  if (/(int|numeric|decimal|float|double|real|number|money)/.test(t)) {
    return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)));
  }
  if (/bool/.test(t)) return typeof value === "boolean";
  if (/(\[\]|array|^_)/.test(t)) return Array.isArray(value);
  return !Array.isArray(value) || /json/.test(t);
}

interface CacheEntry {
  schema: NormalizedSchema;
  raw: unknown;
  fetchedAt: number;
}

/**
 * Caches the live SAM schema and validates tool inputs against it.
 * Writes are refused when the schema cannot be read, so no unknown field is ever sent.
 */
export class SchemaRegistry {
  private cache: CacheEntry | undefined;
  private inflight: Promise<CacheEntry> | undefined;
  private readonly observed = new Map<SamEntity, { es: EntitySchema | undefined; fetchedAt: number }>();
  private readonly observing = new Map<SamEntity, Promise<EntitySchema | undefined>>();

  constructor(
    private readonly client: SamClient,
    private readonly logger: Logger,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async load(force = false): Promise<CacheEntry> {
    if (!force && this.cache && this.now() - this.cache.fetchedAt < this.ttlMs) return this.cache;
    if (!this.inflight) {
      this.inflight = this.client
        .schema()
        .then((raw) => {
          const schema = normalizeSchema(raw);
          if (schema.size === 0) this.logger.warn("sam.schema.unrecognized_format");
          this.cache = { schema, raw, fetchedAt: this.now() };
          return this.cache;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  /**
   * Fields of an entity: from /crm-api/schema when it describes them, otherwise learned
   * from up to OBSERVED_SAMPLE_SIZE real records (read-only GET). An entity with no record,
   * or whose list endpoint fails, has no known fields: writes to it are refused.
   */
  async entity(entity: SamEntity): Promise<EntitySchema | undefined> {
    const declared = (await this.load()).schema.get(entity);
    if (declared) return declared;
    const cached = this.observed.get(entity);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached.es;
    let p = this.observing.get(entity);
    if (!p) {
      p = this.client
        .list(entity, { limit: OBSERVED_SAMPLE_SIZE, offset: 0 })
        .then(({ items }) => {
          const fields = inferFields(items);
          const es: EntitySchema | undefined =
            fields.size > 0 ? { entity, fields, source: "observed", sampleSize: items.length } : undefined;
          this.observed.set(entity, { es, fetchedAt: this.now() });
          return es;
        })
        .catch((err: unknown) => {
          this.logger.warn("sam.schema.observe_failed", { entity, error: err });
          return undefined;
        })
        .finally(() => this.observing.delete(entity));
      this.observing.set(entity, p);
    }
    return p;
  }

  /**
   * Checks a create/update payload: known fields only, not server-managed, plausible types.
   * Returns false when the entity has no known field (SAM does not describe it and no record
   * is readable): the write is then allowed, and SAM itself validates the column names.
   */
  async validateWrite(entity: SamEntity, data: Record<string, FieldValue>, mode: "create" | "update"): Promise<boolean> {
    const keys = Object.keys(data);
    if (keys.length === 0) throw new ValidationError("Aucun champ fourni");
    for (const k of keys) {
      if (SERVER_MANAGED_FIELDS.has(k)) throw new ValidationError(`Le champ "${k}" est géré par SAM et ne peut pas être modifié`);
    }
    const es = await this.entity(entity);
    if (!es) return false;
    const unknown = keys.filter((k) => !es.fields.has(k));
    if (unknown.length > 0) {
      throw new ValidationError(
        `Champ(s) inconnu(s) pour ${entity} : ${unknown.join(", ")}. Champs disponibles : ${[...es.fields.keys()].join(", ")}`,
      );
    }
    for (const k of keys) {
      const f = es.fields.get(k);
      if (!f) continue;
      if (SERVER_MANAGED_FIELDS.has(k) || f.readOnly) throw new ValidationError(`Le champ "${k}" est géré par SAM et ne peut pas être modifié`);
      const v = data[k] as FieldValue;
      if (!typeMatches(f.type, v)) throw new ValidationError(`Valeur incompatible pour "${k}" (type attendu : ${f.type})`);
      if (f.enumValues && typeof v === "string" && !f.enumValues.includes(v)) {
        throw new ValidationError(`Valeur non autorisée pour "${k}". Valeurs possibles : ${f.enumValues.join(", ")}`);
      }
    }
    if (mode === "create") {
      const missing = [...es.fields.values()]
        .filter((f) => f.required === true && !f.readOnly && !SERVER_MANAGED_FIELDS.has(f.name) && !(f.name in data))
        .map((f) => f.name);
      if (missing.length > 0) throw new ValidationError(`Champ(s) obligatoire(s) manquant(s) pour ${entity} : ${missing.join(", ")}`);
    }
    return true;
  }

  /** Filter and projection fields must exist when the schema of the entity is known. */
  async validateReadFields(entity: SamEntity, fields: string[]): Promise<void> {
    if (fields.length === 0) return;
    let es: EntitySchema | undefined;
    try {
      es = await this.entity(entity);
    } catch {
      return; // reads stay possible if the schema endpoint is down; SAM validates the query itself
    }
    if (!es) return;
    const unknown = fields.filter((f) => !es.fields.has(f));
    if (unknown.length > 0) {
      throw new ValidationError(
        `Champ(s) inconnu(s) pour ${entity} : ${unknown.join(", ")}. Champs disponibles : ${[...es.fields.keys()].join(", ")}`,
      );
    }
  }

  /** Returns `field` if the live schema of `entity` contains it (used for client_id / lead_id links). */
  async hasField(entity: SamEntity, field: string): Promise<boolean> {
    const es = await this.entity(entity);
    return es?.fields.has(field) ?? false;
  }
}
