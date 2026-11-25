// One page per ESDC release (/releases/2026-q1) and the list of releases
// (/releases). Each page reads one small JSON file the nightly export writes
// (releases/<slug>.json, at most about 15 KB) and renders it as it stands: the
// pipeline has already ranked and cut every table, so the Worker only loops
// over the few dozen rows it shows. The shared pieces (the caveat, the
// breadcrumb data, the province and stream names) are used by rankings.tsx too.

import type { Context } from "hono";
import type { FC } from "hono/jsx";
import { loadJson, loadStats } from "../data";
import type { AppEnv, Env } from "../env";
import { fmtInt, periodLabel, provinceName, streamLabel, t, tj, type Key, type Lang } from "../i18n";
import { Badge, Layout, noDataPage, page } from "../layout";
import { DESCRIPTION_MAX, SOCIAL_CARD, absoluteUrl, pageTitle, type Seo } from "../seo";
import { ESDC_HISTORY_START_YEAR } from "../support";
import { isBool, isListOf, isNum, isNumOrNull, isObj, isStr, isStrOrNull, optional } from "../valid";

export interface Breakdown {
  k: string;
  rows: number;
  positions: number;
  employers?: number;
}

interface StreamBlock {
  shown: boolean;
  missing_share: number;
  rows: Breakdown[];
}

interface Totals {
  positive_rows: number;
  positions: number;
  lmias: number | null;
  employers: number;
  negative_rows: number;
  negative_positions: number;
  negative_lmias: number | null;
  negative_employers: number;
}

interface ReleaseEmployer {
  id: string;
  name: string;
  city: string | null;
  prov: string | null;
  stream: string | null;
  positions: number;
  rows: number;
  prev?: number;
  change?: number;
}

interface Source {
  dataset: string;
  name: string;
  url: string;
  page: string;
  published: string | null;
  sha256: string;
  bytes: number;
  rows: number;
  mirror: string | null;
}

export interface Release {
  period: string;
  slug: string;
  quarters: number;
  published: string | null;
  first: boolean;
  prev: { period: string; slug: string; quarters: number; totals: Totals } | null;
  next: { period: string; slug: string } | null;
  totals: Totals;
  top: ReleaseEmployer[];
  new: { count: number; positions: number; top: ReleaseEmployer[] } | null;
  changes: { up: ReleaseEmployer[]; down: ReleaseEmployer[] } | null;
  approvals: { prov: Breakdown[]; stream: StreamBlock };
  refusals: { prov: Breakdown[]; stream: StreamBlock };
  sources: Source[];
}

interface ReleaseIndex {
  releases: {
    period: string; slug: string; quarters: number; published: string | null; positive_rows: number; positions: number;
    employers: number; negative_rows: number; negative_positions: number;
  }[];
}

// The period as the data writes it, in lower case with a hyphen after the year.
export const RELEASE_SLUG_RE = /^\d{4}(?:-q[1-4](?:-q[1-4])?)?$/;

// A file is checked field by field as the page reads it, and one that fails
// is treated like a missing one (a 404). prev, new and changes are null for
// the first release, never absent.

// lmias is null for a file that carries no LMIA counts.
const isTotals = (v: unknown): v is Totals => isObj(v) && isNumOrNull(v.lmias) &&
  (["positive_rows", "positions", "employers", "negative_rows", "negative_positions", "negative_employers"] as const).every((k) => isNum(v[k]));

export const isBreakdownRow = (v: unknown): v is Breakdown =>
  isObj(v) && isStr(v.k) && isNum(v.rows) && isNum(v.positions) && optional(v.employers, isNum);

const isEmployer = (v: unknown): v is ReleaseEmployer => isObj(v) && isStr(v.id) && isStr(v.name) && isStrOrNull(v.city) &&
  isStrOrNull(v.prov) && isStrOrNull(v.stream) && isNum(v.positions);

// The change tables print both figures, so a row without them is unreadable.
const isChange = (v: unknown): boolean => isEmployer(v) && isNum(v.prev) && isNum(v.change);

const isBlock = (v: unknown): boolean => isObj(v) && isListOf(v.prov, isBreakdownRow) && isObj(v.stream) &&
  isBool(v.stream.shown) && isListOf(v.stream.rows, isBreakdownRow);

