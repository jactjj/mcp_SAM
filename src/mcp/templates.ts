/**
 * SAM email templates, rendered exactly like SAM's web app does (logic read in its code on 2026-10-27):
 * - variables `{{entity.field}}` taken from a context {client, lead, distributeur, commercial, sam, system};
 * - a missing or empty value leaves the variable untouched and is reported;
 * - plain-text bodies get <br> for line breaks; the signature is appended after two line breaks;
 * - default_cc / default_bcc of the template; target "client_et_distributeur" adds the distributor in copy.
 */
import type { SamClient } from "../sam/client.js";
import type { SamDirect } from "../sam/direct.js";

export const TEMPLATE_ENTITY_TYPES = ["client", "lead", "distributeur", "commercial"] as const;
export type TemplateEntityType = (typeof TEMPLATE_ENTITY_TYPES)[number];

type Rec = Record<string, unknown>;
export type TemplateContext = Partial<Record<"client" | "lead" | "distributeur" | "commercial" | "sam" | "system", Rec>>;

const ENTITY_OF: Record<TemplateEntityType, "clients" | "leads" | "distributeurs" | "commerciaux"> = {
  client: "clients",
  lead: "leads",
  distributeur: "distributeurs",
  commercial: "commerciaux",
};

export function render(template: string, ctx: TemplateContext): { result: string; missing: string[] } {
  const missing: string[] = [];
  const result = template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (whole, group: string, field: string) => {
    const scope = ctx[group as keyof TemplateContext];
    const value = scope?.[field];
    if (value === undefined || value === null || value === "") {
      missing.push(whole);
      return whole;
    }
    return String(value);
  });
  return { result, missing };
}

const isHtml = (s: string) => /<\/?[a-z][\s\S]*>/i.test(s);
const toHtml = (s: string) => (isHtml(s) ? s : s.replace(/\n/g, "<br>"));

function parisNow(): Rec {
  const now = new Date();
  const tz = { timeZone: "Europe/Paris" } as const;
  return {
    date: now.toLocaleDateString("fr-FR", tz),
    date_longue: now.toLocaleDateString("fr-FR", { ...tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    heure: now.toLocaleTimeString("fr-FR", { ...tz, hour: "2-digit", minute: "2-digit" }),
  };
}

async function optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** Builds the same variable context as the web app for one record. */
export async function buildContext(client: SamClient, direct: SamDirect, entityType: TemplateEntityType, id: string): Promise<TemplateContext> {
  const ctx: TemplateContext = { system: parisNow() };
  const record = await client.get(ENTITY_OF[entityType], id);
  const ref = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  const commercialId = ref("commercial_id");
  const distributeurId = ref("distributeur_id");
  const [commercial, distributeur] = await Promise.all([
    commercialId && entityType !== "commercial" ? optional(() => client.get("commerciaux", commercialId)) : undefined,
    distributeurId && entityType !== "distributeur" ? optional(() => client.get("distributeurs", distributeurId)) : undefined,
  ]);
  if (entityType === "client") Object.assign(ctx, { client: record, distributeur, commercial });
  if (entityType === "distributeur") ctx.distributeur = record;
  if (entityType === "commercial") Object.assign(ctx, { commercial: record, distributeur });
  if (entityType === "lead") {
    const pick = ["nom", "prenom", "societe", "email", "telephone", "siret", "adresse", "code_postal", "ville"];
    Object.assign(ctx, { lead: record, commercial, client: Object.fromEntries(pick.map((k) => [k, record[k]])) });
  }
  const info = (await optional(() => direct.select("sam_contact_info", new URLSearchParams({ select: "*", limit: "1" }))))?.[0];
  if (info) {
    const team = Array.isArray(info.team_members) ? (info.team_members as Rec[]) : [];
    const member = (n: string) => team.find((m) => typeof m.name === "string" && m.name.toLowerCase().includes(n));
    const arno = member("arno");
    const lenny = member("lenny");
    ctx.sam = {
      company_name: info.company_name,
      arno_nom: arno?.name ?? "Arno",
      arno_email: arno?.email ?? "",
      arno_telephone: arno?.phone ?? "",
      lenny_nom: lenny?.name ?? "Lenny",
      lenny_email: lenny?.email ?? "",
      lenny_telephone: lenny?.phone ?? "",
    };
  }
  return ctx;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  to: string[];
  cc: string[];
  bcc: string[];
  missing: string[];
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.includes("@")) : []);
const emailOf = (r: Rec | undefined): string | undefined => (r && typeof r.email === "string" && r.email.includes("@") ? r.email : undefined);

/** Renders a template row (email_templates) for a context, with the web app's default recipients. */
export function renderTemplate(
  tpl: Rec,
  ctx: TemplateContext,
  entityType: TemplateEntityType,
  opts: { to?: string[]; cc?: string[]; bcc?: string[]; ccCommercial?: boolean },
): RenderedEmail {
  const subject = render(String(tpl.subject_template ?? ""), ctx);
  const body = render(String(tpl.body_template ?? ""), ctx);
  let html = toHtml(body.result);
  const missing = [...subject.missing, ...body.missing];
  if (typeof tpl.signature === "string" && tpl.signature) {
    const sig = render(tpl.signature, ctx);
    html += `<br><br>${toHtml(sig.result)}`;
    missing.push(...sig.missing);
  }
  const own: Record<TemplateEntityType, Rec | undefined> = { client: ctx.client, lead: ctx.lead, distributeur: ctx.distributeur, commercial: ctx.commercial };
  const defaultTo = emailOf(own[entityType]);
  const to = opts.to?.length ? opts.to : defaultTo ? [defaultTo] : [];
  const cc = [...asList(tpl.default_cc)];
  const distributorEmail = emailOf(ctx.distributeur);
  if (tpl.target_type === "client_et_distributeur" && distributorEmail) cc.push(distributorEmail);
  const commercialEmail = emailOf(ctx.commercial);
  if (opts.ccCommercial && commercialEmail) cc.push(commercialEmail);
  cc.push(...(opts.cc ?? []));
  const bcc = [...asList(tpl.default_bcc), ...(opts.bcc ?? [])];
  const uniq = (l: string[]) => [...new Set(l.map((x) => x.trim()).filter(Boolean))].filter((x) => !to.includes(x));
  return { subject: subject.result, html, to, cc: uniq(cc), bcc: uniq(bcc), missing: [...new Set(missing)] };
}
