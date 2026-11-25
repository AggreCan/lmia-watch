// Rankings of approved positions: /rankings for all years together and
// /rankings/<year> for one calendar year. Each page reads one file the
// nightly export writes (rankings/all.json or rankings/<year>.json, about
// 10 KB), already ranked and cut to the rows shown. Occupations are ranked
// separately for NOC 2011 and NOC 2021, which do not match code for code.

import type { Context } from "hono";
import { loadJson, loadStats } from "../data";
import type { AppEnv } from "../env";
import { decimal, fmtInt, periodLabel, t, tj, type Key, type Lang } from "../i18n";
import { Layout, noDataPage, page } from "../layout";
import { SOCIAL_CARD, pageTitle, type Seo } from "../seo";
import { ESDC_HISTORY_START_YEAR } from "../support";
import { isBool, isListOf, isNum, isObj, isStr, isStrOrNull, optional } from "../valid";
import {
  Breadcrumb, type Breakdown, Caveat, breadcrumbJsonLd, fitDescription, isBreakdownRow, place, provLabel, streamName,
} from "./releases";

interface Ranking {
  scope: string;
  years: number[];
  periods: string[];
  totals: { positions: number; rows: number; employers: number };
  provinces: Breakdown[];
  streams: { shown: boolean; missing_share: number; years: number[]; positions?: number; rows: Breakdown[] };
  occupations: {
    era: string; periods: string[]; codes: number; positions: number;
    rows: { code: string; title: string | null; positions: number; rows: number }[];
  }[];
  no_occupation_periods: string[];
  employers: { id: string; name: string; city: string | null; prov: string | null; positions: number; rows: number }[];
}

const YEAR_RE = /^\d{4}$/;
// A list of more periods than this is written as a range.
const LIST_PERIODS = 4;

// A file is checked field by field as the page reads it; one that fails reads
// as missing ("not published" for all years, a 404 for one year).
const isOccupationRow = (v: unknown): boolean =>
  isObj(v) && isStr(v.code) && isStrOrNull(v.title) && isNum(v.positions) && isNum(v.rows);

const isEra = (v: unknown): boolean => isObj(v) && isStr(v.era) && isListOf(v.periods, isStr) && isNum(v.codes) &&
  isNum(v.positions) && isListOf(v.rows, isOccupationRow);

const isRankedEmployer = (v: unknown): boolean => isObj(v) && isStr(v.id) && isStr(v.name) && isStrOrNull(v.city) &&
  isStrOrNull(v.prov) && isNum(v.positions) && isNum(v.rows);

// The stream years are read only when the table is shown, but the export
// writes the list (empty) either way.
const isStreams = (v: unknown): boolean => isObj(v) && isBool(v.shown) && isListOf(v.years, isNum) &&
  optional(v.positions, isNum) && isListOf(v.rows, isBreakdownRow);

function isRanking(v: unknown): v is Ranking {
  return isObj(v) && isListOf(v.years, isNum) && isListOf(v.periods, isStr) &&
    isObj(v.totals) && isNum(v.totals.positions) && isNum(v.totals.rows) && isNum(v.totals.employers) &&
    isListOf(v.provinces, isBreakdownRow) && isStreams(v.streams) && isListOf(v.occupations, isEra) &&
    isListOf(v.no_occupation_periods, isStr) && isListOf(v.employers, isRankedEmployer);
}

function share(part: number, whole: number, lang: Lang): string {
  const pct = whole > 0 ? (100 * part) / whole : 0;
  if (pct > 0 && pct < 0.05) return t(lang, "rank.percent_small");
  return t(lang, "rank.percent", { n: decimal(lang, pct.toFixed(1)) });
}

