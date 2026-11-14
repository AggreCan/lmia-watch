// The site's data is a set of JSON files the pipeline writes and the deploy
// ships as static assets under /data/. The Worker reads them through the
// assets binding; nothing here touches a database.

import type { Env } from "./env";
import { isListOf, isNum, isNumOrNull, isObj, isStr, isStrOrNull, optional } from "./valid";

export interface SearchRow {
  kind: "posting" | "esdc";
  ref: number;
  employer_id: string;
  employer: string;
  job: string | null;
  noc: string | null;
  street: string | null;
  city: string | null;
  prov: string | null;
  postal: string | null;
  wage_min: number | null;
  wage_max: number | null;
  unit: string | null;
  date: string | null;
  period: string | null;
  positions: number | null;
  status: string;
  stream: string | null;
  source: string;
  sort_date: string;
  // Home page only: the day the "LMIA requested" flag was first seen (recent_pending rows).
  flagged?: string;
  ind: string[];
}

export interface Stats {
  data_as_of: string | null;
  jobbank_last_run: string | null;
  esdc_latest_period: string;
  esdc_latest_published: string | null;
  rules_version: string | null;
  // The start of the map's longer period (the name is older than hosted
  // search, which covers every year).
  search_from_period: string;
  counts: {
    pending: number;
    approved_records: number;
    approved_positions: number;
    refused_records: number;
    findings: number;
    employers: number;
    // The public records matched to employers; absent from files written
    // before them.
    grant_employers?: number;
    grant_agreements?: number;
    alberta_employers?: number;
    carrier_employers?: number;
    // Pending postings with a NOC 2021 code, the total behind pending_by_noc.
    pending_with_noc?: number;
    // Postings open to international candidates (live, without an LMIA
    // request, graded A) and employers matched to a designated-employer list.
    intl_live?: number;
    intl_no_lmia?: number;
    intl_grade_a?: number;
    designated_employers?: number;
  };
  by_stream: { k: string; n: number }[];
  by_province: { k: string; n: number }[];
  recent_pending: SearchRow[];
  // The codes with the most pending postings; absent from files written
  // before it, and checked by the home page, its only reader.
  pending_by_noc?: { k: string; n: number; title: { en: string; fr: string } }[];
  recent_approved: SearchRow[];
  top_approvals: { employer_id: string; employer: string; city: string | null; prov: string | null; stream: string | null; positions: number }[];
  resources: { dataset: string; period: string; published: string | null; rows_loaded: number; loaded_at: string }[];
  runs: { run_at: string; source: string; detail: string | null; rows_new: number | null; ok: number }[];
  // The Zenodo record of the OGL files; absent or null until one is published.
  citation?: Citation | null;
  // The designated-employer lists with their terms (the Data page's sources);
  // checked by that page, its only reader.
  registers?: unknown;
  // IRCC's high-wage list in use (its version date); checked by the methodology page, its only reader.
  high_wage?: unknown;
}

export interface Citation {
  title: string;
  concept_doi: string;
  doi: string | null;
  version: string | null;
  published: string | null;
}

