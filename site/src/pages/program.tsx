// The program conditions page, /program: what the Temporary Foreign Worker
// Program's own pages on canada.ca state, read each night by the pipeline
// (pipeline/lmia_pipeline/sources/program.py) and written to one small file,
// program/index.json (conditions.py, about 12 KB). Three series: LMIA
// processing times by stream, the unemployment rates behind the low-wage
// refusal to process by census metropolitan area, and the provincial and
// territorial wage thresholds. The pipeline marks which edition is in force
// on the export date; this page shows it, then every edition read, each with
// the page it came from and the day it was read. It states rules and figures
// and nothing else.

import type { Context } from "hono";
import type { FC } from "hono/jsx";
import { loadJson, loadStats } from "../data";
import type { AppEnv } from "../env";
import { cmaName, decimal, fmtInt, numberLocale, periodLabel, provinceName, t, tj, type Key, type Lang } from "../i18n";
import { Layout, noDataPage, page } from "../layout";
import { SOCIAL_CARD, pageTitle, type Seo } from "../seo";
import { isListOf, isNum, isObj, isStr } from "../valid";
import { Breadcrumb, breadcrumbJsonLd, fitDescription } from "./releases";

// -- the file ------------------------------------------------------------------------

interface Figure {
  key: string;
  label: string;
  value: number;
}

type Status = "latest" | "in_force" | "upcoming" | "past";

interface Edition {
  period: string;
  to: string | null;
  threshold: number | null;
  published: string | null;
  source: string;
  read: string;
  figures: Figure[];
  revisions: number;
  status: Status;
}

interface Series {
  source: Record<Lang, string>;
  checked: string | null;
  editions: Edition[];
}

type SeriesKey = "processing_times" | "cma_refusal" | "wage_thresholds";

interface ProgramFile {
  as_of: string;
  series: Record<SeriesKey, Series>;
  indicator_bases: { quarter: string; basis: "lists" | "lfs" }[];
}

