import type { Context } from "hono";
import {
  type AlbertaRow, type Area, type CarrierRow, type DesignatedRow, esdcSource, type GrantRow, type IntlPostingRow, loadAlias, loadJson,
  loadProfile, lmiaGap, loadStats, type Profile,
} from "../data";
import type { AppEnv } from "../env";
import {
  basisText, decimal, indicatorLabel, indicatorStateLabel, numberLocale, provinceName, streamLabel, t, tj, tn, type Key, type Lang,
} from "../i18n";
import { Badge, Layout, fmtInt, fmtWage, noDataPage, page, periodLabel } from "../layout";
import { sourceLabel } from "./search";
import { WATCH_MAX } from "./watchlist";
import { MiniMap } from "../minimap";
import { profileSeo } from "../seo";
import {
  OTHER, cityPath, directoryCode, directoryPath, loadDirectories, occupationLinks, provincePath, type OccupationLinks,
} from "../crosslinks";
import { GradeBadge, Reasons, programName, registerPlace } from "./international";

const REPORT_URL = "https://www.canada.ca/en/employment-social-development/services/foreign-workers/report-abuse.html";

const ENTITY_TYPE: Record<string, Key> = {
  BC: "entity.BC", SP: "entity.SP", GP: "entity.GP", LP: "entity.LP", ULC: "entity.ULC", S: "entity.S",
  A: "entity.A", C: "entity.C", CBCA: "entity.CBCA",
  CIE: "entity.CIE", SENC: "entity.SENC", SEC: "entity.SEC", APE: "entity.APE", COP: "entity.COP",
};
const REGISTRY_NAME: Record<string, Key> = {
  bc_orgbook: "registry.bc_orgbook",
  corporations_canada: "registry.corporations_canada",
  quebec_req: "registry.quebec_req",
};
const REGISTRY_URL: Record<string, string> = {
  bc_orgbook: "https://orgbook.gov.bc.ca/",
  corporations_canada: "https://ised-isde.canada.ca/cc/lgcy/fdrlCrpSrch.html",
  quebec_req: "https://www.registreentreprises.gouv.qc.ca/",
};
// Registry status words the pipeline stores in English, shown in the page's language.
const REGISTRY_STATUS: Record<string, Key> = { ACT: "employer.active", Active: "employer.active", "Struck off": "employer.struck_off" };

const registryName = (lang: Lang, registry: string) => (REGISTRY_NAME[registry] ? t(lang, REGISTRY_NAME[registry]) : registry);

// -- public records ------------------------------------------------------------
// Grants, Alberta employer records and US carrier records are matched to the
// employer by name and place (sources/matching.py in the pipeline), so every
// row says how it was matched; a match is a pointer to a published record,
// not an identity.
const MATCH_GRADE: Record<string, Key> = { exact: "public.match_exact", probable: "public.match_probable" };
const MATCH_BASIS: Record<string, Key> = {
  business_number: "public.basis.business_number",
  name_postal_area: "public.basis.name_postal_area",
  name_province: "public.basis.name_province",
  operating_name_postal_area: "public.basis.operating_name_postal_area",
  name_city: "public.basis.name_city",
  trade_name_city: "public.basis.trade_name_city",
  name_postal_code: "public.basis.name_postal_code",
  dba_postal_code: "public.basis.dba_postal_code",
};
const CARRIER_STATUS: Record<string, Key> = { A: "carrier.status.A", I: "carrier.status.I", P: "carrier.status.P" };
const CARRIER_RATING: Record<string, Key> = { S: "carrier.rating.S", C: "carrier.rating.C", U: "carrier.rating.U" };
// How many matched accounts or carrier records a card lists; the export sends at most three.
const PUBLIC_SHOWN = 3;

const GRANTS_DATASET: Record<Lang, string> = {
  en: "https://open.canada.ca/data/en/dataset/432527ab-7aac-45b5-81d6-7597107a7013",
  fr: "https://open.canada.ca/data/fr/dataset/432527ab-7aac-45b5-81d6-7597107a7013",
};
const ALBERTA_DATASET = "https://open.alberta.ca/opendata/employer-records";

export function matchText(lang: Lang, grade: string, basis: string): string {
  const g = MATCH_GRADE[grade] ? t(lang, MATCH_GRADE[grade]) : grade;
  return MATCH_BASIS[basis] ? t(lang, "public.match", { grade: g, basis: t(lang, MATCH_BASIS[basis]) }) : g;
}

// The agreement's record in the government's grants search, in the form the
// search's own result links use: department, reference number and the word
// "current" (the agreement as last amended), joined by commas and encoded as
// one path segment. A numbered amendment in place of "current" answers an
// empty page (checked 2026-10-23).
export function grantUrl(g: Pick<GrantRow, "owner_org" | "ref_number">): string {
  return `https://search.open.canada.ca/grants/record/${encodeURIComponent(`${g.owner_org},${g.ref_number},current`)}`;
}

// The carrier's snapshot on FMCSA's SAFER system.
export function saferUrl(dot: number): string {
  return `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`;
}

const MONEY_FORMAT: Partial<Record<Lang, Intl.NumberFormat>> = {};
export function fmtMoney(v: number | null, lang: Lang): string {
  if (v === null) return t(lang, "common.na");
  const format = (MONEY_FORMAT[lang] ??= new Intl.NumberFormat(numberLocale(lang), {
    style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 0,
  }));
  return format.format(v);
}