export interface Profile {
  employer: {
    id: string; display_name: string; province: string | null; city: string | null; postal_code: string | null;
    street: string | null; street_source?: string | null; current_status: string; status_changed_at: string | null;
    first_seen: string | null;
    last_seen: string | null; pending_count: number; approved_lmias: number; approved_positions: number;
    refused_lmias: number; refused_positions: number; finding_count: number; indicator_count: number;
    registry_grade: string; updated_at: string;
  };
  names: { name: string; source: string }[];
  postings: {
    posting_id: number; employer_raw: string; title: string | null; noc_code: string | null; street: string | null;
    city: string | null; province: string | null; postal_code: string | null; wage_min: number | null;
    wage_max: number | null; wage_unit: string | null; vacancies: number | null; date_posted: string | null;
    valid_through: string | null; first_seen: string; last_seen: string; flag_current: string;
    approved_seen_at: string | null; url: string;
  }[];
  esdc: {
    id: number; list: string; period: string; employer_raw: string; province: string | null; stream: string | null;
    city: string | null; postal_code: string | null; noc_code: string | null; noc_title: string | null;
    incorporate_status: string | null; lmias: number | null; positions: number | null; resource_id: string;
    published: string | null;
  }[];
  registry: {
    registry: string; registry_id: string; legal_name: string | null; entity_type: string | null; status: string | null;
    registered_on: string | null; grade: string; checked_at: string;
  }[];
  indicators: { indicator: string; state: string; basis: string; rule_version: string; computed_at: string }[];
  findings: {
    operating_name: string | null; legal_name: string | null; address: string | null; reasons: string | null;
    decision_date: string | null; penalty: string | null; status: string | null;
  }[];
  // Public records matched to the employer by name and place (or by business
  // number), shown as records. A shard written before these sources existed
  // has none of the keys; loadProfile fills them in empty.
  grants: GrantRow[];
  grants_total: number;
  alberta: AlbertaRow[];
  us_carrier: CarrierRow[];
  // Job Bank postings open to international candidates, with the site's grade
  // (signals, not records of job offers), and listings on designated-employer
  // lists matched by name and place. The export writes each only when there
  // is something; loadProfile fills them in empty.
  intl: IntlPostingRow[];
  designated: DesignatedRow[];
  // Up to five other employers in the same city, then with the same most
  // common occupation code in the province, nearest in record count
  // (pipeline/lmia_pipeline/directory.py). Written only when there are any;
  // loadProfile fills in an empty list.
  related: RelatedRow[];
}

// A related employer: its id and name, and its city when that is not the profile's.
export interface RelatedRow { id: string; name: string; city?: string }

// One posting open to international candidates; grade null with an LMIA requested or before its page is read.
export interface IntlPostingRow {
  id: number; title: string | null; noc: string | null; city: string | null; prov: string | null; date: string;
  live: boolean; lmia: string; grade: "A" | "B" | "C" | null; reasons: string[]; url: string;
}

// One listing on a designated-employer list (Atlantic Immigration Program, community pilots).
export interface DesignatedRow {
  list: string; program: string; jurisdiction: string; community: string | null; name: string; location: string | null;
  designated_on: string | null; first_seen: string; last_seen: string; current: boolean; url: string; grade: string;
  basis: string;
  // Present when the row is current only through the list's copy loaded by hand.
  snapshot?: { list_date: string; loaded_on: string };
}

// One federal grant or contribution agreement, at its latest amendment.
export interface GrantRow {
  ref_number: string; amendment_number: number; owner_org: string; department_en: string | null;
  department_fr: string | null; program_en: string | null; program_fr: string | null; agreement_type: string | null;
  agreement_value: number | null; start_date: string | null; end_date: string | null; grade: string; basis: string;
}

// The latest year of one Alberta workers' compensation account.
export interface AlbertaRow {
  emp_key: string; year: number; first_year: number | null; employer_name: string; trade_name: string | null;
  city: string | null; industry: string | null; person_years: number | null; lost_time_claims: number | null;
  lost_time_rate: number | null; disabling_injuries: number | null; disabling_rate: number | null;
  fatalities: number | null; cor_year: number | null; grade: string; basis: string;
}

// One US carrier census record.
export interface CarrierRow {
  dot_number: number; legal_name: string; dba_name: string | null; city: string | null; province: string | null;
  postal_code: string | null; status: string | null; power_units: number | null; drivers: number | null;
  safety_rating: string | null; safety_rating_date: string | null; record_date: string | null; grade: string;
  basis: string;
}

export interface Facets {
  default: { total: number; status: Record<string, number>; prov: Record<string, number>; status_prov: Record<string, number> };
  long: {
    total: number; status: Record<string, number>; prov: Record<string, number>;
    prov_year: Record<string, number>; status_prov: Record<string, number>;
  };
  files: Record<string, { rows: number; bytes: number }>;
  first_rows: number;
}

export interface Cluster {
  fsa: string; prov: string; lat: number; lon: number; pending: number; approved: number; refused: number;
}

export interface Area extends Omit<Cluster, "pending" | "approved" | "refused"> {
  total: number;
  rows: SearchRow[];
}

export const EMPLOYER_ID_RE = /^emp-[0-9a-f]{10}$/;

