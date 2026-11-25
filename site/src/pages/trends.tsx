// The trends page: /trends (all of Canada) and its views /trends/streams,
// /trends/provinces and /trends/pending. Each view reads one small JSON file
// the nightly export writes (pipeline/lmia_pipeline/trends.py, about 10 KB)
// and draws its charts here as inline SVG (chart.tsx), so the labels are in
// the page's language and the colours follow the theme. Every chart has its
// figures in a table under it, and nothing needs a script: the views are
// plain links.

import type { Context } from "hono";
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { type AxisLabel, type Bar, ChartStack, type Marker, type Panel, dayPos, esc, quarterPos, yearAxis } from "../chart";
import { loadJson, loadStats } from "../data";
import type { AppEnv } from "../env";
import { decimal, fmtInt, numberLocale, periodLabel, t, tj, type Key, type Lang } from "../i18n";
import { Layout, noDataPage, page } from "../layout";
import { SOCIAL_CARD, pageTitle, type Seo } from "../seo";
import { ESDC_HISTORY_START_YEAR } from "../support";
import { Breadcrumb, Caveat, breadcrumbJsonLd, fitDescription, provLabel, signed, streamName } from "./releases";

// -- the files ---------------------------------------------------------------------

interface Period {
  p: string;
  start: string;
  end: string;
  quarters: number;
}

interface Cmp {
  now: number;
  then: number;
  change: number;
  pct: number | null;
}

interface Metrics {
  positions: Cmp | null;
  rows: Cmp | null;
  employers: Cmp | null;
  refused: Cmp | null;
}

interface Marks {
  noc2021_from: string | null;
  streams_from: string | null;
}

interface National extends Marks {
  periods: (Period & { positions: number; rows: number; employers: number; refused: number | null })[];
  years: {
    year: number; periods: string[]; quarters: number[]; start: string; complete: boolean;
    positions: number; rows: number; employers: number; refused: number | null;
  }[];
  latest: string;
  published: string | null;
  yoy: {
    quarter: { now: string; then: string; metrics: Metrics | null } | null;
    ytd: { year: number; quarters: number; now: string[]; then: string[]; metrics: Metrics | null } | null;
    year: { now: number; then: number; metrics: Metrics | null } | null;
  };
}

interface Breakdown extends Marks {
  keys: string[];
  periods: (Period & { positions: number[]; rows: number[]; refused: number[] | null; missing?: number; refused_missing?: number | null })[];
  latest: string;
  yoy: { now: string; then: string; rows: ({ k: string } & Partial<Cmp>)[] } | null;
}