const GrantsSection = ({ grants, total, lang }: { grants: GrantRow[]; total: number; lang: Lang }) => {
  const rest = total - grants.length;
  const na = t(lang, "common.na");
  const heads = {
    start: t(lang, "employer.grants_col_start"),
    program: t(lang, "employer.grants_col_program"),
    department: t(lang, "employer.grants_col_department"),
    value: t(lang, "employer.grants_col_value"),
    match: t(lang, "employer.match"),
    record: t(lang, "employer.grants_col_record"),
  };
  return (
    <section id="grants">
      <h2>{t(lang, "employer.grants")}</h2>
      <p class="muted small">{t(lang, "employer.grants_note")}</p>
      <div class="table-wrap bordered">
        <table class="restack">
          <thead>
            <tr>
              <th>{heads.start}</th><th>{heads.program}</th><th>{heads.department}</th>
              <th class="num">{heads.value}</th><th>{heads.match}</th><th>{heads.record}</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr>
                <td class="mono" data-label={heads.start}>{g.start_date ?? na}</td>
                <td data-label={heads.program}>{(lang === "fr" ? g.program_fr ?? g.program_en : g.program_en ?? g.program_fr) ?? na}</td>
                <td data-label={heads.department}>{(lang === "fr" ? g.department_fr ?? g.department_en : g.department_en ?? g.department_fr) ?? g.owner_org}</td>
                <td class="mono num" data-label={heads.value}>{fmtMoney(g.agreement_value, lang)}</td>
                <td data-label={heads.match}>{matchText(lang, g.grade, g.basis)}</td>
                <td data-label={heads.record}><a href={grantUrl(g)} class="mono" rel="nofollow noopener">{g.ref_number}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rest > 0 ? (
        <p class="muted small">
          {tj(lang, rest === 1 ? "employer.grants_more_one" : "employer.grants_more_many", {
            n: fmtInt(rest, lang),
            source: <a href={GRANTS_DATASET[lang]} rel="noopener">{t(lang, "employer.grants_source")}</a>,
          })}
        </p>
      ) : null}
    </section>
  );
};

// A count with its published rate per 100 person-years; a blank cell in the file stays "not given".
function countWithRate(lang: Lang, count: number | null, rate: number | null): string {
  if (count === null) return t(lang, "public.not_given");
  if (rate === null) return fmtInt(count, lang);
  return t(lang, "employer.alberta_rate", { n: fmtInt(count, lang), rate: decimal(lang, String(rate)) });
}

const AlbertaCard = ({ rows, lang }: { rows: AlbertaRow[]; lang: Lang }) => (
  <div class="card">
    <h2>{t(lang, "employer.alberta")}</h2>
    <p class="muted small">{t(lang, "employer.alberta_note")}</p>
    {rows.slice(0, PUBLIC_SHOWN).map((a) => (
      <dl>
        <dt>{t(lang, "employer.alberta_account")}</dt><dd>{a.employer_name}{a.trade_name ? ` (${a.trade_name})` : ""}</dd>
        <dt>{t(lang, "employer.alberta_year")}</dt>
        <dd class="mono">{a.first_year !== null && a.first_year < a.year ? t(lang, "employer.alberta_years", { year: a.year, first: a.first_year }) : String(a.year)}</dd>
        <dt>{t(lang, "employer.city")}</dt><dd>{a.city ?? t(lang, "public.not_given")}</dd>
        <dt>{t(lang, "employer.alberta_industry")}</dt><dd>{a.industry ?? t(lang, "public.not_given")}</dd>
        <dt>{t(lang, "employer.alberta_person_years")}</dt>
        <dd>{a.person_years === null ? t(lang, "public.not_given") : t(lang, "employer.alberta_person_years_value", { n: decimal(lang, String(a.person_years)) })}</dd>
        <dt>{t(lang, "employer.alberta_lost_time")}</dt><dd>{countWithRate(lang, a.lost_time_claims, a.lost_time_rate)}</dd>
        <dt>{t(lang, "employer.alberta_disabling")}</dt><dd>{countWithRate(lang, a.disabling_injuries, a.disabling_rate)}</dd>
        <dt>{t(lang, "employer.alberta_fatalities")}</dt><dd>{a.fatalities === null ? t(lang, "public.not_given") : fmtInt(a.fatalities, lang)}</dd>
        <dt>{t(lang, "employer.alberta_cor")}</dt>
        <dd>{a.cor_year === null ? t(lang, "employer.alberta_cor_none") : t(lang, "employer.alberta_cor_year", { year: a.cor_year })}</dd>
        <dt>{t(lang, "employer.match")}</dt><dd>{matchText(lang, a.grade, a.basis)}</dd>
      </dl>
    ))}
    <a href={ALBERTA_DATASET} class="small" rel="noopener">{t(lang, "employer.alberta_link")}</a>
  </div>
);