const POSITIVE_DATASET = "90fed587-1364-4f33-a9ee-208181dc0b97";
const NEGATIVE_DATASET = "f82f66f2-a22b-4511-bccf-e1d74db39ae5";

export function esdcSource(list: string, resourceId: string): string {
  return `https://open.canada.ca/data/en/dataset/${list === "positive" ? POSITIVE_DATASET : NEGATIVE_DATASET}/resource/${resourceId}`;
}

export async function assetResponse(env: Env, path: string): Promise<Response | null> {
  if (!env.ASSETS) return null;
  try {
    const res = await env.ASSETS.fetch(new Request(`https://assets.invalid/data/${path}`));
    return res.ok ? res : null;
  } catch (e) {
    console.error(`asset ${path}: ${String(e).slice(0, 200)}`);
    return null;
  }
}

// Parsed files are kept for the life of the isolate and shared by every
// request it serves, so a crawler walking pages that read the same file pays
// for parsing it once. Each read still fetches the asset and compares its
// ETag with the kept one: the assets layer gives a file a new ETag whenever
// its content changes, and a deploy ships changed files, so a stale value is
// never served and no expiry time is needed. A response without an ETag is
// parsed and not kept.
//
// Memory: the largest file a page parses is a profile shard of about 250 KB,
// and parsed JSON measured about 1.35 times its text in V8, so 64 entries of
// that size are about 16 MB of text and 22 MB of heap. Entries are capped at
// 2 MB of text and the whole cache at 24 MB of text (about 32 MB of heap),
// well inside the isolate's 128 MB whatever the files become; 64 entries of
// 2 MB with no total cap would be 128 MB of text, more than the isolate
// holds. A file past the entry cap still loads; it is parsed on every read.
// Sizes are the text's length, known for every response (the assets binding
// in the test runtime sends no Content-Length).
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_ENTRY_CHARS = 2 * 1024 * 1024;
const CACHE_MAX_TOTAL_CHARS = 24 * 1024 * 1024;

interface Parsed {
  etag: string;
  value: unknown;
  chars: number;
}

// A Map iterates in insertion order, and a hit is moved to the end, so the
// first key is always the least recently used.
const parsed = new Map<string, Parsed>();
let parsedChars = 0;

function forget(path: string): void {
  const old = parsed.get(path);
  if (!old) return;
  parsed.delete(path);
  parsedChars -= old.chars;
}

function keep(path: string, entry: Parsed): void {
  forget(path);
  parsed.set(path, entry);
  parsedChars += entry.chars;
  for (const [oldest, e] of parsed) {
    if (parsed.size <= CACHE_MAX_ENTRIES && parsedChars <= CACHE_MAX_TOTAL_CHARS) break;
    parsed.delete(oldest);
    parsedChars -= e.chars;
  }
}

// For the tests: the cache starts empty in each one that asks.
export function clearParsedCache(): void {
  parsed.clear();
  parsedChars = 0;
}

// A kept value is shared between requests, so a page that changed it in place
// would change it for every later request. Every loaded value is frozen,
// kept or not, so a page behaves the same either way, and in strict mode
// (every module is) a change in place throws instead. The tests freeze each
// file all the way down (test/setup.ts calls freezeDeeply), so a page that
// changes a nested row fails there; production freezes the top level only,
// because walking every node costs about a third as much again as JSON.parse
// itself (0.12 to 0.14 ms for a 190 to 240 KB profile shard, measured with
// scripts/bench-render.mjs on 2026-11-14), on every profile request that
// finds its shard unparsed. A parsed file is a tree, so no node is visited twice.
let freezeAllTheWay = false;

export function freezeDeeply(on: boolean): void {
  freezeAllTheWay = on;
}

function deepFreeze<T>(root: T): T {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop() as object;
    Object.freeze(v);
    for (const child of Object.values(v)) if (typeof child === "object" && child !== null) stack.push(child);
  }
  return root;
}