// "2014 and 2015", "2014, 2015 and 2016".
function joinList(parts: string[], lang: Lang): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${t(lang, "rank.and")} ${parts[parts.length - 1]}`;
}

function periodsText(periods: string[], lang: Lang): string {
  if (periods.length === 0) return "";
  if (periods.length > LIST_PERIODS) {
    return t(lang, "rank.covers_range", {
      n: fmtInt(periods.length, lang),
      first: periodLabel(periods[0], lang),
      last: periodLabel(periods[periods.length - 1], lang),
    });
  }
  return t(lang, "rank.covers_list", { periods: periods.map((p) => periodLabel(p, lang)).join(", ") });
}

// Exported for the head a link preview gets (preview.ts).
export function rankingSeo(year: string | null, lang: Lang): Seo {
  const title = year ? t(lang, "rank.seo_title_year", { year }) : t(lang, "rank.seo_title_all");
  const crumbs = [{ name: t(lang, "common.home"), path: "/" }, ...(year ? [{ name: t(lang, "rank.title"), path: "/rankings" }, { name: year }] : [{ name: t(lang, "rank.title") }])];
  return {
    path: year ? `/rankings/${year}` : "/rankings",
    title: pageTitle(title),
    socialTitle: title,
    description: fitDescription([
      year ? t(lang, "rank.seo_desc_year", { year }) : t(lang, "rank.seo_desc_all", { start: ESDC_HISTORY_START_YEAR }),
    ]),
    image: SOCIAL_CARD,
    jsonLd: [breadcrumbJsonLd(crumbs)],
  };
}

export async function rankingsPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const param = c.req.param("year");
  const year = param && YEAR_RE.test(param) ? param : null;
  const file = param === undefined ? "rankings/all.json" : year ? `rankings/${year}.json` : null;
  const [stats, data] = await Promise.all([loadStats(c.env), file ? loadJson<unknown>(c.env, file) : Promise.resolve(null)]);
  if (!isRanking(data)) {
    if (!stats || param === undefined) return noDataPage(c, "rank.title");
    return page(
      c,
      <Layout lang={lang} title={t(lang, "rank.not_found")} dataAsOf={stats.data_as_of}>
        <h1>{t(lang, "rank.not_found")}</h1>
        <p>{tj(lang, "rank.not_found_text", { rankings: <a href="/rankings">{t(lang, "rank.page_link")}</a> })}</p>
      </Layout>,
      404,
    );
  }
  const r = data;
  const n = (v: number | null | undefined) => fmtInt(v, lang);
  const enOnly = lang === "fr" ? "en" : undefined;
  const h1 = year ? t(lang, "rank.h1_year", { year }) : t(lang, "rank.h1_all");
  const trail = [{ name: t(lang, "common.home"), path: "/" }, ...(year ? [{ name: t(lang, "rank.title"), path: "/rankings" }, { name: year }] : [{ name: t(lang, "rank.title") }])];
  const last = r.periods[r.periods.length - 1] ?? "";
  // A year is complete once its fourth-quarter list is out; the annual files end in Q4 by definition.
  const partial = year !== null && /Q[1-3]$/.test(last);
  // Shares of the whole scope; the stream table covers only the years it names.
  const provinceTotal = r.totals.positions;
  const streamTotal = r.streams.positions ?? r.streams.rows.reduce((sum, p) => sum + p.positions, 0);

  const ShareTable = ({ rows, label, head, total }: { rows: Breakdown[]; label: (k: string) => string; head: Key; total: number }) => (
    <div class="table-wrap">
      <table class="restack restack-compact">
        <thead>
          <tr>
            <th class="num">{t(lang, "rank.col_rank")}</th>
            <th>{t(lang, head)}</th>
            <th class="num">{t(lang, "col.positions")}</th>
            <th class="num">{t(lang, "rank.col_share")}</th>
            <th class="num">{t(lang, "rel.col_rows")}</th>
            <th class="num">{t(lang, "rel.col_employers")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr>
              <td data-label={t(lang, "rank.col_rank")} class="mono num title-lead">{n(i + 1)}</td>
              <td data-label={t(lang, head)}>{label(row.k)}</td>
              <td data-label={t(lang, "col.positions")} class="mono num">{n(row.positions)}</td>
              <td data-label={t(lang, "rank.col_share")} class="mono num">{share(row.positions, total, lang)}</td>
              <td data-label={t(lang, "rel.col_rows")} class="mono num">{n(row.rows)}</td>
              <td data-label={t(lang, "rel.col_employers")} class="mono num">{n(row.employers)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return page(
    c,
    <Layout lang={lang} title={h1} dataAsOf={stats?.data_as_of ?? null} seo={rankingSeo(year, lang)}>
      <Breadcrumb lang={lang} trail={trail} />
      <h1>{h1}</h1>
      <p class="lead">{t(lang, "rank.lead")}</p>
      <nav aria-label={t(lang, "rank.years_label")} class="quick-links">
        <span class="muted">{t(lang, "rank.years_label")}</span>
        {year ? <a href="/rankings">{t(lang, "rank.all_years")}</a> : <strong aria-current="page">{t(lang, "rank.all_years")}</strong>}
        {r.years.map((y) =>
          String(y) === year ? <strong aria-current="page">{y}</strong> : <a href={`/rankings/${y}`}>{y}</a>,
        )}
      </nav>
      <p class="top-gap">
        {periodsText(r.periods, lang)}{" "}
        {t(lang, "rank.totals", { positions: n(r.totals.positions), rows: n(r.totals.rows), employers: n(r.totals.employers) })}
      </p>
      {partial ? <p class="muted">{t(lang, "rank.partial", { period: periodLabel(last, lang), year: year ?? "" })}</p> : null}
      {r.periods.includes("2014") ? <p class="muted">{t(lang, "rel.span_2014")}</p> : null}
      <p><a href="/releases">{t(lang, "rel.index_title")}</a></p>

      <Caveat lang={lang} />

      <h2>{t(lang, "rank.by_province")}</h2>
      <ShareTable rows={r.provinces} label={(k) => provLabel(lang, k)} head="rel.col_province" total={provinceTotal} />

      <h2>{t(lang, "rank.by_stream")}</h2>
      {r.streams.shown ? (
        <>
          {year ? null : <p class="muted small">{t(lang, "rank.stream_years", { years: joinList(r.streams.years.map(String), lang) })}</p>}
          <ShareTable rows={r.streams.rows} label={(k) => streamName(lang, k)} head="col.stream" total={streamTotal} />
        </>
      ) : (
        <p class="muted">{t(lang, "rank.stream_missing", { year: year ?? "" })}</p>
      )}

      <h2>{t(lang, "rank.by_occupation")}</h2>
      <p class="muted small">{t(lang, "rank.noc_note")}</p>
      {r.no_occupation_periods.length ? (
        <p class="muted small">
          {t(lang, "rank.no_occupation", { periods: joinList(r.no_occupation_periods.map((p) => periodLabel(p, lang)), lang) })}
        </p>
      ) : null}
      {r.occupations.map((era) => (
        <>
          <h3>
            {era.periods.length > 1
              ? t(lang, "rank.noc_era", {
                era: era.era,
                first: periodLabel(era.periods[0], lang),
                last: periodLabel(era.periods[era.periods.length - 1], lang),
              })
              : t(lang, "rank.noc_era_one", { era: era.era, period: periodLabel(era.periods[0] ?? "", lang) })}
          </h3>
          <p class="muted small">
            {t(lang, "rank.noc_era_total", { positions: n(era.positions), codes: n(era.codes), n: n(era.rows.length) })}
          </p>
          <div class="table-wrap">
            <table class="restack restack-compact">
              <thead>
                <tr>
                  <th class="num">{t(lang, "rank.col_rank")}</th>
                  <th>{t(lang, "rank.col_code")}</th>
                  <th>{t(lang, "rank.col_occupation")}</th>
                  <th class="num">{t(lang, "col.positions")}</th>
                  <th class="num">{t(lang, "rank.col_share")}</th>
                  <th class="num">{t(lang, "rel.col_rows")}</th>
                </tr>
              </thead>
              <tbody>
                {era.rows.map((row, i) => (
                  <tr>
                    <td data-label={t(lang, "rank.col_rank")} class="mono num title-lead">{n(i + 1)}</td>
                    <td data-label={t(lang, "rank.col_code")} class="mono title-lead">{row.code}</td>
                    <td data-label={t(lang, "rank.col_occupation")} lang={enOnly}>{row.title ?? ""}</td>
                    <td data-label={t(lang, "col.positions")} class="mono num">{n(row.positions)}</td>
                    <td data-label={t(lang, "rank.col_share")} class="mono num">{share(row.positions, era.positions, lang)}</td>
                    <td data-label={t(lang, "rel.col_rows")} class="mono num">{n(row.rows)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ))}

      <h2>{t(lang, "rank.by_employer")}</h2>
      <p class="muted small">{t(lang, "rank.employer_note")}</p>
      <div class="table-wrap">
        <table class="restack restack-compact">
          <thead>
            <tr>
              <th class="num">{t(lang, "rank.col_rank")}</th>
              <th>{t(lang, "col.employer")}</th>
              <th>{t(lang, "col.location")}</th>
              <th class="num">{t(lang, "col.positions")}</th>
              <th class="num">{t(lang, "rel.col_rows")}</th>
            </tr>
          </thead>
          <tbody>
            {r.employers.map((e, i) => (
              <tr>
                <td data-label={t(lang, "rank.col_rank")} class="mono num title-lead">{n(i + 1)}</td>
                <td data-label={t(lang, "col.employer")}><a href={`/employers/${e.id}`}>{e.name}</a></td>
                <td data-label={t(lang, "col.location")}>{place(lang, e.city, e.prov)}</td>
                <td data-label={t(lang, "col.positions")} class="mono num">{n(e.positions)}</td>
                <td data-label={t(lang, "rel.col_rows")} class="mono num">{n(e.rows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
}