const CarrierCard = ({ rows, lang }: { rows: CarrierRow[]; lang: Lang }) => (
  <div class="card">
    <h2>{t(lang, "employer.carrier")}</h2>
    <p class="muted small">{t(lang, "employer.carrier_note")}</p>
    {rows.slice(0, PUBLIC_SHOWN).map((f) => {
      const rating = f.safety_rating && CARRIER_RATING[f.safety_rating] ? t(lang, CARRIER_RATING[f.safety_rating]) : t(lang, "carrier.rating.none");
      return (
        <dl>
          <dt>{t(lang, "employer.carrier_dot")}</dt>
          <dd><a href={saferUrl(f.dot_number)} class="mono id" rel="nofollow noopener">{f.dot_number}</a></dd>
          <dt>{t(lang, "employer.carrier_name")}</dt>
          <dd>{f.dba_name ? t(lang, "employer.carrier_dba", { name: f.legal_name, dba: f.dba_name }) : f.legal_name}</dd>
          <dt>{t(lang, "col.status")}</dt>
          <dd>{f.status && CARRIER_STATUS[f.status] ? t(lang, CARRIER_STATUS[f.status]) : f.status ?? t(lang, "public.not_given")}</dd>
          <dt>{t(lang, "employer.carrier_power_units")}</dt>
          <dd class="mono">{f.power_units === null ? t(lang, "public.not_given") : fmtInt(f.power_units, lang)}</dd>
          <dt>{t(lang, "employer.carrier_drivers")}</dt>
          <dd class="mono">{f.drivers === null ? t(lang, "public.not_given") : fmtInt(f.drivers, lang)}</dd>
          <dt>{t(lang, "employer.carrier_rating")}</dt>
          <dd>{f.safety_rating && f.safety_rating_date ? t(lang, "employer.carrier_rating_date", { rating, date: f.safety_rating_date }) : rating}</dd>
          <dt>{t(lang, "employer.carrier_record_date")}</dt>
          <dd>{f.record_date ? t(lang, "employer.carrier_record_date_value", { date: f.record_date }) : t(lang, "public.not_given")}</dd>
          <dt>{t(lang, "employer.match")}</dt><dd>{matchText(lang, f.grade, f.basis)}</dd>
        </dl>
      );
    })}
    {rows[0] ? <a href={saferUrl(rows[0].dot_number)} class="small" rel="nofollow noopener">{t(lang, "employer.carrier_link")}</a> : null}
  </div>
);

// Listings on published designated-employer lists (Atlantic Immigration
// Program, community pilots), matched by name and place like the other
// public records; "listed since" is the first night the site read the row.
const DesignatedCard = ({ rows, lang }: { rows: DesignatedRow[]; lang: Lang }) => (
  <div class="card">
    <h2>{t(lang, "employer.designated_h")}</h2>
    <p class="muted small">{t(lang, "employer.designated_note")}</p>
    {rows.slice(0, PUBLIC_SHOWN).map((r) => (
      <dl>
        <dt>{t(lang, "col.status")}</dt>
        <dd>{t(lang, "employer.designated_row", { program: programName(lang, r.program), where: registerPlace(lang, r), date: r.first_seen })}</dd>
        <dt>{t(lang, "employer.designated_as")}</dt><dd>{r.name}</dd>
        {r.location ? <><dt>{t(lang, "employer.designated_location")}</dt><dd>{r.location}</dd></> : null}
        {r.designated_on ? <><dt>{t(lang, "employer.designated_on")}</dt><dd class="mono">{r.designated_on}</dd></> : null}
        <dt>{t(lang, "employer.match")}</dt><dd>{matchText(lang, r.grade, r.basis)}</dd>
        <dd>
          {r.current && r.snapshot
            ? t(lang, "employer.designated_snapshot", { date: r.snapshot.list_date, loaded: r.snapshot.loaded_on })
            : r.current
              ? t(lang, "employer.designated_current", { date: r.last_seen })
              : t(lang, "employer.designated_gone", { date: r.last_seen })}{" "}
          <a href={r.url} class="small" rel="nofollow noopener">{t(lang, "employer.designated_link")}</a>
        </dd>
      </dl>
    ))}
  </div>
);