// A file that does not parse (a truncated or corrupt deploy) reads as missing,
// so a page answers "not published" or "not found" instead of an error page.
// The value returned is frozen and may be shared: copy before changing it.
export async function loadJson<T>(env: Env, path: string): Promise<T | null> {
  const res = await assetResponse(env, path);
  if (!res) return null;
  const etag = res.headers.get("etag");
  const hit = etag ? parsed.get(path) : undefined;
  if (hit && hit.etag === etag) {
    parsed.delete(path);
    parsed.set(path, hit);
    await res.body?.cancel().catch(() => undefined);
    return hit.value as T;
  }
  forget(path);
  let text: string;
  let value: unknown;
  try {
    text = await res.text();
    value = JSON.parse(text);
  } catch (e) {
    console.error(`asset ${path} is not valid JSON: ${String(e).slice(0, 200)}`);
    return null;
  }
  if (typeof value === "object" && value !== null) {
    if (freezeAllTheWay) deepFreeze(value);
    else Object.freeze(value);
  }
  if (etag && text.length <= CACHE_MAX_ENTRY_CHARS) keep(path, { etag, value, chars: text.length });
  return value as T;
}

const OPTIONAL_COUNTS = [
  "grant_employers", "grant_agreements", "alberta_employers", "carrier_employers", "pending_with_noc",
  "intl_live", "intl_no_lmia", "intl_grade_a", "designated_employers",
] as const;

// The pages read these fields without further checks, so a file without them
// is treated like a missing one.
export async function loadStats(env: Env): Promise<Stats | null> {
  const stats = await loadJson<Stats>(env, "stats.json");
  if (!isObj(stats) || !isObj(stats.counts)) return null;
  // Optional counts: a value that is not a number reads as absent, so it
  // hides the home page's tile or chart instead of failing every page. The
  // loaded file is shared and frozen, so they are dropped from a copy.
  const bad = OPTIONAL_COUNTS.filter((k) => !optional(stats.counts[k], isNum));
  if (bad.length === 0) return stats;
  const counts: Record<string, unknown> = { ...stats.counts };
  for (const k of bad) delete counts[k];
  return { ...stats, counts } as Stats;
}

// The search page's fallback reads the default scope's total and its status
// and province counts, the home page its status-by-province counts; the file
// is also published as is (/api/search/facets), so its whole shape, the long
// scope's block included, is checked. A file that fails reads as missing: the
// search page's fallback then counts from its first rows, the home page
// leaves out the pending-by-province bars.
const isCounts = (v: unknown): boolean => isObj(v) && Object.values(v).every(isNum);

export async function loadFacets(env: Env): Promise<Facets | null> {
  const facets = await loadJson<Facets>(env, "search/facets.json");
  if (!isObj(facets) || !isObj(facets.default) || !isObj(facets.long)) return null;
  const d = facets.default;
  return isNum(d.total) && isCounts(d.status) && isCounts(d.prov) && isCounts(d.status_prov) && isNum(facets.long.total)
    ? facets
    : null;
}

// The hosted search database's rows counted by status, province, stream, year
// and triggered indicators (export_static.write_search_counts). Each value
// is listed once per dimension; a cell is the index of its value in each of
// the five lists, then its row count.
export interface SearchCounts {
  data_as_of: string | null;
  // The latest ESDC period (meta esdc_latest_period, '2026Q1'), whose list
  // rows date=last_quarter keeps; null before any list is loaded.
  latest_period: string | null;
  total: number;
  dims: ["status", "prov", "stream", "year", "ind"];
  values: {
    status: string[];
    prov: (string | null)[];
    stream: (string | null)[];
    year: (number | null)[];
    ind: string[];
  };
  cells: number[][];
}

const COUNT_DIMS = ["status", "prov", "stream", "year", "ind"] as const;
// Far above the about 3,000 cells the data makes, and small enough that a
// damaged file cannot cost a request much to check.
const MAX_COUNT_CELLS = 100_000;
const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;

// The search API sums these cells for its totals, so a file that fails any
// check reads as missing and the API counts in D1 instead (and finds the
// latest period there): every field has its type, the latest period is a
// period as ESDC's lists name it (a year "2015", a quarter "2026Q1" or a
// run of quarters "2017Q1-Q2"), every cell points at listed values, and the
// cells add up to the total.
const PERIOD_RE = /^\d{4}(Q[1-4](-Q[1-4])?)?$/;