interface Pending {
  points: { date: string; n: number }[];
  first: string;
  latest: string;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
// Dates place every mark on the axes; one that is not a calendar date would
// put NaN into the axis arithmetic (and the month loop of the daily axis
// would never end), so a file with one reads as unpublished.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): boolean => v === null || isNum(v);
const isPeriods = (v: unknown): boolean => Array.isArray(v) && v.length > 0 &&
  v.every((p) => isObj(p) && typeof p.p === "string" && isDate(p.start) && isDate(p.end) && p.start <= p.end && isNum(p.quarters));

function isNational(v: unknown): v is National {
  return isObj(v) && isPeriods(v.periods) && v.periods.every((p: any) => isNum(p.positions) && isNum(p.rows) && isCount(p.refused)) &&
    Array.isArray(v.years) && v.years.length > 0 &&
    v.years.every((y: any) => isObj(y) && isNum(y.year) && isNum(y.positions) && typeof y.start === "string" && Array.isArray(y.periods)) &&
    isObj(v.yoy) && typeof v.latest === "string";
}

function isBreakdown(v: unknown): v is Breakdown {
  return isObj(v) && Array.isArray(v.keys) && v.keys.every((k: unknown) => typeof k === "string") && isPeriods(v.periods) &&
    typeof v.latest === "string" &&
    v.periods.every((p: any) => Array.isArray(p.positions) && p.positions.length === v.keys.length && p.positions.every(isNum) &&
      (p.refused === null || (Array.isArray(p.refused) && p.refused.length === v.keys.length && p.refused.every(isNum))) &&
      (p.missing == null || isNum(p.missing)) && (p.refused_missing == null || isNum(p.refused_missing))) &&
    (v.yoy == null || (isObj(v.yoy) && Array.isArray(v.yoy.rows) && v.yoy.rows.every((r: unknown) => isObj(r) && typeof r.k === "string")));
}

function isPending(v: unknown): v is Pending {
  return isObj(v) && Array.isArray(v.points) && v.points.length > 0 &&
    v.points.every((p: any) => isObj(p) && isDate(p.date) && isNum(p.n)) && typeof v.first === "string";
}

// -- views ---------------------------------------------------------------------------

type View = "national" | "streams" | "provinces" | "pending";
const VIEWS: { view: View; path: string; label: Key; file: string }[] = [
  { view: "national", path: "/trends", label: "trends.view.national", file: "trends/national.json" },
  { view: "streams", path: "/trends/streams", label: "trends.view.streams", file: "trends/streams.json" },
  { view: "provinces", path: "/trends/provinces", label: "trends.view.provinces", file: "trends/provinces.json" },
  { view: "pending", path: "/trends/pending", label: "trends.view.pending", file: "trends/pending.json" },
];

const H1: Record<View, Key> = {
  national: "trends.h1", streams: "trends.h1_streams", provinces: "trends.h1_provinces", pending: "trends.h1_pending",
};

function crumbs(lang: Lang, view: View): { name: string; path?: string }[] {
  const home = { name: t(lang, "common.home"), path: "/" };
  if (view === "national") return [home, { name: t(lang, "trends.crumb") }];
  const label = VIEWS.find((v) => v.view === view)!.label;
  return [home, { name: t(lang, "trends.crumb"), path: "/trends" }, { name: t(lang, label) }];
}

// Exported for the head a link preview gets (preview.ts), which has no data
// file to read and so no first date for the pending view.
export function viewSeo(lang: Lang, view: View, first: string | null): Seo {
  const start = ESDC_HISTORY_START_YEAR;
  const [title, desc] = {
    national: [t(lang, "trends.seo_title", { start }), t(lang, "trends.seo_desc", { start })],
    streams: [t(lang, "trends.seo_title_streams"), t(lang, "trends.seo_desc_streams")],
    provinces: [t(lang, "trends.seo_title_provinces", { start }), t(lang, "trends.seo_desc_provinces", { start })],
    pending: [t(lang, "trends.seo_title_pending"), t(lang, "trends.seo_desc_pending", { first: first ?? "" })],
  }[view];
  return {
    path: VIEWS.find((v) => v.view === view)!.path,
    title: pageTitle(title),
    socialTitle: title,
    description: fitDescription([desc]),
    image: SOCIAL_CARD,
    jsonLd: [breadcrumbJsonLd(crumbs(lang, view))],
  };
}

// -- formats -------------------------------------------------------------------------

const pctText = (lang: Lang, v: number) => decimal(lang, Math.abs(v).toFixed(1));

function changeText(lang: Lang, c: { change: number; pct: number | null }): string {
  if (c.change === 0) return t(lang, "trends.change_same");
  if (c.pct === null) return t(lang, "trends.change_from_zero");
  // A change too small to show at one decimal ("down 0.0 percent") reads as no change.
  if (Math.abs(c.pct) < 0.05) return t(lang, "trends.change_flat");
  return t(lang, c.pct > 0 ? "trends.change_up" : "trends.change_down", { pct: pctText(lang, c.pct) });
}

function signedPct(lang: Lang, pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return t(lang, "common.na");
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${pctText(lang, pct)}`;
}

function joinList(lang: Lang, parts: string[]): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${t(lang, "rank.and")} ${parts[parts.length - 1]}`;
}

// "2026-q1", "2017-q1-q2", "2015": the release page of a period.
const releaseSlug = (period: string) => period.toLowerCase().replace(/^(\d{4})q/, "$1-q");

// -- rule changes ----------------------------------------------------------------------

// Each date is the day the change took effect, as the news release states it;
// the releases are linked in both languages. The NOC 2021 line comes from the
// data (the first file with five-digit codes), sourced to ESDC's dataset page.
interface Rule {
  date: string;
  key: Key;
  vars?: Record<string, string>;
  sources: { label: Key; date?: string; href: Record<Lang, string> }[];
}

const NEWS_EN = "https://www.canada.ca/en/employment-social-development/news/";
const NEWS_FR = "https://www.canada.ca/fr/emploi-developpement-social/nouvelles/";
const TFW_EN = "https://www.canada.ca/en/employment-social-development/services/foreign-workers/";
const TFW_FR = "https://www.canada.ca/fr/emploi-developpement-social/services/travailleurs-etrangers/";
const POSITIVE_LIST = "90fed587-1364-4f33-a9ee-208181dc0b97";

export const RULES: readonly Rule[] = [
  {
    date: "2022-04-04",
    key: "trends.mark.roadmap",
    sources: [{
      label: "trends.source_release", date: "2022-04-04",
      href: {
        en: `${NEWS_EN}2022/04/government-of-canada-announces-workforce-solutions-road-map--further-changes-to-the-temporary-foreign-worker-program-to-address-labour-shortages-ac.html`,
        // The French release lives at this address on canada.ca.
        fr: `${NEWS_FR}2022/04/xxx.html`,
      },
    }],
  },
  {
    date: "2024-05-01",
    key: "trends.mark.validity",
    sources: [{
      label: "trends.source_release", date: "2024-03-21",
      href: {
        en: `${NEWS_EN}2024/03/government-of-canada-to-adjust-temporary-measures-under-the-temporary-foreign-worker-program-workforce-solutions-road-map.html`,
        fr: `${NEWS_FR}2024/03/plan-daction-pour-les-employeurs-et-la-main-duvre-du-programme-des-travailleurs-etrangers-temporaires--le-gouvernement-du-canada-ajuste-les-mesures.html`,
      },
    }],
  },
  {
    date: "2024-09-26",
    key: "trends.mark.cma",
    sources: [
      {
        label: "trends.source_release", date: "2024-08-26",
        href: {
          en: `${NEWS_EN}2024/08/minister-boissonnault-reducing-the-number-of-temporary-foreign-workers-in-canada.html`,
          fr: `${NEWS_FR}2024/08/le-ministre-boissonnault-agit-pour-reduire-le-nombre-de-travailleurs-etrangers-temporaires-au-canada.html`,
        },
      },
      {
        label: "trends.source_release", date: "2024-09-18",
        href: {
          en: `${NEWS_EN}2024/09/minister-boissonnault-provides-next-steps-on-recent-changes-to-the-temporary-foreign-worker-program.html`,
          fr: `${NEWS_FR}2024/09/le-ministre-boissonnault-presente-les-prochaines-etapes-en-ce-qui-concerne-les-recents-changements-au-programme-des-travailleurs-etrangers-temporaires.html`,
        },
      },
    ],
  },
  {
    date: "2024-11-08",
    key: "trends.mark.highwage",
    sources: [{
      label: "trends.source_release", date: "2024-10-21",
      href: {
        en: `${NEWS_EN}2024/10/minister-boissonnault-announces-further-temporary-foreign-worker-program-reforms-to-better-protect-the-canadian-labour-market-and-workers.html`,
        fr: `${NEWS_FR}2024/10/le-ministre-boissonnault-annonce-dautres-changements-au-programme-des-travailleurs-etrangers-temporaires-afin-doffrir-une-meilleure-protection-pour.html`,
      },
    }],
  },
  // The thresholds table on the program's page dates the edition before the
  // 2026 one as June 27, 2025 to July 16, 2026: the yearly refresh of the
  // values, not a change of rule, which is the 2024-11-08 marker above.
  {
    date: "2025-06-27",
    key: "trends.mark.thresholds_2025",
    sources: [{
      label: "trends.source_thresholds",
      href: { en: `${TFW_EN}median-wage.html#table1`, fr: `${TFW_FR}salaire-moyen.html#table1` },
    }],
  },
  // The advertising and youth rules have no news release: the program
  // requirements state them, and ESDC's notice dating them April 1, 2026 is
  // no longer shown on the program's pages. The rural measures were announced
  // on 2026-03-13 to begin as early as April 1, 2026.
  {
    date: "2026-04-01",
    key: "trends.mark.lowwage_2026",
    sources: [
      {
        label: "trends.source_requirements",
        href: { en: `${TFW_EN}median-wage/low/requirements.html#duration`, fr: `${TFW_FR}salaire-moyen/bas/exigences.html#duree` },
      },
      {
        label: "trends.source_release", date: "2026-03-13",
        href: {
          en: `${NEWS_EN}2026/03/government-of-canada-taking-action-to-support-rural-employers-under-the-temporary-foreign-worker-program.html`,
          fr: `${NEWS_FR}2026/03/le-gouvernement-du-canada-prend-des-mesures-pour-appuyer-les-employeurs-des-regions-rurales-dans-le-cadre-du-programme-des-travailleurs-etrangers-t.html`,
        },
      },
      {
        label: "trends.source_rural",
        href: { en: `${TFW_EN}temporary-measures.html`, fr: `${TFW_FR}mesures-temporaires.html` },
      },
    ],
  },
  // The thresholds table on the program's page dates each edition; the
  // quarterly CMA lists are a series on /program, not markers here.
  {
    date: "2026-07-17",
    key: "trends.mark.thresholds_2026",
    sources: [{
      label: "trends.source_thresholds",
      href: { en: `${TFW_EN}median-wage.html#table1`, fr: `${TFW_FR}salaire-moyen.html#table1` },
    }],
  },
];

interface NumberedRule extends Rule {
  n: number;
  label: string;
}

// The rules inside the series' span, numbered in date order (the numbers on
// the charts and in the list under them).
function rulesFor(lang: Lang, periods: Period[], nocFrom: string | null): NumberedRule[] {
  const first = periods[0].start;
  const last = periods[periods.length - 1].end;
  const all: (Rule & { label: string })[] = RULES.map((r) => ({ ...r, label: r.date }));
  const noc = nocFrom ? periods.find((p) => p.p === nocFrom) : undefined;
  if (noc) {
    const period = periodLabel(noc.p, lang);
    all.push({
      date: noc.start, key: "trends.mark.noc", vars: { period }, label: period,
      sources: [{
        label: "trends.source_dataset",
        href: { en: `https://open.canada.ca/data/en/dataset/${POSITIVE_LIST}`, fr: `https://open.canada.ca/data/fr/dataset/${POSITIVE_LIST}` },
      }],
    });
  }
  return all
    .filter((r) => r.date >= first && r.date <= last)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((r, i) => ({ ...r, n: i + 1 }));
}

const RuleList: FC<{ lang: Lang; rules: NumberedRule[] }> = ({ lang, rules }) =>
  rules.length ? (
    <section aria-labelledby="rules">
      <h3 id="rules">{t(lang, "trends.marks_title")}</h3>
      <p class="muted small">{t(lang, "trends.marks_note")}</p>
      <ol class="rule-list">
        {rules.map((r) => (
          <li value={r.n}>
            <strong class="nw">{r.label}</strong>{lang === "fr" ? " : " : ": "}{t(lang, r.key, r.vars)}{" "}
            <span class="muted small">
              {tj(lang, r.sources.length > 1 ? "trends.sources_label" : "trends.source_label", {
                links: r.sources.map((s, i) => (
                  <>
                    {i > 0 ? ", " : ""}
                    <a href={s.href[lang]} rel="noopener">{t(lang, s.label, s.date ? { date: s.date } : undefined)}</a>
                  </>
                )),
              })}
            </span>
          </li>
        ))}
      </ol>
    </section>
  ) : null;

// -- chart inputs ----------------------------------------------------------------------

const fmtFor = (lang: Lang) => (v: number) => fmtInt(Math.round(v), lang);

// A stream below this share of the view's positions gets no panel of its own.
const SMALL_SHARE = 0.001;

function domainOf(periods: Period[]): [number, number] {
  return [quarterPos(periods[0].start), quarterPos(periods[periods.length - 1].end, true)];
}

// Where each file sits on the axis and the words around its hover title,
// worked out once per page: the province view draws every file on 14 panels.
interface Slot { x0: number; x1: number; span: number; light: boolean; title: [string, string]; avgTitle: (n: string, avg: string) => string }
const SLOTS = new WeakMap<Period[], { lang: Lang; slots: Slot[] }>();

function slotsOf(lang: Lang, periods: Period[]): Slot[] {
  const cached = SLOTS.get(periods);
  if (cached && cached.lang === lang) return cached.slots;
  const slots = periods.map((p): Slot => {
    const x0 = quarterPos(p.start);
    const x1 = quarterPos(p.end, true);
    const span = x1 - x0;
    const period = periodLabel(p.p, lang);
    const q = decimal(lang, Number.isInteger(span) ? String(span) : span.toFixed(1));
    const [before, after] = t(lang, "trends.bar_title", { period, n: "\u0000" }).split("\u0000");
    return {
      x0, x1, span, light: span > 1.05, title: [before, after] as [string, string],
      avgTitle: (n: string, avg: string) => t(lang, "trends.bar_title_avg", { period, n, avg, q }),
    };
  });
  SLOTS.set(periods, { lang, slots });
  return slots;
}

// One bar per file across the quarters it covers. A file longer than a
// quarter is drawn lighter at its average per quarter, so its area, not its
// height, matches its total.
function periodBars(lang: Lang, periods: Period[], values: (number | null)[]): Bar[] {
  const n = fmtFor(lang);
  const slots = slotsOf(lang, periods);
  const bars: Bar[] = [];
  values.forEach((v, i) => {
    if (v === null || v === undefined) return;
    const s = slots[i];
    bars.push({
      x0: s.x0, x1: s.x1, value: v / s.span, light: s.light,
      title: s.light ? s.avgTitle(n(v), n(v / s.span)) : `${s.title[0]}${n(v)}${s.title[1]}`,
    });
  });
  return bars;
}

const toMarkers = (rules: NumberedRule[], scale = 1): Marker[] => rules.map((r) => ({ x: quarterPos(r.date) / scale, n: r.n }));

// The notes under a chart read as one short paragraph.
const Legend: FC<{ lang: Lang; keys: Key[]; extra?: string[] }> = ({ lang, keys, extra = [] }) => (
  <figcaption class="chart-legend muted small">{[...keys.map((k) => t(lang, k)), ...extra].join(" ")}</figcaption>
);

const QuarterChart: FC<{
  lang: Lang; periods: Period[]; panels: Panel[]; rules: NumberedRule[]; height: number; legend: Key[]; shared?: boolean;
  notes?: string[];
}> = ({ lang, periods, panels, rules, height, legend, shared, notes }) => {
  const domain = domainOf(periods);
  const axis = yearAxis(domain);
  return (
    <figure class="chart">
      <ChartStack domain={domain} panels={panels} height={height} xLabels={axis.labels} grid={axis.grid}
        markers={toMarkers(rules)} fmt={fmtFor(lang)} aria={t(lang, "trends.chart_aria")} shared={shared} />
      <Legend lang={lang} keys={legend} extra={notes} />
    </figure>
  );
};

// -- shared blocks ---------------------------------------------------------------------

const ViewTabs: FC<{ lang: Lang; view: View }> = ({ lang, view }) => (
  <nav class="view-tabs" aria-label={t(lang, "trends.views")}>
    <ul>
      {VIEWS.map((v) => (
        <li>
          <a href={v.path} class={v.view === view ? "active" : undefined} aria-current={v.view === view ? "page" : undefined}>{t(lang, v.label)}</a>
        </li>
      ))}
    </ul>
  </nav>
);

// The three caveats the series need, the uneven early files, and any period
// without a negative list.
const Notes: FC<{ lang: Lang; periods: Period[]; marks: Marks; refusedMissing: string[] }> = ({ lang, periods, marks, refusedMissing }) => {
  const half = periods.find((p) => p.quarters === 2);
  return (
    <section aria-labelledby="notes">
      <h2 id="notes">{t(lang, "trends.notes_title")}</h2>
      <ul class="notes">
        {periods.some((p) => p.quarters > 1) && half ? <li>{t(lang, "trends.note_spans", { half: periodLabel(half.p, lang) })}</li> : null}
        {marks.streams_from ? <li>{t(lang, "trends.note_streams", { from: periodLabel(marks.streams_from, lang) })}</li> : null}
        <li>{tj(lang, "trends.note_reload", { changelog: <a href="/data#changelog">{t(lang, "trends.changelog_link")}</a> })}</li>
        {marks.noc2021_from ? <li>{t(lang, "trends.note_noc", { from: periodLabel(marks.noc2021_from, lang) })}</li> : null}
        {refusedMissing.length ? (
          <li>{t(lang, "trends.note_refused_missing", { periods: joinList(lang, refusedMissing.map((p) => periodLabel(p, lang))) })}</li>
        ) : null}
        <li>{tj(lang, "trends.note_program", { program: <a href="/program">{t(lang, "trends.program_link")}</a> })}</li>
      </ul>
    </section>
  );
};

const Sources: FC<{ lang: Lang; pending?: boolean }> = ({ lang, pending }) => (
  <p class="muted small top-gap">
    {tj(lang, pending ? "trends.sources_pending" : "trends.sources", { data: <a href="/data#licence">{t(lang, "places.sources_link")}</a> })}
  </p>
);

const Head: FC<{ lang: Lang; view: View; lead: string }> = ({ lang, view, lead }) => (
  <>
    <Breadcrumb lang={lang} trail={crumbs(lang, view)} />
    <h1>{t(lang, H1[view], { start: ESDC_HISTORY_START_YEAR })}</h1>
    <p class="lead">{lead}</p>
    <ViewTabs lang={lang} view={view} />
  </>
);

// -- all of Canada ---------------------------------------------------------------------

function nationalBody(lang: Lang, d: National) {
  const n = (v: number | null | undefined) => (v === null || v === undefined ? t(lang, "common.na") : fmtInt(v, lang));
  const rules = rulesFor(lang, d.periods, d.noc2021_from);
  const missing = d.periods.filter((p) => p.refused === null).map((p) => p.p);
  const missingIn = (pred: (p: string) => boolean) => missing.filter(pred).map((p) => periodLabel(p, lang));
  const { quarter, ytd, year } = d.yoy;
  const lines: string[][] = [];

  if (quarter?.metrics?.positions && quarter.metrics.rows) {
    const m = quarter.metrics;
    const vars = { now: periodLabel(quarter.now, lang), then: periodLabel(quarter.then, lang) };
    const para = [t(lang, "trends.yoy_quarter", {
      ...vars, pos: n(m.positions!.now), rows: n(m.rows!.now), pos_then: n(m.positions!.then), rows_then: n(m.rows!.then),
      change: changeText(lang, m.positions!),
    })];
    if (m.employers) para.push(t(lang, "trends.yoy_employers", { n: n(m.employers.now), then_n: n(m.employers.then), change: changeText(lang, m.employers) }));
    para.push(m.refused
      ? t(lang, "trends.yoy_refused", { ...vars, n: n(m.refused.now), then_n: n(m.refused.then), change: changeText(lang, m.refused) })
      : t(lang, "trends.yoy_no_refused", { periods: joinList(lang, missingIn((p) => p === quarter.now || p === quarter.then)) }));
    lines.push(para);
  }
  if (ytd?.metrics?.positions && ytd.metrics.rows) {
    if (ytd.quarters === 1) lines.push([t(lang, "trends.yoy_ytd_one", { year: ytd.year })]);
    else if (ytd.quarters === 4) lines.push([t(lang, "trends.yoy_ytd_full", { year: ytd.year })]);
    else {
      const m = ytd.metrics;
      const para = [t(lang, "trends.yoy_ytd", {
        first: periodLabel(ytd.now[0], lang), now: periodLabel(ytd.now[ytd.now.length - 1], lang), year_then: ytd.year - 1,
        pos: n(m.positions!.now), rows: n(m.rows!.now), pos_then: n(m.positions!.then), rows_then: n(m.rows!.then),
        change: changeText(lang, m.positions!),
      })];
      para.push(m.refused
        ? t(lang, "trends.yoy_ytd_refused", { n: n(m.refused.now), then_n: n(m.refused.then), change: changeText(lang, m.refused) })
        : t(lang, "trends.yoy_no_refused", { periods: joinList(lang, missingIn((p) => [...ytd.now, ...ytd.then].includes(p))) }));
      lines.push(para);
    }
  }
  if (year?.metrics?.positions && year.metrics.rows) {
    const m = year.metrics;
    const para = [t(lang, "trends.yoy_year", {
      year: year.now, year_then: year.then, pos: n(m.positions!.now), rows: n(m.rows!.now), pos_then: n(m.positions!.then),
      rows_then: n(m.rows!.then), change: changeText(lang, m.positions!),
    })];
    para.push(m.refused
      ? t(lang, "trends.yoy_year_refused", { n: n(m.refused.now), then_n: n(m.refused.then), change: changeText(lang, m.refused) })
      : t(lang, "trends.yoy_no_refused", { periods: joinList(lang, missingIn((p) => p.startsWith(String(year.now)) || p.startsWith(String(year.then)))) }));
    lines.push(para);
  }

  const P = d.periods;
  const panels: Panel[] = [
    { title: t(lang, "rel.row_positions"), bars: periodBars(lang, P, P.map((p) => p.positions)) },
    { title: t(lang, "rel.row_positive_rows"), bars: periodBars(lang, P, P.map((p) => p.rows)) },
    { title: t(lang, "rel.row_negative_rows"), bars: periodBars(lang, P, P.map((p) => p.refused)), tone: "refused" },
  ];
  const years = d.years;
  const yDomain: [number, number] = [years[0].year, years[years.length - 1].year + 1];
  const yLabels: AxisLabel[] = years.map((y, i) => ({ x: y.year + 0.5, text: String(y.year), minor: (years.length - 1 - i) % 2 === 1 }));
  const yearBars: Bar[] = years.map((y) => ({
    x0: y.year, x1: y.year + 1, value: y.positions, light: !y.complete,
    title: t(lang, "trends.bar_title", { period: String(y.year), n: n(y.positions) }),
  }));
  const lastPeriod = P[P.length - 1].p;
  const cover = (y: National["years"][number]) =>
    y.complete ? t(lang, "trends.cover_full") : y.start.endsWith("-06-20") ? t(lang, "trends.cover_2014")
      : t(lang, "trends.cover_to", { period: periodLabel(y.periods[y.periods.length - 1] ?? lastPeriod, lang) });

  return (
    <>
      <section aria-labelledby="yoy">
        <h2 id="yoy">{t(lang, "trends.yoy_title")}</h2>
        {lines.map((para) => <p>{para.join(" ")}</p>)}
        <p class="muted small">{t(lang, "trends.yoy_season")}</p>
      </section>
      <Notes lang={lang} periods={P} marks={d} refusedMissing={missing} />
      <Caveat lang={lang} />

      <h2>{t(lang, "trends.chart_periods")}</h2>
      <QuarterChart lang={lang} periods={P} panels={panels} rules={rules} height={130}
        legend={["trends.legend_light", ...(rules.length ? ["trends.legend_marks" as Key] : [])]} />
      <RuleList lang={lang} rules={rules} />
      <h3>{t(lang, "trends.table_periods")}</h3>
      <div class="table-wrap scroll-y">
        <table>
          <thead>
            <tr>
              <th>{t(lang, "trends.col_period")}</th>
              <th class="num">{t(lang, "trends.col_quarters")}</th>
              <th class="num">{t(lang, "rel.row_positions")}</th>
              <th class="num">{t(lang, "rel.col_positive_rows")}</th>
              <th class="num">{t(lang, "rel.col_employers")}</th>
              <th class="num">{t(lang, "rel.col_negative_rows")}</th>
            </tr>
          </thead>
          <tbody>
            {[...P].reverse().map((p) => (
              <tr>
                <td data-label={t(lang, "trends.col_period")} class="nw"><a href={`/releases/${releaseSlug(p.p)}`}>{periodLabel(p.p, lang)}</a></td>
                <td data-label={t(lang, "trends.col_quarters")} class="mono num">{n(p.quarters)}</td>
                <td data-label={t(lang, "rel.row_positions")} class="mono num">{n(p.positions)}</td>
                <td data-label={t(lang, "rel.col_positive_rows")} class="mono num">{n(p.rows)}</td>
                <td data-label={t(lang, "rel.col_employers")} class="mono num">{n(p.employers)}</td>
                <td data-label={t(lang, "rel.col_negative_rows")} class="mono num">{n(p.refused)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>{t(lang, "trends.chart_years")}</h2>
      <figure class="chart">
        <ChartStack domain={yDomain} panels={[{ title: t(lang, "rel.row_positions"), bars: yearBars }]} height={150}
          xLabels={yLabels} markers={toMarkers(rules, 4)} fmt={fmtFor(lang)} aria={t(lang, "trends.chart_aria")} />
        <Legend lang={lang} keys={["trends.legend_years", ...(rules.length ? ["trends.legend_marks" as Key] : [])]} />
      </figure>
      <h3>{t(lang, "trends.table_years")}</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t(lang, "trends.col_year")}</th>
              <th>{t(lang, "trends.col_cover")}</th>
              <th class="num">{t(lang, "rel.row_positions")}</th>
              <th class="num">{t(lang, "rel.col_positive_rows")}</th>
              <th class="num">{t(lang, "rel.col_employers")}</th>
              <th class="num">{t(lang, "rel.col_negative_rows")}</th>
            </tr>
          </thead>
          <tbody>
            {[...years].reverse().map((y) => (
              <tr>
                <td data-label={t(lang, "trends.col_year")}><a href={`/rankings/${y.year}`}>{y.year}</a></td>
                <td data-label={t(lang, "trends.col_cover")}>{cover(y)}</td>
                <td data-label={t(lang, "rel.row_positions")} class="mono num">{n(y.positions)}</td>
                <td data-label={t(lang, "rel.col_positive_rows")} class="mono num">{n(y.rows)}</td>
                <td data-label={t(lang, "rel.col_employers")} class="mono num">{n(y.employers)}</td>
                <td data-label={t(lang, "rel.col_negative_rows")} class="mono num">{n(y.refused)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// -- by stream and by province -----------------------------------------------------------

function breakdownBody(lang: Lang, d: Breakdown, kind: "streams" | "provinces") {
  const n = (v: number | null | undefined) => (v === null || v === undefined ? t(lang, "common.na") : fmtInt(v, lang));
  const name = (k: string) => (kind === "streams" ? streamName(lang, k) : provLabel(lang, k));
  const head = (k: string) => (kind === "streams" ? streamName(lang, k) : <abbr title={provLabel(lang, k)}>{k}</abbr>);
  const P = d.periods;
  const rules = rulesFor(lang, P, d.noc2021_from);
  const missing = P.filter((p) => p.refused === null).map((p) => p.p);
  const showMissing = kind === "streams" && P.some((p) => (p.missing ?? 0) > 0);
  const showRefusedMissing = kind === "streams" && P.some((p) => (p.refused_missing ?? 0) > 0);
  // Each panel has its own scale, so a stream with a handful of positions
  // (ESDC's stray "Unspecified") would fill its panel as tall as the largest;
  // such a stream stays in the tables only. Every province keeps its panel.
  const totals = d.keys.map((_, i) => P.reduce((s, p) => s + p.positions[i], 0));
  const all = totals.reduce((s, v) => s + v, 0);
  const charted = d.keys.map((_, i) => kind === "provinces" || totals[i] >= SMALL_SHARE * all);
  const tableOnly = d.keys.filter((_, i) => !charted[i]);
  const panels: Panel[] = d.keys.flatMap((k, i) => (charted[i] ? [{ title: name(k), bars: periodBars(lang, P, P.map((p) => p.positions[i])) }] : []));
  const legend: Key[] = ["trends.legend_scale", ...(P.some((p) => p.quarters > 1) ? ["trends.legend_light" as Key] : []),
    ...(rules.length ? ["trends.legend_marks" as Key] : [])];
  const half = Math.ceil(panels.length / 2);
  // Rows with nothing in either quarter say nothing; the total still counts every key.
  const yoy = d.yoy ? { ...d.yoy, rows: d.yoy.rows.filter((r) => r.now || r.then) } : null;
  const sum = (key: "now" | "then") => (yoy ? yoy.rows.reduce((s, r) => s + (r[key] ?? 0), 0) : 0);
  const total = yoy ? { now: sum("now"), then: sum("then") } : null;
  const totalPct = total && total.then ? Math.round(((total.now - total.then) * 1000) / total.then) / 10 : null;

  // `missing` adds the column of rows that carry no stream, so the total is every row of the file.
  const Table = ({ values, missing }: {
    values: (p: Breakdown["periods"][number]) => (number | null)[] | null;
    missing?: (p: Breakdown["periods"][number]) => number | null | undefined;
  }) => (
    <div class="table-wrap scroll-y">
      <table>
        <thead>
          <tr>
            <th>{t(lang, "trends.col_period")}</th>
            {d.keys.map((k) => <th class="num">{head(k)}</th>)}
            {missing ? <th class="num">{t(lang, "trends.col_no_stream")}</th> : null}
            <th class="num">{t(lang, kind === "streams" ? "trends.col_total" : "trends.col_all")}</th>
          </tr>
        </thead>
        {/* About 600 cells, written as a string for the same reason as the chart marks. */}
        <tbody>
          {raw([...P].reverse().map((p) => {
            const row = values(p);
            const na = esc(t(lang, "common.na"));
            const cell = (v: string) => `<td class="mono num">${v}</td>`;
            const none = missing ? missing(p) ?? 0 : 0;
            let tr = `<tr><td class="nw"><a href="/releases/${esc(releaseSlug(p.p))}">${esc(periodLabel(p.p, lang))}</a></td>`;
            for (let i = 0; i < d.keys.length; i++) tr += cell(row ? n(row[i]) : na);
            if (missing) tr += cell(row ? n(none) : na);
            tr += cell(row ? n(row.reduce((s: number, v) => s + (v ?? 0), 0) + none) : na);
            return `${tr}</tr>`;
          }).join(""))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {yoy ? (
        <section aria-labelledby="yoy">
          <h2 id="yoy">{t(lang, "trends.same_quarter", { now: periodLabel(yoy.now, lang), then: periodLabel(yoy.then, lang) })}</h2>
          <p class="muted small">{t(lang, "trends.same_quarter_note")} {t(lang, "trends.yoy_season")}</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t(lang, kind === "streams" ? "col.stream" : "rel.col_province")}</th>
                  <th class="num">{periodLabel(yoy.then, lang)}</th>
                  <th class="num">{periodLabel(yoy.now, lang)}</th>
                  <th class="num">{t(lang, "rel.col_change")}</th>
                  <th class="num">{t(lang, "trends.col_pct")}</th>
                </tr>
              </thead>
              <tbody>
                {yoy.rows.map((r) => (
                  <tr>
                    <td data-label={t(lang, kind === "streams" ? "col.stream" : "rel.col_province")}>{name(r.k)}</td>
                    <td data-label={periodLabel(yoy.then, lang)} class="mono num">{n(r.then)}</td>
                    <td data-label={periodLabel(yoy.now, lang)} class="mono num">{n(r.now)}</td>
                    <td data-label={t(lang, "rel.col_change")} class="mono num">{r.change === undefined ? "" : signed(r.change, lang)}</td>
                    <td data-label={t(lang, "trends.col_pct")} class="mono num">{signedPct(lang, r.pct)}</td>
                  </tr>
                ))}
                {total ? (
                  <tr class="total-row">
                    <td data-label={t(lang, kind === "streams" ? "col.stream" : "rel.col_province")}>{t(lang, kind === "streams" ? "trends.col_total" : "trends.col_all")}</td>
                    <td data-label={periodLabel(yoy.then, lang)} class="mono num">{n(total.then)}</td>
                    <td data-label={periodLabel(yoy.now, lang)} class="mono num">{n(total.now)}</td>
                    <td data-label={t(lang, "rel.col_change")} class="mono num">{signed(total.now - total.then, lang)}</td>
                    <td data-label={t(lang, "trends.col_pct")} class="mono num">{signedPct(lang, totalPct)}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <Notes lang={lang} periods={P} marks={d} refusedMissing={missing} />
      <Caveat lang={lang} />

      <h2>{t(lang, kind === "streams" ? "trends.chart_streams" : "trends.chart_provinces")}</h2>
      {kind === "streams" ? (
        <>
          <QuarterChart lang={lang} periods={P} panels={panels} rules={rules} height={84} legend={legend}
            notes={[
              ...(tableOnly.length ? [t(lang, "trends.small_streams", { names: joinList(lang, tableOnly.map(name)) })] : []),
              t(lang, "trends.pr_gap"),
            ]} />
        </>
      ) : (
        <figure class="chart">
          <div class="chart-pair">
            {[panels.slice(0, half), panels.slice(half)].map((group) => {
              const domain = domainOf(P);
              const axis = yearAxis(domain);
              return (
                <ChartStack domain={domain} panels={group} height={70} xLabels={axis.labels} grid={axis.grid}
                  markers={toMarkers(rules)} fmt={fmtFor(lang)} aria={t(lang, "trends.chart_aria")} />
              );
            })}
          </div>
          <Legend lang={lang} keys={legend} />
        </figure>
      )}
      <RuleList lang={lang} rules={rules} />
      <h3>{t(lang, kind === "streams" ? "trends.table_streams" : "trends.table_provinces")}</h3>
      {kind === "provinces" ? <p class="muted small">{t(lang, "trends.codes_note")}</p> : null}
      <Table values={(p) => p.positions} missing={showMissing ? (p) => p.missing : undefined} />
      <details class="top-gap">
        <summary>{t(lang, kind === "streams" ? "trends.refused_streams" : "trends.refused_provinces")}</summary>
        <Table values={(p) => p.refused} missing={showRefusedMissing ? (p) => p.refused_missing : undefined} />
      </details>
    </>
  );
}

// -- Job Bank pending, nightly -------------------------------------------------------------

// Shared with the international-candidates page (pages/international.tsx).
export function dayAxis(lang: Lang, dates: string[]): { domain: [number, number]; labels: AxisLabel[]; grid: number[] } {
  const xs = dates.map(dayPos);
  const domain: [number, number] = [xs[0] - 0.5, xs[xs.length - 1] + 0.5];
  const locale = numberLocale(lang);
  const span = xs[xs.length - 1] - xs[0];
  if (span <= 20) {
    const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
    return {
      domain,
      grid: [],
      labels: dates.map((iso, i) => ({ x: xs[i], text: day.format(new Date(`${iso}T00:00:00Z`)), minor: dates.length > 7 && (dates.length - 1 - i) % 2 === 1 })),
    };
  }
  // Longer series: a label at each month's first day (each year's beyond two years).
  const yearly = span > 730;
  const fmt = new Intl.DateTimeFormat(locale, yearly ? { year: "numeric", timeZone: "UTC" } : { month: "short", year: "numeric", timeZone: "UTC" });
  const ticks: string[] = [];
  const [y0, m0] = dates[0].split("-").map(Number);
  // Bounded as well as stopped at the domain's end: a hundred years of months.
  for (let y = y0, m = m0, guard = 0; guard < 1200; m++, guard++) {
    if (m > 12) { m = 1; y++; }
    const iso = `${y}-${String(m).padStart(2, "0")}-01`;
    if (dayPos(iso) > domain[1]) break;
    if (dayPos(iso) >= domain[0] && (!yearly || m === 1)) ticks.push(iso);
  }
  return {
    domain,
    grid: ticks.map(dayPos),
    labels: ticks.map((iso, i) => ({ x: dayPos(iso), text: fmt.format(new Date(`${iso}T00:00:00Z`)), minor: ticks.length > 6 && (ticks.length - 1 - i) % 2 === 1 })),
  };
}

function pendingBody(lang: Lang, d: Pending) {
  const n = (v: number) => fmtInt(v, lang);
  const pts = d.points;
  const last = pts[pts.length - 1];
  const prev = pts.length > 1 ? pts[pts.length - 2] : null;
  const axis = dayAxis(lang, pts.map((p) => p.date));
  const line = pts.map((p) => ({ x: dayPos(p.date), value: p.n, title: t(lang, "trends.bar_title", { period: p.date, n: n(p.n) }) }));
  const change = prev ? { change: last.n - prev.n, pct: prev.n ? Math.round(((last.n - prev.n) * 1000) / prev.n) / 10 : null } : null;
  return (
    <>
      <p>
        {prev && change
          ? t(lang, "trends.pending_latest", { date: last.date, n: n(last.n), prev: prev.date, prev_n: n(prev.n), change: changeText(lang, change) })
          : t(lang, "trends.pending_latest_one", { date: last.date, n: n(last.n) })}{" "}
        {t(lang, "trends.pending_began", { first: d.first })}
      </p>
      <section class="panel">
        <p>{t(lang, "trends.pending_caution")}</p>
        <p>{t(lang, "trends.pending_households")}</p>
      </section>
      <h2>{t(lang, "trends.chart_pending")}</h2>
      <figure class="chart">
        <ChartStack domain={axis.domain} panels={[{ title: t(lang, "trends.panel_pending"), line, tone: "pending" }]} height={180}
          xLabels={axis.labels} grid={axis.grid} fmt={fmtFor(lang)} aria={t(lang, "trends.line_aria")} />
        <figcaption class="chart-legend muted small"><span>{t(lang, "trends.pending_rule")}</span></figcaption>
      </figure>
      <h3>{t(lang, "trends.table_pending")}</h3>
      <div class="table-wrap scroll-y">
        <table>
          <thead>
            <tr>
              <th>{t(lang, "col.date")}</th>
              <th class="num">{t(lang, "trends.panel_pending")}</th>
              <th class="num th-wrap">{t(lang, "trends.col_vs_prev")}</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p, i) => ({ p, before: i > 0 ? pts[i - 1].n : null })).reverse().map(({ p, before }) => (
              <tr>
                <td class="mono nw">{p.date}</td>
                <td class="mono num">{n(p.n)}</td>
                <td class="mono num">{before === null ? "" : signed(p.n - before, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="top-gap"><a href="/search?status=pending" class="btn">{t(lang, "trends.pending_search")}</a></p>
    </>
  );
}

// -- the handler -----------------------------------------------------------------------

export async function trendsPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const param = c.req.param("view");
  const entry = param === undefined ? VIEWS[0] : VIEWS.find((v) => v.view !== "national" && v.view === param);
  const [stats, data] = await Promise.all([loadStats(c.env), entry ? loadJson<unknown>(c.env, entry.file) : Promise.resolve(null)]);
  if (!stats) return noDataPage(c, "trends.crumb");
  if (!entry) {
    return page(
      c,
      <Layout lang={lang} title={t(lang, "trends.not_found")} dataAsOf={stats.data_as_of}>
        <h1>{t(lang, "trends.not_found")}</h1>
        <p>{tj(lang, "trends.not_found_text", { trends: <a href="/trends">{t(lang, "trends.page_link")}</a> })}</p>
      </Layout>,
      404,
    );
  }
  const view = entry.view;
  let body: unknown = null;
  let lead = "";
  let first: string | null = null;
  if (view === "national" && isNational(data)) {
    body = nationalBody(lang, data);
    lead = t(lang, "trends.lead", { start: ESDC_HISTORY_START_YEAR });
  } else if ((view === "streams" || view === "provinces") && isBreakdown(data)) {
    body = breakdownBody(lang, data, view);
    lead = view === "streams"
      ? t(lang, "trends.streams_lead", { from: periodLabel(data.streams_from ?? data.periods[0].p, lang) })
      : t(lang, "trends.provinces_lead", { start: ESDC_HISTORY_START_YEAR });
  } else if (view === "pending" && isPending(data)) {
    first = data.first;
    body = pendingBody(lang, data);
    lead = t(lang, "trends.pending_lead", { first: data.first });
  }
  if (!body) {
    // The view's file is missing or unreadable: the page still names the
    // other views, and says this one is not published.
    return page(
      c,
      <Layout lang={lang} title={t(lang, H1[view], { start: ESDC_HISTORY_START_YEAR })} dataAsOf={stats.data_as_of}>
        <Head lang={lang} view={view} lead={view === "pending" ? t(lang, "trends.pending_none") : t(lang, "trends.not_published")} />
      </Layout>,
      503,
    );
  }
  return page(
    c,
    <Layout lang={lang} title={t(lang, H1[view], { start: ESDC_HISTORY_START_YEAR })} dataAsOf={stats.data_as_of} seo={viewSeo(lang, view, first)} active="/trends">
      <Head lang={lang} view={view} lead={lead} />
      {body as any}
      {view === "pending" ? null : <p class="small top-gap"><a href="/releases">{t(lang, "rel.index_title")}</a> · <a href="/rankings">{t(lang, "rank.title")}</a></p>}
      <Sources lang={lang} pending={view === "pending"} />
    </Layout>,
  );
}