// Postings open to international candidates: signals, each with what the
// employer selected and what the site inferred, and never a job offer.
const IntlSection = ({ rows, lang }: { rows: IntlPostingRow[]; lang: Lang }) => (
  <section id="international">
    <div class="section-head">
      <h2>{t(lang, "employer.intl_h")}</h2>
      <a href="/international" class="small">{t(lang, "employer.intl_link")}</a>
    </div>
    <p class="muted small">{t(lang, "employer.intl_note")}</p>
    <div class="table-wrap bordered">
      <table class="restack intl-recent">
        <thead>
          <tr>
            <th>{t(lang, "col.date")}</th>
            <th>{t(lang, "intl.col_posting")}</th>
            <th>{t(lang, "intl.col_grade")}</th>
            <th>{t(lang, "intl.col_why")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr>
              <td class="mono nw" data-label={t(lang, "col.date")}>{p.date}</td>
              <td data-label={t(lang, "intl.col_posting")}>
                <div>
                  <a href={p.url} rel="nofollow noopener">{p.title ?? t(lang, "search.source_jobbank", { ref: p.id })}</a>
                  <div class="small">{[p.city, p.prov].filter(Boolean).join(", ")}</div>
                  {!p.live ? <div class="small muted">{t(lang, "intl.gone")}</div> : null}
                </div>
              </td>
              <td data-label={t(lang, "intl.col_grade")}>
                {p.grade ? <GradeBadge grade={p.grade} lang={lang} />
                  : p.lmia === "requested" || p.lmia === "approved" ? t(lang, "employer.intl_lmia") : <GradeBadge grade="unread" lang={lang} />}
              </td>
              <td data-label={t(lang, "intl.col_why")} class="small">
                {p.grade ? <Reasons lang={lang} reasons={p.reasons} noc={p.noc} /> : <p class="muted">{t(lang, "intl.not_offer")}</p>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

// Text that exists only in English in the source data (IRCC's list as the
// pipeline stores it, an indicator basis the dictionary does not know) is
// marked lang="en" on a French page so screen readers pronounce it right.
const enOnly = (lang: Lang) => (lang === "fr" ? "en" : undefined);

// An employer with a long history (health authorities, large consultancies)
// keeps the page quick: the newest rows render open, the rest collapsed.
const RECORDS_OPEN = 100;

// A NOC code, linked to its occupation page when that page is indexed (NOC
// 2021 codes only; the four-digit NOC 2011 codes of older lists have none).
// The title goes in the link's title attribute where the cell shows no title.
const NocCode = ({ code, links, lang, titled = false }: { code: string; links: OccupationLinks; lang: Lang; titled?: boolean }) => {
  const title = links.get(code);
  if (title === undefined) return <>{code}</>;
  return <a href={`/occupations/${code}`} title={titled && title ? title[lang] : undefined}>{code}</a>;
};

const EsdcRecordRow = ({ r, lang, occupations }: { r: Profile["esdc"][number]; lang: Lang; occupations: OccupationLinks }) => (
  <tr>
    <td class="mono">{periodLabel(r.period, lang)}</td>
    <td><Badge status={r.list === "positive" ? "approved" : "refused"} lang={lang} /></td>
    <td>
      {t(lang, "employer.esdc_record", {
        stream: r.stream ? streamLabel(lang, r.stream) : "",
        lmias: r.lmias ?? t(lang, "common.na"),
        place: `${r.city ? `, ${r.city}` : ""}${r.postal_code ? ` ${r.postal_code}` : ""}`,
      })}
    </td>
    <td>{r.noc_code ? <NocCode code={r.noc_code} links={occupations} lang={lang} /> : ""} {r.noc_title ?? ""}</td>
    <td class="mono">{t(lang, "common.na")}</td>
    <td class="mono num">{fmtInt(r.positions, lang)}</td>
    <td>
      <a href={esdcSource(r.list, r.resource_id)} class="mono" rel="nofollow noopener">
        {sourceLabel(lang, { kind: "esdc", ref: r.id, status: r.list === "positive" ? "approved" : "refused", period: r.period })}
      </a>
    </td>
    <td class="mono">{r.published ?? ""}</td>
  </tr>
);

interface ResponseRow { received_at: string; statement: string; contact_name: string | null }
interface CorrectionRow { received_at: string; record_ref: string | null; request: string; resolution: string | null; resolved_at: string | null }

export { lmiaGap } from "../data";

export function periodEnd(period: string): string {
  const m = /^(\d{4})Q(\d)(?:-Q(\d))?$/.exec(period);
  if (!m) return /^\d{4}$/.test(period) ? `${period}-12-31` : period;
  const q = Number(m[3] ?? m[2]);
  return `${m[1]}-${["03-31", "06-30", "09-30", "12-31"][q - 1]}`;
}

function gradeText(lang: Lang, grade: string): string {
  if (grade === "exact") return t(lang, "employer.grade_exact");
  if (grade === "probable") return t(lang, "employer.grade_probable");
  return t(lang, "employer.grade_possible");
}

async function siteRows(c: Context<AppEnv>, id: string): Promise<{ responses: ResponseRow[]; corrections: CorrectionRow[] }> {
  if (!c.env.DB) return { responses: [], corrections: [] };
  try {
    const [responses, corrections] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT received_at, statement, contact_name FROM employer_responses WHERE employer_id = ? AND published = 1 ORDER BY received_at DESC").bind(id),
      c.env.DB.prepare("SELECT received_at, record_ref, request, resolution, resolved_at FROM corrections WHERE employer_id = ? AND published = 1 ORDER BY received_at DESC").bind(id),
    ]);
    return {
      responses: (responses.results ?? []) as unknown as ResponseRow[],
      corrections: (corrections.results ?? []) as unknown as CorrectionRow[],
    };
  } catch {
    return { responses: [], corrections: [] };
  }
}

// A retired employer id redirects to the id that took its records, so old
// links and bookmarks still reach the profile. The pages read no query but the
// language, so only that is carried over. The redirect is cached like a page
// rather than for good, since a later matching change can move the records
// again. Null when the id has no alias.
export async function retiredIdRedirect(
  c: Context<AppEnv>, id: string, suffix = "", status: 301 | 308 = 301,
): Promise<Response | null> {
  const live = await loadAlias(c.env, id);
  if (!live) return null;
  const lang = c.req.query("lang");
  c.header("Cache-Control", "public, max-age=300");
  return c.redirect(`/employers/${live}${suffix}${lang === "en" || lang === "fr" ? `?lang=${lang}` : ""}`, status);
}

export async function employerPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const id = c.req.param("id") ?? "";
  const stats = await loadStats(c.env);
  if (!stats) return noDataPage(c, "employer.title");
  const profile: Profile | null = await loadProfile(c.env, id);
  if (!profile) {
    const moved = await retiredIdRedirect(c, id);
    if (moved) return moved;
    return page(
      c,
      <Layout lang={lang} title={t(lang, "employer.not_found")} dataAsOf={stats.data_as_of}>
        <h1>{t(lang, "employer.not_found")}</h1>
        <p><a href="/search">{t(lang, "employer.search_records")}</a>.</p>
      </Layout>,
      404,
    );
  }
  const { employer, postings, esdc, registry, indicators, findings, names, grants, alberta, us_carrier, intl, designated, related } = profile;
  const best = registry[0];
  // The area file holds the postal area's centroid for the location card's map; a
  // missing file (no record in the latest scope) means no map, not an error.
  // The city and occupation links read their index files alongside; a missing
  // file means plain text.
  const fsa = employer.postal_code ? employer.postal_code.slice(0, 3).toUpperCase() : "";
  const [{ responses, corrections }, area, cityHref, occupations, directories] = await Promise.all([
    siteRows(c, id),
    /^[A-Z][0-9][A-Z]$/.test(fsa) ? loadJson<Area>(c.env, `areas/${fsa}.json`).catch(() => null) : Promise.resolve(null),
    cityPath(c.env, employer.province, employer.city),
    occupationLinks(c.env),
    loadDirectories(c.env),
  ]);
  // The A to Z list of the employer's province (or of employers with a head
  // office outside Canada or no province), linked when it is published.
  const dirCode = directoryCode(employer.province);
  const dirLink = directories?.get(dirCode)?.pages ? (
    <a href={directoryPath(dirCode)}>
      {dirCode === OTHER ? t(lang, "directory.heading_other") : t(lang, "directory.link", { province: provinceName(lang, employer.province ?? "") })}
    </a>
  ) : null;
  const provinceHref = provincePath(employer.province);
  const provinceCrumb = employer.province ? provinceName(lang, employer.province) : t(lang, "employer.all_provinces");
  const pendingPosting = postings.find((p) => p.flag_current === "requested");
  const na = t(lang, "common.na");
  const n = (v: number | null | undefined) => fmtInt(v, lang);
  const positions = (v: number) => tn(lang, "employer.positions_paren_one", "employer.positions_paren_many", v, { n: n(v) });
  // approved_lmias and refused_lmias sum the rows' LMIA counts, and many ESDC
  // files give positions only. Every listed row is at least one LMIA, so a row
  // without a count adds one and the figure reads as a floor.
  const gapApproved = lmiaGap(esdc, "positive");
  const gapRefused = lmiaGap(esdc, "negative");
  const lmiaCount = (lmias: number, gap: number) => (gap ? t(lang, "employer.at_least", { n: n(lmias + gap) }) : n(lmias));

  const events: { date: string; text: string; kind: string }[] = [];
  for (const r of registry) {
    if (r.registered_on) {
      events.push({
        date: r.registered_on,
        kind: "registry",
        text: t(lang, "employer.ev_registered", { name: r.legal_name ?? r.registry_id, registry: registryName(lang, r.registry) }),
      });
    }
  }
  for (const p of postings) {
    if (p.date_posted) {
      events.push({
        date: p.date_posted,
        kind: "pending",
        text: t(lang, "employer.ev_published", {
          id: p.posting_id,
          title: p.title ?? t(lang, "employer.untitled"),
          wage: p.wage_min !== null ? `, ${fmtWage(p.wage_min, p.wage_max, p.wage_unit, lang)}` : "",
        }),
      });
    }
    events.push({ date: p.first_seen.slice(0, 10), kind: "pending", text: t(lang, "employer.ev_first_seen", { id: p.posting_id }) });
    if (p.approved_seen_at) events.push({ date: p.approved_seen_at.slice(0, 10), kind: "approved", text: t(lang, "employer.ev_approved", { id: p.posting_id }) });
    if (p.valid_through) events.push({ date: p.valid_through, kind: "future", text: t(lang, "employer.ev_closes", { id: p.posting_id }) });
  }
  for (const r of esdc) {
    events.push({
      date: periodEnd(r.period),
      kind: r.list === "positive" ? "approved" : "refused",
      text: t(lang, r.list === "positive" ? "employer.ev_positive" : "employer.ev_negative", {
        period: periodLabel(r.period, lang),
        noc: `${r.noc_code ?? ""} ${r.noc_title ?? ""}`,
        positions: n(r.positions),
        published: r.published ? t(lang, "employer.ev_list_published", { date: r.published }) : "",
      }),
    });
  }
  for (const f of findings) {
    if (f.decision_date) {
      events.push({
        date: f.decision_date,
        kind: "finding",
        text: t(lang, "employer.ev_finding", { penalty: f.penalty ?? "", status: f.status ? `(${f.status})` : "" }),
      });
    }
  }
  // Newest first, so a long record opens on what happened last.
  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const statusNote =
    employer.current_status === "pending" && pendingPosting
      ? t(lang, "employer.under_review", { date: pendingPosting.last_seen.slice(0, 10) })
      : employer.status_changed_at
        ? t(lang, "employer.since", { date: employer.status_changed_at.slice(0, 10) })
        : "";
  const location = [employer.street, employer.city, employer.province, employer.postal_code].filter(Boolean).join(", ") || t(lang, "employer.no_location");
  const recordsHead = (
    <thead>
      <tr>
        <th>{t(lang, "col.date")}</th>
        <th>{t(lang, "col.status")}</th>
        <th>{t(lang, "employer.col_record")}</th>
        <th>{t(lang, "employer.col_occupation")}</th>
        <th>{t(lang, "col.wage")}</th>
        <th class="num">{t(lang, "col.positions")}</th>
        <th>{t(lang, "col.source")}</th>
        <th>{t(lang, "employer.col_pulled")}</th>
      </tr>
    </thead>
  );

  // Every profile names the bulk files as an alternate representation, for
  // the crawlers and tools that read the Link header rather than /llms.txt.
  c.header("Link", '</downloads/employers.csv>; rel="alternate"; type="text/csv"; title="Every employer, bulk data", </llms.txt>; rel="help"; type="text/plain"');
  return page(
    c,
    <Layout lang={lang} title={employer.display_name} dataAsOf={stats.data_as_of} seo={profileSeo(profile, lang)}>
      <nav aria-label={t(lang, "employer.breadcrumb")} class="breadcrumb">
        <a href="/">{t(lang, "common.home")}</a> / {provinceHref ? <a href={provinceHref}>{provinceCrumb}</a> : provinceCrumb} / {t(lang, "employer.title")}
      </nav>
      <section class="profile-head">
        <div>
          <h1>{employer.display_name}</h1>
          <p class="muted">{tj(lang, "employer.id_line", { location, id: <span class="mono id">{employer.id}</span> })}</p>
          <p>
            <Badge status={employer.current_status} lang={lang} />{" "}
            <span class="muted">{statusNote}</span>
          </p>
        </div>
        <div class="actions">
          {/* Shown by watchlist.js when this browser can store the list; the list never leaves the browser. */}
          <button type="button" class="btn" id="watch-toggle" data-employer={employer.id} data-max={String(WATCH_MAX)}
            data-label-off={t(lang, "watch.watch")} data-label-on={t(lang, "watch.watching")}
            data-label-full={t(lang, "watch.full", { max: WATCH_MAX })} title={t(lang, "watch.button_title")}
            aria-pressed="false" style="display:none">{t(lang, "watch.watch")}</button>
          <a href={`/employers/${employer.id}/respond`} class="btn">{t(lang, "employer.respond")}</a>
          {/* The id rides in the fragment, so every profile links one URL; corrections.js copies it into the form (forms.tsx). */}
          <a href={`/corrections#${employer.id}`} class="btn">{t(lang, "employer.correct")}</a>
          <a href={REPORT_URL} class="btn btn-active" rel="noopener">{t(lang, "employer.report")}</a>
        </div>
      </section>

      <section class="cards">
        <div class="card">
          <h2>{t(lang, "employer.registry")}</h2>
          {best ? (
            <dl>
              <dt>{t(lang, "employer.legal_name")}</dt><dd>{best.legal_name ?? na}</dd>
              <dt>{t(lang, "employer.number")}</dt><dd class="mono id">{best.registry_id}</dd>
              <dt>{t(lang, "employer.type")}</dt><dd>{ENTITY_TYPE[best.entity_type ?? ""] ? t(lang, ENTITY_TYPE[best.entity_type ?? ""]) : best.entity_type ?? na}</dd>
              <dt>{t(lang, "col.status")}</dt><dd>{REGISTRY_STATUS[best.status ?? ""] ? t(lang, REGISTRY_STATUS[best.status ?? ""]) : best.status ?? na}</dd>
              <dt>{t(lang, "employer.registered")}</dt><dd class="mono">{best.registered_on ?? na}</dd>
              <dt>{t(lang, "employer.match")}</dt><dd>{gradeText(lang, best.grade)}</dd>
              <dt>{t(lang, "employer.names_seen")}</dt><dd>{names.map((nm) => nm.name).join("; ")}</dd>
            </dl>
          ) : (
            <>
              <p class="muted">{t(lang, "employer.no_registry")}</p>
              {names.length ? (
                <dl>
                  <dt>{t(lang, "employer.names_seen")}</dt><dd>{names.map((nm) => nm.name).join("; ")}</dd>
                </dl>
              ) : null}
            </>
          )}
          {best ? (
            <a href={REGISTRY_URL[best.registry] ?? "#"} class="small" rel="noopener">
              {t(lang, "employer.view_on", { registry: registryName(lang, best.registry) })}
            </a>
          ) : null}
        </div>
        <div class="card">
          <h2>{t(lang, "employer.location")}</h2>
          <dl>
            <dt>{t(lang, "employer.street")}</dt><dd>{employer.street ?? t(lang, "employer.street_none")}</dd>
            <dt>{t(lang, "employer.city")}</dt>
            <dd>
              {employer.city && cityHref
                ? <><a href={cityHref}>{employer.city}</a>{employer.province ? `, ${employer.province}` : ""}</>
                : [employer.city, employer.province].filter(Boolean).join(", ") || na}
            </dd>
            <dt>{t(lang, "employer.postal_code")}</dt><dd class="mono">{employer.postal_code ?? na}</dd>
            <dt>{t(lang, "col.source")}</dt>
            <dd>
              {employer.street_source === "ircc"
                ? t(lang, "employer.source_finding")
                : postings[0]
                ? t(lang, "employer.source_posting", { id: postings[0].posting_id })
                : esdc[0]
                  ? t(lang, "employer.source_list", { period: periodLabel(esdc[0].period, lang) })
                  : na}
            </dd>
          </dl>
          {area ? <MiniMap lat={area.lat} lon={area.lon} label={t(lang, "employer.minimap_aria", { fsa: area.fsa })} /> : null}
          <p class="small">
            <a href={`/map${employer.postal_code ? `?fsa=${employer.postal_code.slice(0, 3)}` : ""}`}>{t(lang, "employer.nearby")}</a>
            {area ? <span class="muted minimap-credit"> {t(lang, "employer.map_credit")}</span> : null}
          </p>
        </div>
        <div class="card">
          <h2>{t(lang, "employer.summary")}</h2>
          <dl>
            <dt>{t(lang, "employer.pending_postings")}</dt><dd class="mono">{n(employer.pending_count)}</dd>
            <dt>{t(lang, "employer.positions_requested")}</dt>
            <dd class="mono">{n(postings.filter((p) => p.flag_current === "requested").reduce((s, p) => s + (p.vacancies ?? 0), 0))}</dd>
            <dt>{t(lang, "employer.approved_lmias")}</dt>
            <dd class="mono">{lmiaCount(employer.approved_lmias, gapApproved)} <span class="muted">{positions(employer.approved_positions)}</span></dd>
            <dt>{t(lang, "employer.refused_lmias")}</dt>
            <dd class="mono">{lmiaCount(employer.refused_lmias, gapRefused)} <span class="muted">{positions(employer.refused_positions)}</span></dd>
            <dt>{t(lang, "employer.findings_count")}</dt><dd class="mono">{n(employer.finding_count)}</dd>
            <dt>{t(lang, "employer.response")}</dt>
            <dd>
              {responses.length
                ? tn(lang, "employer.published_one", "employer.published_many", responses.length, { n: responses.length })
                : t(lang, "employer.none_received")}
            </dd>
          </dl>
          {gapApproved || gapRefused ? (
            <p class="muted small" id="lmia-count-note">
              {[
                gapApproved ? tn(lang, "employer.lmias_note_one", "employer.lmias_note_many", gapApproved, { n: n(gapApproved) }) : "",
                gapRefused ? tn(lang, "employer.refused_lmias_note_one", "employer.refused_lmias_note_many", gapRefused, { n: n(gapRefused) }) : "",
              ].filter(Boolean).join(" ")}
            </p>
          ) : null}
        </div>
      </section>

      {alberta.length || us_carrier.length || designated.length ? (
        <section class="cards two" id="public-records">
          {designated.length ? <DesignatedCard rows={designated} lang={lang} /> : null}
          {alberta.length ? <AlbertaCard rows={alberta} lang={lang} /> : null}
          {us_carrier.length ? <CarrierCard rows={us_carrier} lang={lang} /> : null}
        </section>
      ) : null}

      <section>
        <div class="section-head">
          <h2>{t(lang, "employer.indicators")}</h2>
          <a href="/methodology#indicators" class="small">{t(lang, "employer.indicator_link")}</a>
        </div>
        <p class="muted small">{t(lang, "employer.indicator_note")}</p>
        <div class="table-wrap bordered">
          <table class="restack">
            <thead>
              <tr>
                <th>{t(lang, "employer.col_indicator")}</th>
                <th>{t(lang, "employer.col_state")}</th>
                <th>{t(lang, "employer.col_basis")}</th>
              </tr>
            </thead>
            <tbody>
              {indicators.length === 0 ? <tr><td colspan={3} class="muted">{t(lang, "employer.not_computed")}</td></tr> : indicators.map((i) => {
                const basis = basisText(lang, i.basis);
                return (
                  <tr>
                    <td data-label={t(lang, "employer.col_indicator")}>{indicatorLabel(lang, i.indicator)}</td>
                    <td data-label={t(lang, "employer.col_state")}><span class={`badge state-${i.state}`}>{indicatorStateLabel(lang, i.state)}</span></td>
                    <td data-label={t(lang, "employer.col_basis")} lang={basis.translated ? undefined : enOnly(lang)}>{basis.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {findings.length ? (
        <section>
          <h2>{t(lang, "employer.findings")}</h2>
          <div class="table-wrap bordered">
            <table>
              <thead>
                <tr>
                  <th>{t(lang, "employer.col_decision")}</th>
                  <th>{t(lang, "employer.col_operating_name")}</th>
                  <th>{t(lang, "employer.legal_name")}</th>
                  <th>{t(lang, "employer.col_address")}</th>
                  <th>{t(lang, "employer.col_reasons")}</th>
                  <th>{t(lang, "employer.col_penalty")}</th>
                  <th>{t(lang, "col.status")}</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr>
                    <td class="mono">{f.decision_date ?? ""}</td><td>{f.operating_name ?? ""}</td><td>{f.legal_name ?? ""}</td>
                    <td>{f.address ?? ""}</td><td lang={enOnly(lang)}>{f.reasons ?? ""}</td>
                    <td lang={enOnly(lang)}>{f.penalty ?? ""}</td><td lang={enOnly(lang)}>{f.status ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {grants.length ? <GrantsSection grants={grants} total={profile.grants_total} lang={lang} /> : null}

      {intl.length ? <IntlSection rows={intl} lang={lang} /> : null}

      <section>
        <h2>{t(lang, "employer.timeline")}</h2>
        <ol class="timeline">
          {employer.current_status === "pending" ? (
            <li class="tl-future"><span class="mono">{t(lang, "employer.pending_label")}</span> {t(lang, "employer.ev_decision")}</li>
          ) : null}
          {events.map((e) => (
            <li class={`tl-${e.kind}`}><span class="mono">{e.date}</span> {e.text}</li>
          ))}
          {events.length === 0 ? <li class="muted">{t(lang, "employer.no_dated")}</li> : null}
        </ol>
      </section>

      <section>
        <h2>{t(lang, "employer.records")}</h2>
        {esdc.length > RECORDS_OPEN ? (
          <p class="muted small">
            {tj(lang, "employer.records_newest", {
              shown: RECORDS_OPEN,
              total: n(esdc.length),
              json: <a href={`/api/employers/${employer.id}`}>{t(lang, "employer.profile_json")}</a>,
            })}
          </p>
        ) : null}
        <div class="table-wrap bordered">
          <table>
            {recordsHead}
            <tbody>
              {postings.map((p) => (
                <tr>
                  <td class="mono">{p.date_posted ?? p.first_seen.slice(0, 10)}</td>
                  <td><Badge status={p.flag_current === "requested" ? "pending" : p.flag_current === "approved" ? "approved" : "lapsed"} lang={lang} /></td>
                  <td>{p.title ?? t(lang, "employer.posting")}{p.valid_through ? t(lang, "employer.open_until", { date: p.valid_through }) : ""}</td>
                  <td>{p.noc_code ? tj(lang, "employer.noc", { code: <NocCode code={p.noc_code} links={occupations} lang={lang} titled /> }) : na}</td>
                  <td class="mono">{fmtWage(p.wage_min, p.wage_max, p.wage_unit, lang)}</td>
                  <td class="mono num">{p.vacancies === null ? t(lang, "common.see_posting") : n(p.vacancies)}</td>
                  <td><a href={p.url} class="mono" rel="nofollow noopener">{t(lang, "search.source_jobbank", { ref: p.posting_id })}</a></td>
                  <td class="mono">{p.last_seen.slice(0, 10)}</td>
                </tr>
              ))}
              {esdc.slice(0, RECORDS_OPEN).map((r) => <EsdcRecordRow r={r} lang={lang} occupations={occupations} />)}
              {postings.length + esdc.length === 0 ? <tr><td colspan={8} class="muted">{t(lang, "common.no_records")}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {esdc.length > RECORDS_OPEN ? (
          <details class="top-gap">
            <summary>{t(lang, "employer.show_all", { n: n(esdc.length) })}</summary>
            <div class="table-wrap bordered">
              <table>
                {recordsHead}
                <tbody>{esdc.slice(RECORDS_OPEN).map((r) => <EsdcRecordRow r={r} lang={lang} occupations={occupations} />)}</tbody>
              </table>
            </div>
          </details>
        ) : null}
      </section>

      {related.length ? (
        <section id="related">
          <h2>{t(lang, "employer.related_h")}</h2>
          <p class="muted small">{t(lang, "employer.related_note")}</p>
          <ul class="quick-links">
            {related.map((r) => (
              <li><a href={`/employers/${r.id}`}>{r.name}</a>{r.city ? <span class="muted"> {r.city}</span> : null}</li>
            ))}
          </ul>
          {dirLink ? <p class="small top-gap">{dirLink}</p> : null}
        </section>
      ) : dirLink ? <p class="small top-gap">{dirLink}</p> : null}

      <section class="cards two">
        <div class="card panel">
          <h2>{t(lang, "employer.response_h")}</h2>
          {responses.length ? responses.map((r) => (
            <blockquote>
              <p>{r.statement}</p>
              <footer class="muted small">
                {t(lang, "employer.received", { date: r.received_at.slice(0, 10), contact: r.contact_name ? `, ${r.contact_name}` : "" })}
              </footer>
            </blockquote>
          )) : (
            <p class="muted">{t(lang, "employer.no_response")}</p>
          )}
          <a href={`/employers/${employer.id}/respond`}>{t(lang, "employer.submit_response")}</a>
        </div>
        <div class="card panel">
          <h2>{t(lang, "employer.corrections_log")}</h2>
          {corrections.length ? (
            <ul>
              {corrections.map((r) => (
                <li>
                  <span class="mono">{r.received_at.slice(0, 10)}</span> {r.record_ref ? `${r.record_ref}: ` : ""}{r.request}
                  {r.resolution ? t(lang, "employer.resolution", { date: (r.resolved_at ?? "").slice(0, 10), text: r.resolution }) : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">{t(lang, "employer.no_corrections")}</p>
          )}
          <a href={`/corrections#${employer.id}`}>{t(lang, "employer.correct")}</a>
        </div>
      </section>

      <section class="panel bordered">
        <h2>{t(lang, "employer.info")}</h2>
        <p>{tj(lang, "employer.info_report", { form: <a href={REPORT_URL} rel="noopener">{t(lang, "employer.info_form")}</a> })}</p>
        <p>{t(lang, "employer.info_rights")}</p>
      </section>
      <script src="/watchlist.js"></script>
    </Layout>,
  );
}