export async function loadSearchCounts(env: Env): Promise<SearchCounts | null> {
  const doc = await loadJson<SearchCounts>(env, "search/counts.json");
  if (!isObj(doc) || !isCount(doc.total) || !isStrOrNull(doc.data_as_of)) return null;
  if (!(doc.latest_period === null || (isStr(doc.latest_period) && PERIOD_RE.test(doc.latest_period)))) return null;
  if (!Array.isArray(doc.dims) || doc.dims.join(",") !== COUNT_DIMS.join(",")) return null;
  const v = doc.values;
  if (!isObj(v) || !isListOf(v.status, isStr) || !isListOf(v.prov, isStrOrNull) || !isListOf(v.stream, isStrOrNull) ||
    !isListOf(v.year, (y) => y === null || (isNum(y) && Number.isInteger(y))) || !isListOf(v.ind, isStr)) return null;
  if (!Array.isArray(doc.cells) || doc.cells.length > MAX_COUNT_CELLS) return null;
  const sizes = COUNT_DIMS.map((d) => (v[d] as unknown[]).length);
  let sum = 0;
  for (const cell of doc.cells as unknown[]) {
    if (!Array.isArray(cell) || cell.length !== 6 || !cell.every(isCount)) return null;
    if (!sizes.every((n, i) => cell[i] < n) || cell[5] < 1) return null;
    sum += cell[5];
  }
  return sum === doc.total ? doc : null;
}

// Each field a server-rendered search row shows (SearchRowView), with null
// wherever the export writes it: a posting's missing details, the wage, unit
// and date of a list row, the period of a posting.
const isSearchRow = (r: unknown): boolean => isObj(r) && (r.kind === "posting" || r.kind === "esdc") && isNum(r.ref) &&
  isStr(r.employer_id) && isStr(r.employer) && isStrOrNull(r.job) && isStrOrNull(r.noc) && isStrOrNull(r.street) &&
  isStrOrNull(r.city) && isStrOrNull(r.prov) && isStrOrNull(r.postal) && isNumOrNull(r.wage_min) && isNumOrNull(r.wage_max) &&
  isStrOrNull(r.unit) && isStrOrNull(r.date) && isStrOrNull(r.period) && isNumOrNull(r.positions) && isStr(r.status) &&
  isStr(r.source) && isListOf(r.ind, isStr);

// The newest rows of the default scope: small enough to parse on the server
// (about 150 KB raw for 500 rows) so a plain visit renders without JavaScript.
// A file with an unreadable row reads as missing, and the page leaves the rows
// to the script.
export async function loadFirst(env: Env): Promise<SearchRow[] | null> {
  const rows = await loadJson<SearchRow[]>(env, "search/first.json");
  return isListOf(rows, isSearchRow) ? rows : null;
}

// A profile is checked as the employer page, its description and the response
// form render it: a field the page formats, slices or compares must have that
// type, and null is allowed wherever the export can write it (the nullable
// columns of the tables behind each list, and a list row's publication date
// when its resource is not recorded). The page links to and names itself by
// employer.id, so that must be the id asked for. A profile that fails reads
// as missing: a 404, after the alias lookup.
const EMPLOYER_COUNTS = ["pending_count", "approved_lmias", "approved_positions", "refused_lmias", "refused_positions", "finding_count"] as const;
const isEmployer = (v: unknown, id: string): boolean => isObj(v) && v.id === id && isStr(v.display_name) &&
  isStrOrNull(v.province) && isStrOrNull(v.city) && isStrOrNull(v.postal_code) && isStrOrNull(v.street) &&
  optional(v.street_source, isStrOrNull) && isStr(v.current_status) && isStrOrNull(v.status_changed_at) &&
  EMPLOYER_COUNTS.every((k) => isNum(v[k]));