const isSource = (v: unknown): v is Source => isObj(v) && isStr(v.dataset) && isStr(v.name) && isStr(v.url) && isStr(v.page) &&
  isStrOrNull(v.published) && isStr(v.sha256) && isNum(v.rows) && isStrOrNull(v.mirror);

function isRelease(v: unknown): v is Release {
  return isObj(v) && isStr(v.period) && isStr(v.slug) && isNum(v.quarters) && isStrOrNull(v.published) && isTotals(v.totals) &&
    (v.prev === null || (isObj(v.prev) && isStr(v.prev.period) && isStr(v.prev.slug) && isNum(v.prev.quarters) && isTotals(v.prev.totals))) &&
    (v.next === null || (isObj(v.next) && isStr(v.next.period) && isStr(v.next.slug))) &&
    isListOf(v.top, isEmployer) &&
    (v.new === null || (isObj(v.new) && isNum(v.new.count) && isNum(v.new.positions) && isListOf(v.new.top, isEmployer))) &&
    (v.changes === null || (isObj(v.changes) && isListOf(v.changes.up, isChange) && isListOf(v.changes.down, isChange))) &&
    isBlock(v.approvals) && isBlock(v.refusals) && isListOf(v.sources, isSource);
}

const isIndexRow = (v: unknown): boolean => isObj(v) && isStr(v.period) && isStr(v.slug) && isStrOrNull(v.published) &&
  isNum(v.positive_rows) && isNum(v.positions) && isNum(v.employers) && isNum(v.negative_rows);

const isReleaseIndex = (v: unknown): v is ReleaseIndex => isObj(v) && isListOf(v.releases, isIndexRow);

export async function loadRelease(env: Env, slug: string): Promise<Release | null> {
  if (!RELEASE_SLUG_RE.test(slug)) return null;
  const data = await loadJson<unknown>(env, `releases/${slug}.json`);
  return isRelease(data) ? data : null;
}

// -- shared with rankings.tsx -----------------------------------------------------

export function provLabel(lang: Lang, code: string): string {
  return code === "UN" ? t(lang, "rel.not_recorded") : provinceName(lang, code);
}

export function streamName(lang: Lang, key: string): string {
  return key === "Other" ? t(lang, "rel.stream_other") : streamLabel(lang, key);
}

// "Kelowna, BC"; a head office outside Canada is named, not coded XX.
export function place(lang: Lang, city: string | null, prov: string | null): string {
  return [city, prov === "XX" ? provinceName(lang, "XX") : prov].filter(Boolean).join(", ");
}