const SERIES: SeriesKey[] = ["processing_times", "cma_refusal", "wage_thresholds"];
const STATUSES = new Set(["latest", "in_force", "upcoming", "past"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
// Every link the file carries is rendered as an href, so only the program's
// own pages are accepted.
const CANADA_CA = /^https:\/\/www\.canada\.ca\/(en|fr)\/[A-Za-z0-9/._#-]+$/;

const isDate = (v: unknown): v is string => isStr(v) && ISO_DATE.test(v);
const isDateOrNull = (v: unknown) => v === null || isDate(v);
const isLink = (v: unknown): v is string => isStr(v) && CANADA_CA.test(v);

const isFigure = (v: unknown): v is Figure => isObj(v) && isStr(v.key) && isStr(v.label) && isNum(v.value);

function isEdition(series: SeriesKey) {
  return (v: unknown): v is Edition =>
    isObj(v) && (series === "processing_times" ? MONTH.test(String(v.period)) : isDate(v.period)) &&
    isDateOrNull(v.to) && (v.threshold === null || isNum(v.threshold)) && isDateOrNull(v.published) &&
    isLink(v.source) && isDate(v.read) && isListOf(v.figures, isFigure) && v.figures.length > 0 &&
    isNum(v.revisions) && STATUSES.has(v.status);
}

const isSeries = (series: SeriesKey) => (v: unknown): v is Series =>
  isObj(v) && isObj(v.source) && isLink(v.source.en) && isLink(v.source.fr) && isDateOrNull(v.checked) &&
  isListOf(v.editions, isEdition(series));

function isProgramFile(v: unknown): v is ProgramFile {
  return isObj(v) && isDate(v.as_of) && isObj(v.series) && SERIES.every((k) => isSeries(k)(v.series[k])) &&
    isListOf(v.indicator_bases, (b) => isObj(b) && isStr(b.quarter) && (b.basis === "lists" || b.basis === "lfs"));
}

// -- formats -------------------------------------------------------------------------

// The canada.ca terms under which the three pages are reproduced.
export const TERMS: Record<Lang, string> = {
  en: "https://www.canada.ca/en/transparency/terms.html",
  fr: "https://www.canada.ca/fr/transparence/avis.html",
};

const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
// Province names as the pages write them, for the CMA labels ("Winnipeg, Manitoba").
const PROVINCE_BY_NAME: Record<string, string> = Object.fromEntries(PROVINCES.map((c) => [provinceName("en", c), c]));

const money = (lang: Lang, v: number) => t(lang, "program.money", { v: decimal(lang, v.toFixed(2)) });
const rate = (lang: Lang, v: number) => decimal(lang, v.toFixed(1));

function monthLabel(lang: Lang, period: string): string {
  return new Intl.DateTimeFormat(numberLocale(lang), { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${period}-01T00:00:00Z`));
}

const STREAM_KEYS: Record<string, Key> = {
  global_talent: "program.stream.global_talent",
  agricultural: "program.stream.agricultural",
  sawp: "program.stream.sawp",
  high_wage: "program.stream.high_wage",
  low_wage: "program.stream.low_wage",
  permanent_resident: "program.stream.permanent_resident",
};

// A stream the page added since this was written keeps the page's own name.
const streamName = (lang: Lang, f: Figure) => (STREAM_KEYS[f.key] ? t(lang, STREAM_KEYS[f.key]) : f.label);

// "Ottawa-Gatineau, Ontario/Quebec" -> "Ottawa-Gatineau, Ontario/Québec" in French.
function cmaLabel(lang: Lang, label: string): string {
  const cut = label.lastIndexOf(", ");
  if (cut < 0) return cmaName(lang, label);
  const provinces = label.slice(cut + 2).split("/").map((p) => (PROVINCE_BY_NAME[p.trim()] ? provinceName(lang, PROVINCE_BY_NAME[p.trim()]) : p));
  return `${cmaName(lang, label.slice(0, cut))}, ${provinces.join("/")}`;
}

const range = (lang: Lang, e: Edition) =>
  e.to ? t(lang, "program.range", { from: e.period, to: e.to }) : t(lang, "program.range_open", { from: e.period });

const statusText = (lang: Lang, s: Status) =>
  s === "in_force" ? t(lang, "program.in_force") : s === "upcoming" ? t(lang, "program.upcoming") : s === "latest" ? t(lang, "program.latest") : "";

const atOrAbove = (e: Edition) => e.figures.filter((f) => f.value >= (e.threshold ?? Infinity));

// -- shared blocks ---------------------------------------------------------------------

const SourceLine: FC<{ lang: Lang; series: Series; edition: Edition | undefined; title: Key }> = ({ lang, series, edition, title }) => (
  <p class="muted small">
    {tj(lang, "program.source_line", {
      link: <a href={series.source[lang]} rel="noopener">{t(lang, title)}</a>,
      published: edition?.published ?? t(lang, "common.na"),
      read: edition?.read ?? t(lang, "common.na"),
      checked: series.checked ?? t(lang, "common.na"),
    })}
  </p>
);

// The read date of an edition, linked to the page it was read from in the reader's language.
const ReadCell: FC<{ lang: Lang; series: Series; e: Edition }> = ({ lang, series, e }) => (
  <td data-label={t(lang, "program.col_read")} class="mono nw"><a href={series.source[lang]} rel="noopener">{e.read}</a></td>
);

// -- the three sections ----------------------------------------------------------------

function timesSection(lang: Lang, s: Series) {
  const latest = s.editions.find((e) => e.status === "latest") ?? s.editions[0];
  const keys = [...new Map(s.editions.flatMap((e) => e.figures.map((f) => [f.key, f] as const))).values()];
  return (
    <section aria-labelledby="times">
      <h2 id="times">{t(lang, "program.times_title")}</h2>
      <p>{t(lang, "program.times_text")}</p>
      {latest ? (
        <>
          <div class="table-wrap">
            <table>
              <caption>{t(lang, "program.times_caption", { month: monthLabel(lang, latest.period) })}</caption>
              <thead>
                <tr><th>{t(lang, "program.col_stream")}</th><th class="num">{t(lang, "program.col_days")}</th></tr>
              </thead>
              <tbody>
                {latest.figures.map((f) => (
                  <tr><td>{streamName(lang, f)}</td><td class="mono num">{fmtInt(f.value, lang)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <SourceLine lang={lang} series={s} edition={latest} title="program.src_times" />
          <h3>{t(lang, "program.history_times")}</h3>
          <div class="table-wrap scroll-y">
            <table class="restack">
              <thead>
                <tr>
                  <th>{t(lang, "program.col_month")}</th>
                  {keys.map((f) => <th class="num th-wrap">{streamName(lang, f)}</th>)}
                  <th>{t(lang, "program.col_published")}</th>
                  <th>{t(lang, "program.col_read")}</th>
                </tr>
              </thead>
              <tbody>
                {s.editions.map((e) => (
                  <tr>
                    <td data-label={t(lang, "program.col_month")} class="nw">{monthLabel(lang, e.period)}</td>
                    {keys.map((k) => {
                      const f = e.figures.find((x) => x.key === k.key);
                      return <td data-label={streamName(lang, k)} class="mono num">{f ? fmtInt(f.value, lang) : t(lang, "common.na")}</td>;
                    })}
                    <td data-label={t(lang, "program.col_published")} class="mono nw">{e.published ?? ""}</td>
                    <ReadCell lang={lang} series={s} e={e} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : <p class="muted">{t(lang, "program.not_read")}</p>}
    </section>
  );
}

function cmaSection(lang: Lang, s: Series, asOf: string, bases: ProgramFile["indicator_bases"]) {
  const current = s.editions.find((e) => e.status === "in_force");
  const firstListQuarter = bases.find((b) => b.basis === "lists")?.quarter;
  const methodology = <a href="/methodology#indicators">{t(lang, "program.methodology_link")}</a>;
  // Areas in the order of the newest list, then any that only older lists name.
  const areas = [...new Map(s.editions.flatMap((e) => e.figures.map((f) => [f.key, f] as const))).values()];
  return (
    <section aria-labelledby="cma">
      <h2 id="cma">{t(lang, "program.cma_title")}</h2>
      <p>{t(lang, "program.cma_text")}</p>
      {s.editions.length === 0 ? <p class="muted">{t(lang, "program.not_read")}</p> : (
        <>
          {current ? (
            <>
              <p>
                {t(lang, "program.cma_current", {
                  range: range(lang, current), n: fmtInt(atOrAbove(current).length, lang), total: fmtInt(current.figures.length, lang),
                  threshold: rate(lang, current.threshold ?? 0),
                })}
              </p>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>{t(lang, "program.col_cma")}</th><th class="num">{t(lang, "program.col_rate")}</th></tr>
                  </thead>
                  <tbody>
                    {[...atOrAbove(current)].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).map((f) => (
                      <tr><td>{cmaLabel(lang, f.label)}</td><td class="mono num">{rate(lang, f.value)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : <p>{t(lang, "program.cma_none", { date: asOf })}</p>}
          <SourceLine lang={lang} series={s} edition={current ?? s.editions[0]} title="program.src_cma" />
          <p class="small">
            {firstListQuarter
              ? tj(lang, "program.indicator_note", { first: periodLabel(firstListQuarter, lang), methodology })
              : tj(lang, "program.indicator_note_lfs", { methodology })}
          </p>
          <h3>{t(lang, "program.history_cma")}</h3>
          <div class="table-wrap">
            <table class="restack">
              <thead>
                <tr>
                  <th>{t(lang, "program.col_in_force")}</th>
                  <th class="num">{t(lang, "program.col_cutoff")}</th>
                  <th class="num th-wrap">{t(lang, "program.col_areas")}</th>
                  <th>{t(lang, "program.col_status")}</th>
                  <th>{t(lang, "program.col_published")}</th>
                  <th>{t(lang, "program.col_read")}</th>
                </tr>
              </thead>
              <tbody>
                {s.editions.map((e) => (
                  <tr>
                    <td data-label={t(lang, "program.col_in_force")} class="nw">{range(lang, e)}</td>
                    <td data-label={t(lang, "program.col_cutoff")} class="mono num">{e.threshold === null ? t(lang, "common.na") : rate(lang, e.threshold)}</td>
                    <td data-label={t(lang, "program.col_areas")} class="mono num">{fmtInt(atOrAbove(e).length, lang)} / {fmtInt(e.figures.length, lang)}</td>
                    <td data-label={t(lang, "program.col_status")}>{statusText(lang, e.status)}</td>
                    <td data-label={t(lang, "program.col_published")} class="mono nw">{e.published ?? ""}</td>
                    <ReadCell lang={lang} series={s} e={e} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details class="top-gap">
            <summary>{t(lang, "program.cma_all")}</summary>
            <p class="muted small">{t(lang, "program.cma_all_note")}</p>
            <div class="table-wrap scroll-y">
              <table>
                <thead>
                  <tr>
                    <th>{t(lang, "program.col_cma")}</th>
                    {s.editions.map((e) => <th class="num th-wrap">{range(lang, e)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {areas.map((a) => (
                    <tr>
                      <td>{cmaLabel(lang, a.label)}</td>
                      {s.editions.map((e) => {
                        const f = e.figures.find((x) => x.key === a.key);
                        if (!f) return <td class="mono num">{t(lang, "common.na")}</td>;
                        return <td class="mono num">{f.value >= (e.threshold ?? Infinity) ? <strong>{rate(lang, f.value)}</strong> : rate(lang, f.value)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function wageSection(lang: Lang, s: Series, asOf: string) {
  const current = s.editions.find((e) => e.status === "in_force");
  const before = current ? s.editions[s.editions.indexOf(current) + 1] : undefined;
  const value = (e: Edition | undefined, code: string) => e?.figures.find((f) => f.key === code)?.value;
  const codes = PROVINCES.filter((c) => s.editions.some((e) => value(e, c) !== undefined));
  return (
    <section aria-labelledby="wage">
      <h2 id="wage">{t(lang, "program.wage_title")}</h2>
      <p>{t(lang, "program.wage_text")}</p>
      {s.editions.length === 0 ? <p class="muted">{t(lang, "program.not_read")}</p> : (
        <>
          <p>{current ? t(lang, "program.wage_current", { range: range(lang, current) }) : t(lang, "program.wage_none", { date: asOf })}</p>
          <div class="table-wrap">
            <table class="restack">
              <thead>
                <tr>
                  <th>{t(lang, "program.col_province")}</th>
                  {s.editions.map((e) => <th class="num th-wrap">{t(lang, "program.col_from", { date: e.period })}</th>)}
                  {current && before ? <th class="num">{t(lang, "program.col_change")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {codes.map((code) => {
                  const now = value(current, code);
                  const then = value(before, code);
                  return (
                    <tr>
                      <td data-label={t(lang, "program.col_province")}>{provinceName(lang, code)}</td>
                      {s.editions.map((e) => {
                        const v = value(e, code);
                        const cell = v === undefined ? t(lang, "common.na") : money(lang, v);
                        return (
                          <td data-label={t(lang, "program.col_from", { date: e.period })} class="mono num">
                            {e === current ? <strong>{cell}</strong> : cell}
                          </td>
                        );
                      })}
                      {current && before ? (
                        <td data-label={t(lang, "program.col_change")} class="mono num">
                          {now === undefined || then === undefined ? "" : `${now > then ? "+" : now < then ? "−" : ""}${money(lang, Math.abs(now - then))}`}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <SourceLine lang={lang} series={s} edition={current ?? s.editions[0]} title="program.src_wage" />
          <h3>{t(lang, "program.history_wage")}</h3>
          <div class="table-wrap">
            <table class="restack">
              <thead>
                <tr>
                  <th>{t(lang, "program.col_in_force")}</th>
                  <th>{t(lang, "program.col_status")}</th>
                  <th>{t(lang, "program.col_published")}</th>
                  <th>{t(lang, "program.col_read")}</th>
                </tr>
              </thead>
              <tbody>
                {s.editions.map((e) => (
                  <tr>
                    <td data-label={t(lang, "program.col_in_force")} class="nw">{range(lang, e)}</td>
                    <td data-label={t(lang, "program.col_status")}>{statusText(lang, e.status)}</td>
                    <td data-label={t(lang, "program.col_published")} class="mono nw">{e.published ?? ""}</td>
                    <ReadCell lang={lang} series={s} e={e} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// The three facts in force on the export date, in one short list.
function summary(lang: Lang, d: ProgramFile): string[] {
  const out: string[] = [];
  const times = d.series.processing_times.editions.find((e) => e.status === "latest");
  if (times) {
    const sorted = [...times.figures].sort((a, b) => a.value - b.value);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    out.push(t(lang, "program.now_times", {
      month: monthLabel(lang, times.period), low: fmtInt(low.value, lang), low_stream: streamName(lang, low),
      high: fmtInt(high.value, lang), high_stream: streamName(lang, high),
    }));
  }
  const cma = d.series.cma_refusal.editions.find((e) => e.status === "in_force");
  if (cma) {
    out.push(t(lang, "program.now_cma", {
      n: fmtInt(atOrAbove(cma).length, lang), total: fmtInt(cma.figures.length, lang), threshold: rate(lang, cma.threshold ?? 0),
      range: range(lang, cma),
    }));
  } else if (d.series.cma_refusal.editions.length) {
    out.push(t(lang, "program.cma_none", { date: d.as_of }));
  }
  const wage = d.series.wage_thresholds.editions.find((e) => e.status === "in_force");
  if (wage) {
    const sorted = [...wage.figures].sort((a, b) => a.value - b.value || a.key.localeCompare(b.key));
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    out.push(t(lang, "program.now_wage", {
      range: range(lang, wage), low: money(lang, low.value), low_prov: provinceName(lang, low.key),
      high: money(lang, high.value), high_prov: provinceName(lang, high.key),
    }));
  } else if (d.series.wage_thresholds.editions.length) {
    out.push(t(lang, "program.wage_none", { date: d.as_of }));
  }
  return out;
}

// -- the handler -------------------------------------------------------------------------

// Exported for the head a link preview gets (preview.ts).
export function programSeo(lang: Lang): Seo {
  const title = t(lang, "program.seo_title");
  return {
    path: "/program",
    title: pageTitle(title),
    socialTitle: title,
    description: fitDescription([t(lang, "program.seo_desc")]),
    image: SOCIAL_CARD,
    jsonLd: [breadcrumbJsonLd([{ name: t(lang, "common.home"), path: "/" }, { name: t(lang, "program.crumb") }])],
  };
}

export async function programPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const [stats, data] = await Promise.all([loadStats(c.env), loadJson<unknown>(c.env, "program/index.json")]);
  if (!stats) return noDataPage(c, "program.crumb");
  const trail = [{ name: t(lang, "common.home"), path: "/" }, { name: t(lang, "program.crumb") }];
  if (!isProgramFile(data)) {
    // Missing or unreadable: the page says so, and nothing it showed before is guessed at.
    return page(
      c,
      <Layout lang={lang} title={t(lang, "program.h1")} dataAsOf={stats.data_as_of}>
        <Breadcrumb lang={lang} trail={trail} />
        <h1>{t(lang, "program.h1")}</h1>
        <p class="lead">{t(lang, "program.not_published")}</p>
      </Layout>,
      503,
    );
  }
  const facts = summary(lang, data);
  return page(
    c,
    <Layout lang={lang} title={t(lang, "program.h1")} dataAsOf={stats.data_as_of} seo={programSeo(lang)}>
      <Breadcrumb lang={lang} trail={trail} />
      <h1>{t(lang, "program.h1")}</h1>
      <p class="lead">{t(lang, "program.lead")}</p>
      <section class="panel" aria-labelledby="now">
        <h2 id="now">{t(lang, "program.now_title", { date: data.as_of })}</h2>
        {facts.length ? <ul>{facts.map((f) => <li>{f}</li>)}</ul> : <p>{t(lang, "program.not_read")}</p>}
        <p class="muted small">{t(lang, "program.as_of_note")}</p>
      </section>
      {timesSection(lang, data.series.processing_times)}
      {cmaSection(lang, data.series.cma_refusal, data.as_of, data.indicator_bases)}
      {wageSection(lang, data.series.wage_thresholds, data.as_of)}
      <p class="small top-gap"><a href="/trends">{t(lang, "trends.crumb")}</a> · <a href="/methodology#indicators">{t(lang, "nav.methodology")}</a></p>
      <p class="muted small top-gap">
        {tj(lang, "program.sources", {
          terms: <a href={TERMS[lang]} rel="noopener">{t(lang, "program.terms_link")}</a>,
          data: <a href="/data#licence">{t(lang, "places.sources_link")}</a>,
        })}
      </p>
    </Layout>,
  );
}