const FINDING_FIELDS = ["operating_name", "legal_name", "address", "reasons", "decision_date", "penalty", "status"] as const;
const PROFILE_LISTS = ["names", "postings", "esdc", "registry", "indicators", "findings"] as const;
const PROFILE_ROWS: Record<(typeof PROFILE_LISTS)[number], (v: unknown) => boolean> = {
  names: (v) => isObj(v) && isStr(v.name),
  postings: (v) => isObj(v) && isNum(v.posting_id) && isStrOrNull(v.title) && isStrOrNull(v.noc_code) &&
    isNumOrNull(v.wage_min) && isNumOrNull(v.wage_max) && isStrOrNull(v.wage_unit) && isNumOrNull(v.vacancies) &&
    isStrOrNull(v.date_posted) && isStrOrNull(v.valid_through) && isStr(v.first_seen) && isStr(v.last_seen) &&
    isStr(v.flag_current) && isStrOrNull(v.approved_seen_at) && isStr(v.url),
  esdc: (v) => isObj(v) && isStr(v.list) && isStr(v.period) && isStrOrNull(v.stream) && isNumOrNull(v.lmias) &&
    isStrOrNull(v.city) && isStrOrNull(v.postal_code) && isStrOrNull(v.noc_code) && isStrOrNull(v.noc_title) &&
    isNumOrNull(v.positions) && isStr(v.resource_id) && isStrOrNull(v.published),
  registry: (v) => isObj(v) && isStr(v.registry) && isStr(v.registry_id) && isStrOrNull(v.legal_name) &&
    isStrOrNull(v.entity_type) && isStrOrNull(v.status) && isStrOrNull(v.registered_on) && isStr(v.grade),
  indicators: (v) => isObj(v) && isStr(v.indicator) && isStr(v.state) && isStr(v.basis),
  findings: (v) => isObj(v) && FINDING_FIELDS.every((k) => isStrOrNull(v[k])),
};

// The public-record lists, checked the same way: every field the employer
// page formats or links with, null where the export can write it.
const PUBLIC_LISTS = ["grants", "alberta", "us_carrier"] as const;
const isMatch = (v: Record<string, any>): boolean => isStr(v.grade) && isStr(v.basis);
const PUBLIC_ROWS: Record<(typeof PUBLIC_LISTS)[number], (v: unknown) => boolean> = {
  grants: (v) => isObj(v) && isMatch(v) && isStr(v.ref_number) && isNum(v.amendment_number) && isStr(v.owner_org) &&
    isStrOrNull(v.department_en) && isStrOrNull(v.department_fr) && isStrOrNull(v.program_en) &&
    isStrOrNull(v.program_fr) && isStrOrNull(v.agreement_type) && isNumOrNull(v.agreement_value) &&
    isStrOrNull(v.start_date) && isStrOrNull(v.end_date),
  alberta: (v) => isObj(v) && isMatch(v) && isStr(v.emp_key) && isNum(v.year) && isNumOrNull(v.first_year) &&
    isStr(v.employer_name) && isStrOrNull(v.trade_name) && isStrOrNull(v.city) && isStrOrNull(v.industry) &&
    isNumOrNull(v.person_years) && isNumOrNull(v.lost_time_claims) && isNumOrNull(v.lost_time_rate) &&
    isNumOrNull(v.disabling_injuries) && isNumOrNull(v.disabling_rate) && isNumOrNull(v.fatalities) &&
    isNumOrNull(v.cor_year),
  us_carrier: (v) => isObj(v) && isMatch(v) && isNum(v.dot_number) && isStr(v.legal_name) && isStrOrNull(v.dba_name) &&
    isStrOrNull(v.city) && isStrOrNull(v.province) && isStrOrNull(v.postal_code) && isStrOrNull(v.status) &&
    isNumOrNull(v.power_units) && isNumOrNull(v.drivers) && isStrOrNull(v.safety_rating) &&
    isStrOrNull(v.safety_rating_date) && isStrOrNull(v.record_date),
};