// +626, −515 (a minus sign, not a hyphen), 0.
export function signed(n: number, lang: Lang): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtInt(Math.abs(n), lang)}`;
}

// Every release and ranking page carries the methodology's two cautions.
export const Caveat: FC<{ lang: Lang }> = ({ lang }) => (
  <section class="panel" aria-labelledby="caveat">
    <h2 id="caveat">{t(lang, "rel.caveat_title")}</h2>
    <p>{t(lang, "rel.caveat_positions")}</p>
    <p>{t(lang, "rel.caveat_leaders")}</p>
  </section>
);

// Mirrors the visible trail; the last crumb is the page itself, with no link,
// as on the profile pages.
export function breadcrumbJsonLd(trail: { name: string; path?: string }[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      ...(crumb.path ? { item: absoluteUrl(crumb.path) } : {}),
    })),
  };
}

export const Breadcrumb: FC<{ lang: Lang; trail: { name: string; path?: string }[] }> = ({ lang, trail }) => (
  <nav aria-label={t(lang, "employer.breadcrumb")} class="breadcrumb">
    {trail.map((crumb, i) => (
      <>
        {i > 0 ? " / " : ""}
        {crumb.path ? <a href={crumb.path}>{crumb.name}</a> : crumb.name}
      </>
    ))}
  </nav>
);

// The first candidate that fits a result list's length.
export function fitDescription(candidates: string[]): string {
  const fit = candidates.find((s) => s.length <= DESCRIPTION_MAX);
  return fit ?? `${candidates[candidates.length - 1].slice(0, DESCRIPTION_MAX - 1).replace(/\s+\S*$/, "")}…`;
}

// Province or stream counts in two number columns: positions and employers
// for approvals, rows and positions requested for refusals. Three columns fit
// a phone, so the table keeps its shape rather than restacking.
export type Column = { key: "rows" | "positions" | "employers"; head: Key };
export const APPROVAL_COLUMNS: Column[] = [{ key: "positions", head: "col.positions" }, { key: "employers", head: "rel.col_employers" }];
export const REFUSAL_COLUMNS: Column[] = [{ key: "rows", head: "rel.col_rows" }, { key: "positions", head: "rel.col_requested" }];

export const BreakdownTable: FC<{
  lang: Lang;
  rows: Breakdown[];
  label: (k: string) => string;
  head: Key;
  cols: Column[];
}> = ({ lang, rows, label, head, cols }) => (
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>{t(lang, head)}</th>
          {cols.map((col) => <th class="num">{t(lang, col.head)}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <td>{label(r.k)}</td>
            {cols.map((col) => <td class="mono num">{fmtInt(r[col.key] ?? 0, lang)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// -- the release list ----------------------------------------------------------------

// Exported for the head a link preview gets (preview.ts).
export function releasesIndexSeo(lang: Lang): Seo {
  const title = t(lang, "rel.index_title");
  return {
    path: "/releases",
    title: pageTitle(title),
    socialTitle: title,
    description: t(lang, "rel.seo_index_desc", { start: ESDC_HISTORY_START_YEAR }),
    image: SOCIAL_CARD,
    jsonLd: [breadcrumbJsonLd([{ name: t(lang, "common.home"), path: "/" }, { name: t(lang, "rel.crumb") }])],
  };
}

export async function releasesIndexPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const [stats, index] = await Promise.all([loadStats(c.env), loadJson<unknown>(c.env, "releases/index.json")]);
  if (!isReleaseIndex(index)) return noDataPage(c, "rel.index_title");
  const n = (v: number) => fmtInt(v, lang);
  const title = t(lang, "rel.index_title");
  const seo = releasesIndexSeo(lang);
  return page(
    c,
    <Layout lang={lang} title={title} dataAsOf={stats?.data_as_of ?? null} seo={seo}>
      <Breadcrumb lang={lang} trail={[{ name: t(lang, "common.home"), path: "/" }, { name: t(lang, "rel.crumb") }]} />
      <h1>{title}</h1>
      <p class="lead">{t(lang, "rel.index_lead")}</p>
      <p><a href="/rankings">{t(lang, "rel.rankings_link")}</a></p>
      <p><a href="/trends">{t(lang, "trends.releases_link")}</a></p>
      <Caveat lang={lang} />
      <h2>{t(lang, "rel.index_title")}</h2>
      <div class="table-wrap">
        <table class="restack">
          <thead>
            <tr>
              <th>{t(lang, "rel.col_release")}</th>
              <th>{t(lang, "rel.col_published")}</th>
              <th class="num">{t(lang, "rel.col_positive_rows")}</th>
              <th class="num">{t(lang, "col.positions")}</th>
              <th class="num">{t(lang, "rel.col_employers")}</th>
              <th class="num">{t(lang, "rel.col_negative_rows")}</th>
            </tr>
          </thead>
          <tbody>
            {index.releases.map((r) => (
              <tr>
                <td data-label={t(lang, "rel.col_release")}>
                  <a href={`/releases/${r.slug}`}>{periodLabel(r.period, lang)}</a>
                </td>
                <td data-label={t(lang, "rel.col_published")} class="mono">{r.published ?? ""}</td>
                <td data-label={t(lang, "rel.col_positive_rows")} class="mono num">{n(r.positive_rows)}</td>
                <td data-label={t(lang, "col.positions")} class="mono num">{n(r.positions)}</td>
                <td data-label={t(lang, "rel.col_employers")} class="mono num">{n(r.employers)}</td>
                <td data-label={t(lang, "rel.col_negative_rows")} class="mono num">{n(r.negative_rows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted small top-gap">{t(lang, "rel.index_early")}</p>
    </Layout>,
  );
}

// -- one release ---------------------------------------------------------------------

const TOTAL_ROWS: [Key, keyof Totals][] = [
  ["rel.row_positive_rows", "positive_rows"],
  ["rel.row_positions", "positions"],
  ["rel.row_lmias", "lmias"],
  ["rel.row_employers", "employers"],
  ["rel.row_negative_rows", "negative_rows"],
  ["rel.row_negative_positions", "negative_positions"],
  ["rel.row_negative_employers", "negative_employers"],
];

function releaseSeo(rel: Release, lang: Lang): Seo {
  const period = periodLabel(rel.period, lang);
  const vars = {
    period,
    rows: fmtInt(rel.totals.positive_rows, lang),
    positions: fmtInt(rel.totals.positions, lang),
    refused: fmtInt(rel.totals.negative_rows, lang),
  };
  const title = t(lang, "rel.seo_title", { period });
  return {
    path: `/releases/${rel.slug}`,
    title: pageTitle(title),
    socialTitle: title,
    description: fitDescription([t(lang, "rel.seo_desc", vars), t(lang, "rel.seo_desc_short", vars)]),
    image: SOCIAL_CARD,
    jsonLd: [breadcrumbJsonLd([
      { name: t(lang, "common.home"), path: "/" },
      { name: t(lang, "rel.crumb"), path: "/releases" },
      { name: period },
    ])],
  };
}

export async function releasePage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const slug = c.req.param("slug") ?? "";
  const [stats, rel] = await Promise.all([loadStats(c.env), loadRelease(c.env, slug)]);
  if (!rel) {
    if (!stats) return noDataPage(c, "rel.index_title");
    return page(
      c,
      <Layout lang={lang} title={t(lang, "rel.not_found")} dataAsOf={stats.data_as_of}>
        <h1>{t(lang, "rel.not_found")}</h1>
        <p>{tj(lang, "rel.not_found_text", { all: <a href="/releases">{t(lang, "rel.not_found_link")}</a> })}</p>
      </Layout>,
      404,
    );
  }
  const n = (v: number | null | undefined) => fmtInt(v, lang);
  const na = t(lang, "common.na");
  const period = periodLabel(rel.period, lang);
  const prev = rel.prev;
  const prevLabel = prev ? periodLabel(prev.period, lang) : "";
  const enOnly = lang === "fr" ? "en" : undefined;

  const EmployerTable = ({ rows }: { rows: ReleaseEmployer[] }) => (
    <div class="table-wrap">
      <table class="restack">
        <thead>
          <tr>
            <th class="num">{t(lang, "rank.col_rank")}</th>
            <th>{t(lang, "col.employer")}</th>
            <th>{t(lang, "col.location")}</th>
            <th>{t(lang, "col.stream")}</th>
            <th class="num">{t(lang, "col.positions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr>
              <td data-label={t(lang, "rank.col_rank")} class="mono num">{n(i + 1)}</td>
              <td data-label={t(lang, "col.employer")}><a href={`/employers/${r.id}`}>{r.name}</a></td>
              <td data-label={t(lang, "col.location")}>{place(lang, r.city, r.prov)}</td>
              <td data-label={t(lang, "col.stream")}>{r.stream ? streamName(lang, r.stream) : ""}</td>
              <td data-label={t(lang, "col.positions")} class="mono num">{n(r.positions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const ChangeTable = ({ rows }: { rows: ReleaseEmployer[] }) =>
    rows.length === 0 ? (
      <p class="muted">{t(lang, "rel.none")}</p>
    ) : (
      <div class="table-wrap">
        <table class="restack">
          <thead>
            <tr>
              <th>{t(lang, "col.employer")}</th>
              <th>{t(lang, "col.location")}</th>
              <th class="num">{t(lang, "rel.col_before")}</th>
              <th class="num">{t(lang, "rel.col_this")}</th>
              <th class="num">{t(lang, "rel.col_change")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td data-label={t(lang, "col.employer")}><a href={`/employers/${r.id}`}>{r.name}</a></td>
                <td data-label={t(lang, "col.location")}>{place(lang, r.city, r.prov)}</td>
                <td data-label={t(lang, "rel.col_before")} class="mono num">{n(r.prev)}</td>
                <td data-label={t(lang, "rel.col_this")} class="mono num">{n(r.positions)}</td>
                <td data-label={t(lang, "rel.col_change")} class="mono num">{signed(r.change ?? 0, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  const StreamTable = ({ block, cols }: { block: StreamBlock; cols: Column[] }) =>
    block.shown ? (
      <BreakdownTable lang={lang} rows={block.rows} label={(k) => streamName(lang, k)} head="col.stream" cols={cols} />
    ) : (
      <p class="muted">{t(lang, "rel.stream_missing")}</p>
    );

  const trail = [
    { name: t(lang, "common.home"), path: "/" },
    { name: t(lang, "rel.crumb"), path: "/releases" },
    { name: period },
  ];
  const totalRows = TOTAL_ROWS.filter(([, k]) => k !== "lmias" || rel.totals.lmias !== null || prev?.totals.lmias != null);

  return page(
    c,
    <Layout lang={lang} title={t(lang, "rel.h1", { period })} dataAsOf={stats?.data_as_of ?? null} seo={releaseSeo(rel, lang)}>
      <Breadcrumb lang={lang} trail={trail} />
      <h1>{t(lang, "rel.h1", { period })}</h1>
      <p class="lead">
        {rel.published ? t(lang, "rel.lead", { period, date: rel.published }) : t(lang, "rel.lead_undated", { period })}
      </p>
      {rel.period === "2014" ? (
        <p class="muted">{t(lang, "rel.span_2014")}</p>
      ) : rel.quarters > 1 ? (
        <p class="muted">{t(lang, "rel.span_many", { n: rel.quarters })}</p>
      ) : null}
      <div class="quick-links">
        {prev ? <a href={`/releases/${prev.slug}`}>{t(lang, "rel.prev_link", { period: prevLabel })}</a> : null}
        {rel.next ? <a href={`/releases/${rel.next.slug}`}>{t(lang, "rel.next_link", { period: periodLabel(rel.next.period, lang) })}</a> : null}
        <a href="/releases">{t(lang, "rel.all_link")}</a>
        <a href="/rankings">{t(lang, "rank.title")}</a>
      </div>

      <section class="tiles" aria-label={t(lang, "rel.totals")}>
        <div class="tile">
          <Badge status="approved" lang={lang} />
          <span class="tile-value">{n(rel.totals.positions)}</span>
          <span class="tile-note">{t(lang, "rel.row_positions")}</span>
        </div>
        <div class="tile">
          <Badge status="approved" lang={lang} />
          <span class="tile-value">{n(rel.totals.positive_rows)}</span>
          <span class="tile-note">{t(lang, "rel.row_positive_rows")}</span>
        </div>
        <div class="tile">
          <Badge status="refused" lang={lang} />
          <span class="tile-value">{n(rel.totals.negative_rows)}</span>
          <span class="tile-note">{t(lang, "rel.row_negative_rows")}</span>
        </div>
      </section>

      <Caveat lang={lang} />

      <h2>{t(lang, "rel.totals")}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th><span class="visually-hidden">{t(lang, "rel.totals")}</span></th>
              <th class="num">{t(lang, "rel.col_this")}</th>
              {prev ? <th class="num">{t(lang, "rel.col_prev", { period: prevLabel })}</th> : null}
              {prev ? <th class="num">{t(lang, "rel.col_change")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {totalRows.map(([label, key]) => {
              const now = rel.totals[key];
              const before = prev ? prev.totals[key] : null;
              return (
                <tr>
                  <td>{t(lang, label)}</td>
                  <td data-label={t(lang, "rel.col_this")} class="mono num">{now === null ? na : n(now)}</td>
                  {prev ? <td data-label={t(lang, "rel.col_prev", { period: prevLabel })} class="mono num">{before === null ? na : n(before)}</td> : null}
                  {prev ? (
                    <td data-label={t(lang, "rel.col_change")} class="mono num">
                      {now === null || before === null ? "" : signed(now - before, lang)}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {prev && prev.quarters !== rel.quarters ? (
        <p class="muted small top-gap">{t(lang, "rel.span_differs", { prev: prev.quarters, n: rel.quarters })}</p>
      ) : null}

      <h2>{t(lang, "rel.top")}</h2>
      <p class="muted small">{t(lang, "rel.top_note")}</p>
      <EmployerTable rows={rel.top} />

      <h2>{t(lang, "rel.new")}</h2>
      {rel.new ? (
        <>
          <p>{t(lang, "rel.new_text", { n: n(rel.new.count), positions: n(rel.new.positions) })}</p>
          <p class="muted small">{t(lang, "rel.new_note")}</p>
          {rel.new.top.length ? <EmployerTable rows={rel.new.top} /> : null}
        </>
      ) : (
        <p class="muted">{t(lang, "rel.new_first")}</p>
      )}

      {rel.changes && prev ? (
        <>
          <h2>{t(lang, "rel.changes", { period: prevLabel })}</h2>
          <p class="muted small">{t(lang, "rel.changes_note")}</p>
          <h3>{t(lang, "rel.increases")}</h3>
          <ChangeTable rows={rel.changes.up} />
          <h3>{t(lang, "rel.decreases")}</h3>
          <ChangeTable rows={rel.changes.down} />
        </>
      ) : null}

      <h2>{t(lang, "rel.approvals_by")}</h2>
      <div class="two-col">
        <div>
          <BreakdownTable lang={lang} rows={rel.approvals.prov} label={(k) => provLabel(lang, k)} head="rel.col_province" cols={APPROVAL_COLUMNS} />
        </div>
        <div>
          <StreamTable block={rel.approvals.stream} cols={APPROVAL_COLUMNS} />
        </div>
      </div>

      <h2>{t(lang, "rel.refusals_by")}</h2>
      <p>
        <Badge status="refused" lang={lang} />{" "}
        {tj(lang, "rel.refusals_note", {
          source: t(lang, "rel.negative_list"),
          methodology: <a href="/methodology#status">{t(lang, "rel.methodology_link")}</a>,
        })}
      </p>
      <div class="two-col">
        <div>
          <BreakdownTable lang={lang} rows={rel.refusals.prov} label={(k) => provLabel(lang, k)} head="rel.col_province" cols={REFUSAL_COLUMNS} />
        </div>
        <div>
          <StreamTable block={rel.refusals.stream} cols={REFUSAL_COLUMNS} />
        </div>
      </div>

      <h2>{t(lang, "rel.sources")}</h2>
      <p class="muted small">
        {tj(lang, "rel.sources_note", { sums: <a href="/downloads/mirror/SHA256SUMS" class="mono">SHA256SUMS</a> })}
      </p>
      <div class="table-wrap">
        <table class="restack">
          <thead>
            <tr>
              <th>{t(lang, "data.col_list")}</th>
              <th>{t(lang, "rel.col_file")}</th>
              <th>{t(lang, "rel.col_published")}</th>
              <th class="num">{t(lang, "rel.col_rows")}</th>
              <th>{t(lang, "rel.col_download")}</th>
              <th>{t(lang, "rel.col_checksum")}</th>
            </tr>
          </thead>
          <tbody>
            {rel.sources.map((s) => (
              <tr>
                <td data-label={t(lang, "data.col_list")}>{t(lang, s.dataset === "positive" ? "rel.list.positive" : "rel.list.negative")}</td>
                <td data-label={t(lang, "rel.col_file")}>
                  <a href={s.page} rel="nofollow noopener" lang={enOnly}>{s.name}</a>
                </td>
                <td data-label={t(lang, "rel.col_published")} class="mono">{s.published ?? ""}</td>
                <td data-label={t(lang, "rel.col_rows")} class="mono num">{n(s.rows)}</td>
                <td data-label={t(lang, "rel.col_download")}>
                  {/* One child, so a restacked row keeps both links in its value column. */}
                  <span>
                    <a href={s.url} rel="nofollow noopener">{t(lang, "rel.esdc_file")}</a>
                    {s.mirror ? <>{", "}<a href={`/downloads/mirror/${s.mirror}`} rel="nofollow">{t(lang, "rel.mirror_copy")}</a></> : null}
                  </span>
                </td>
                <td data-label={t(lang, "rel.col_checksum")} class="mono">
                  <span class="id" title={s.sha256}>{`${s.sha256.slice(0, 12)}…`}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
}