// Postings open to international candidates and designated-employer listings,
// checked like the public records. Every link is held to the host it must
// come from, since the page renders it as an href.
const JOBBANK_POSTING = /^https:\/\/www\.jobbank\.gc\.ca\/jobsearch\/jobposting\/\d+$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+\.[a-z]{2,}(\/[^\s"<>]*)?$/;
const isIntlPosting = (v: unknown): boolean => isObj(v) && isNum(v.id) && isStrOrNull(v.title) && isStrOrNull(v.noc) &&
  isStrOrNull(v.city) && isStrOrNull(v.prov) && isStr(v.date) && typeof v.live === "boolean" && isStr(v.lmia) &&
  (v.grade === null || v.grade === "A" || v.grade === "B" || v.grade === "C") && isListOf(v.reasons, isStr) &&
  isStr(v.url) && JOBBANK_POSTING.test(v.url);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDesignated = (v: unknown): boolean => isObj(v) && isMatch(v) && isStr(v.list) && isStr(v.program) &&
  isStr(v.jurisdiction) && isStrOrNull(v.community) && isStr(v.name) && isStrOrNull(v.location) &&
  isStrOrNull(v.designated_on) && isStr(v.first_seen) && isStr(v.last_seen) && typeof v.current === "boolean" &&
  isStr(v.url) && HTTPS_URL.test(v.url) &&
  (v.snapshot === undefined || (isObj(v.snapshot) && isStr(v.snapshot.list_date) && ISO_DAY.test(v.snapshot.list_date) &&
    isStr(v.snapshot.loaded_on) && ISO_DAY.test(v.snapshot.loaded_on)));

// Each is rendered as a link, so the id must be an employer id.
const isRelated = (v: unknown): boolean => isObj(v) && isStr(v.id) && EMPLOYER_ID_RE.test(v.id) && isStr(v.name) &&
  optional(v.city, isStr);

// Rows of one list with no LMIA count (from ESDC files that carry positions
// only, 2014 through 2021 Q3). Each such row is at least one LMIA, so the
// employer page and its description show the sum plus these rows as a floor.
export function lmiaGap(esdc: Profile["esdc"], list: "positive" | "negative" = "positive"): number {
  return esdc.filter((r) => r.list === list && r.lmias === null).length;
}

export async function loadProfile(env: Env, id: string): Promise<Profile | null> {
  if (!EMPLOYER_ID_RE.test(id)) return null;
  const shard = await loadJson<Record<string, Profile>>(env, `profiles/${id.slice(4, 7)}.json`);
  const profile: unknown = isObj(shard) ? shard[id] : null;
  if (!isObj(profile) || !isEmployer(profile.employer, id)) return null;
  if (!PROFILE_LISTS.every((k) => isListOf(profile[k], PROFILE_ROWS[k]))) return null;
  // Absent (a shard from before these sources) reads as none; present, a list
  // must be readable whole, like the lists above.
  if (!PUBLIC_LISTS.every((k) => optional(profile[k], (v) => isListOf(v, PUBLIC_ROWS[k])))) return null;
  if (!optional(profile.grants_total, isNum)) return null;
  if (!optional(profile.intl, (v) => isListOf(v, isIntlPosting)) || !optional(profile.designated, (v) => isListOf(v, isDesignated))) {
    return null;
  }
  // The shard is shared and frozen, so the lists filled in go on a copy.
  const grants: unknown[] = profile.grants ?? [];
  return {
    ...profile,
    grants,
    alberta: profile.alberta ?? [],
    us_carrier: profile.us_carrier ?? [],
    intl: profile.intl ?? [],
    designated: profile.designated ?? [],
    // Links to other profiles, not records of this one: a list that does not
    // read is left off rather than taking the profile down with it.
    related: isListOf(profile.related, isRelated) ? profile.related : [],
    // The count of agreements is never below the agreements listed.
    grants_total: Math.max(profile.grants_total ?? 0, grants.length),
  } as unknown as Profile;
}

// The id that took a retired employer id's records (ids change when employer
// matching changes), from a shard keyed like the profiles by the old id. A
// missing or unreadable shard, or an entry that is not an employer id, reads
// as no alias. The value goes into a Location header, so it must be an id: a
// stray character there would make the redirect itself fail. An entry
// pointing at itself would redirect forever, so it counts as none.
export async function loadAlias(env: Env, id: string): Promise<string | null> {
  if (!EMPLOYER_ID_RE.test(id)) return null;
  const shard = await loadJson<Record<string, unknown>>(env, `aliases/${id.slice(4, 7)}.json`);
  const live: unknown = isObj(shard) ? shard[id] : null;
  return typeof live === "string" && EMPLOYER_ID_RE.test(live) && live !== id ? live : null;
}
