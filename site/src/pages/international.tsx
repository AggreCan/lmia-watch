// The international-candidates page, /international: Job Bank postings whose
// employer chose "Canadians and international candidates" as the people who
// may apply. From 2026-11-03 a job offer used for Express Entry needs no
// LMIA, so such offers leave the LMIA record the rest of the site reads. The
// pipeline reads these postings nightly (pipeline/lmia_pipeline/sources/
// jobbank_intl.py), grades them against IRCC's high-wage list (intl.py) and
// writes one file, international/index.json, which this page renders. The
// designated-employer lists (sources/registers.py) ride in the same file.
//
// Signals, never findings: every row separates what the employer selected
// from what the site inferred and says that a posting does not show that a
// job offer was made. The methodology's #express-entry section holds the rules.

import type { Context } from "hono";
import type { FC } from "hono/jsx";
import { type Bar, ChartStack, type Marker, type Panel, dayPos } from "../chart";
import { occupationLinks, type OccupationLinks } from "../crosslinks";
import { EMPLOYER_ID_RE, loadJson, loadStats } from "../data";
import type { AppEnv } from "../env";
import { fmtInt, numberLocale, provinceName, t, tj, type Key, type Lang } from "../i18n";
import { Layout, fmtWage, noDataPage, page } from "../layout";
import { SOCIAL_CARD, pageTitle, type Seo } from "../seo";
import { isListOf, isNum, isNumOrNull, isObj, isStr, isStrOrNull } from "../valid";
import { breadcrumbJsonLd, fitDescription, provLabel } from "./releases";
import { dayAxis } from "./trends";

// -- the file ----------------------------------------------------------------------------

export interface DayRow { day: string; all: number; lmia: number; A: number; B: number; C: number; unread: number }
export interface GradeCounts { A: number; B: number; C: number; unread: number }

export interface IntlRow {
  id: number;
  title: string | null;
  employer: string;
  employer_id: string | null;
  lmia_history: boolean;
  noc: string | null;
  city: string | null;
  prov: string | null;
  wage_min: number | null;
  wage_max: number | null;
  unit: string | null;
  date: string;
  first_seen: string;
  live: boolean;
  grade: "A" | "B" | "C";
  reasons: string[];
  phrases: { ee?: string[]; pr?: string[]; exempt?: string[] };
  url: string;
}

export interface RegisterRow {
  key: string;
  program: "AIP" | "RCIP" | "FCIP";
  jurisdiction: string;
  community: string | null;
  page_url: string;
  source_url: string;
  format: string;
  terms: string;
  terms_url: string | null;
  state: string;
  rows: number;
  list_date: string | null;
  last_ok: string | null;
  matched: number;
  // The copy loaded by hand a list carries, in use when state is "snapshot"
  // (absent from files written before copies existed).
  snapshot?: RegisterSnapshot | null;
}

export interface RegisterSnapshot { list_date: string; loaded_on: string }

export interface IntlFile {
  as_of: string;
  baseline: string | null;
  change_date: string;
  last_run: string;
  sweep_at: string | null;
  // stale: the last read of IRCC's page failed, so the grades use the last good version.
  high_wage: { read_on: string | null; page_modified: string | null; count: number; source_url: string; source_url_fr: string; stale: boolean };
  totals: { live: number; live_lmia: number; live_no_lmia: number; unread: number; seen: number };
  by_grade: GradeCounts;
  by_province: ({ k: string } & GradeCounts)[];
  by_noc: ({ k: string; points: number | null; teer: number | null; title: { en: string; fr: string } } & GradeCounts)[];
  daily: DayRow[];
  facet: ({ day: string } & Record<string, number | string>)[];
  recent: IntlRow[];
  registers: RegisterRow[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GRADES = ["A", "B", "C"] as const;
// Every link the file carries is rendered as an href, so each is held to the
// host it must come from.
const JOBBANK_URL = /^https:\/\/www\.jobbank\.gc\.ca\/jobsearch\/jobposting\/\d+$/;
const CANADA_CA = /^https:\/\/www\.canada\.ca\/(en|fr)\/[A-Za-z0-9/._#-]+$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+\.[a-z]{2,}(\/[^\s"<>]*)?$/;
const PROGRAMS = new Set(["AIP", "RCIP", "FCIP"]);

const isDate = (v: unknown): v is string => isStr(v) && ISO_DATE.test(v);
const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;
const isGrades = (v: unknown): boolean => isObj(v) && ["A", "B", "C", "unread"].every((k) => isCount(v[k]));
const isPhrases = (v: unknown): boolean => isObj(v) && Object.values(v).every((p) => isListOf(p, isStr));

const isRow = (v: unknown): v is IntlRow => isObj(v) && isNum(v.id) && isStrOrNull(v.title) && isStr(v.employer) &&
  (v.employer_id === null || (isStr(v.employer_id) && EMPLOYER_ID_RE.test(v.employer_id))) && typeof v.lmia_history === "boolean" &&
  isStrOrNull(v.noc) && isStrOrNull(v.city) && isStrOrNull(v.prov) && isNumOrNull(v.wage_min) && isNumOrNull(v.wage_max) &&
  isStrOrNull(v.unit) && isDate(v.date) && isStr(v.first_seen) && typeof v.live === "boolean" &&
  (GRADES as readonly string[]).includes(v.grade) && isListOf(v.reasons, isStr) && isPhrases(v.phrases) &&
  isStr(v.url) && JOBBANK_URL.test(v.url);

export const isRegisterSnapshot = (v: unknown): v is RegisterSnapshot => isObj(v) && isDate(v.list_date) && isDate(v.loaded_on);

export const isRegister = (v: unknown): v is RegisterRow => isObj(v) && isStr(v.key) && PROGRAMS.has(v.program) &&
  isStr(v.jurisdiction) && isStrOrNull(v.community) && isStr(v.page_url) && HTTPS.test(v.page_url) &&
  isStr(v.source_url) && HTTPS.test(v.source_url) && isStr(v.format) && isStr(v.terms) &&
  (v.terms_url === null || (isStr(v.terms_url) && HTTPS.test(v.terms_url))) && isStr(v.state) && isCount(v.rows) &&
  (v.list_date === null || isDate(v.list_date)) && (v.last_ok === null || isDate(v.last_ok)) && isCount(v.matched) &&
  (v.snapshot === undefined || v.snapshot === null || isRegisterSnapshot(v.snapshot));

export function isIntlFile(v: unknown): v is IntlFile {
  if (!isObj(v) || !isDate(v.as_of) || !(v.baseline === null || isDate(v.baseline)) || !isDate(v.change_date)) return false;
  if (!isStr(v.last_run) || !isStrOrNull(v.sweep_at)) return false;
  const h = v.high_wage;
  if (!isObj(h) || !isStrOrNull(h.read_on) || !isStrOrNull(h.page_modified) || !isCount(h.count) ||
    !isStr(h.source_url) || !CANADA_CA.test(h.source_url) || !isStr(h.source_url_fr) || !CANADA_CA.test(h.source_url_fr) ||
    typeof h.stale !== "boolean") return false;
  const tt = v.totals;
  if (!isObj(tt) || !["live", "live_lmia", "live_no_lmia", "unread", "seen"].every((k) => isCount(tt[k]))) return false;
  if (!isGrades(v.by_grade)) return false;
  if (!isListOf(v.by_province, (r) => isObj(r) && isStr(r.k) && isGrades(r))) return false;
  if (!isListOf(v.by_noc, (r) => isObj(r) && isStr(r.k) && isNumOrNull(r.points) && isNumOrNull(r.teer) &&
    isObj(r.title) && isStr(r.title.en) && isStr(r.title.fr) && isGrades(r))) return false;
  if (!isListOf(v.daily, (d) => isObj(d) && isDate(d.day) && ["all", "lmia", "A", "B", "C", "unread"].every((k) => isCount(d[k])))) return false;
  // A long series is a sign of a damaged file: about 3,650 days is ten years.
  if (v.daily.length > 4000) return false;
  if (!isListOf(v.facet, (d) => isObj(d) && isDate(d.day) && Object.entries(d).every(([k, x]) => k === "day" || isCount(x)))) return false;
  if (!isListOf(v.recent, isRow)) return false;
  return isListOf(v.registers ?? [], isRegister);
}

// -- formats -----------------------------------------------------------------------------

const GRADE_LABEL: Record<string, Key> = { A: "intl.grade_A", B: "intl.grade_B", C: "intl.grade_C", unread: "intl.grade_unread" };
const GRADE_RULE: Record<string, Key> = {
  A: "intl.grade_A_rule", B: "intl.grade_B_rule", C: "intl.grade_C_rule", unread: "intl.grade_unread_rule",
};
const PROGRAM_NAME: Record<string, Key> = { AIP: "prog.AIP", RCIP: "prog.RCIP", FCIP: "prog.FCIP" };

export const GradeBadge: FC<{ grade: string; lang: Lang }> = ({ grade, lang }) => (
  <span class={`badge grade-${grade}`}>{t(lang, GRADE_LABEL[grade] ?? "intl.grade_unread")}</span>
);

export function programName(lang: Lang, program: string): string {
  return PROGRAM_NAME[program] ? t(lang, PROGRAM_NAME[program]) : program;
}

export function registerPlace(lang: Lang, r: { jurisdiction: string; community: string | null }): string {
  return r.community ? `${r.community}, ${r.jurisdiction}` : provinceName(lang, r.jurisdiction);
}

function quoted(lang: Lang, phrases: string[] | undefined): string {
  const [open, close] = lang === "fr" ? ["« ", " »"] : ["“", "”"];
  return (phrases ?? []).map((p) => `${open}${p}${close}`).join(", ");
}

// The reasons split into what the employer selected on Job Bank and what the
// site inferred, each as sentences in the page's language.
export function reasonSentences(lang: Lang, reasons: string[], noc: string | null, phrases: IntlRow["phrases"] = {}):
  { selected: string[]; inferred: string[] } {
  const has = (k: string) => reasons.includes(k);
  const selected: string[] = [];
  const inferred: string[] = [];
  if (has("intl") && has("no_lmia")) selected.push(t(lang, "intl.sel_intl"));
  const ft = has("full_time");
  const perm = has("permanent");
  if (has("full_time") || has("not_full_time")) {
    selected.push(t(lang, ft && perm ? "intl.sel_ft_perm" : perm ? "intl.sel_perm_only" : ft ? "intl.sel_ft_only" : "intl.sel_neither"));
  }
  if (noc) selected.push(t(lang, "intl.sel_noc", { code: noc }));
  for (const r of reasons) {
    const [key, value] = r.split(":");
    if (key === "high_wage") inferred.push(t(lang, "intl.inf_high_wage", { points: value }));
    else if (key === "teer_listed_no") inferred.push(t(lang, "intl.inf_teer_unlisted", { teer: value }));
    else if (key === "teer_low") inferred.push(t(lang, "intl.inf_teer_low", { teer: value }));
    else if (key === "no_noc") inferred.push(t(lang, "intl.inf_no_noc"));
    else if (key === "ee_wording") inferred.push(t(lang, "intl.inf_ee", { phrases: quoted(lang, phrases.ee) }));
    else if (key === "pr_wording") inferred.push(t(lang, "intl.inf_pr", { phrases: quoted(lang, phrases.pr) }));
    else if (key === "exempt_wording") inferred.push(t(lang, "intl.inf_exempt", { phrases: quoted(lang, phrases.exempt) }));
  }
  return { selected, inferred };
}

export const Reasons: FC<{ lang: Lang; reasons: string[]; noc: string | null; phrases?: IntlRow["phrases"] }> = ({ lang, reasons, noc, phrases }) => {
  const { selected, inferred } = reasonSentences(lang, reasons, noc, phrases);
  return (
    <div class="reasons">
      {selected.length ? <p><strong>{t(lang, "intl.selected_label")}</strong> {selected.join(" ")}</p> : null}
      {inferred.length ? <p><strong>{t(lang, "intl.inferred_label")}</strong> {inferred.join(" ")}</p> : null}
      <p class="muted">{t(lang, "intl.not_offer")}</p>
    </div>
  );
};

const total = (c: GradeCounts) => c.A + c.B + c.C + c.unread;

// -- sections ----------------------------------------------------------------------------

// The series reaches back before the baseline (the first full sweep), where
// it undercounts; true when the file holds any day before it.
export const hasBackfill = (d: IntlFile): boolean => d.baseline !== null && d.daily.length > 0 && d.daily[0].day < d.baseline;

function longDate(lang: Lang, iso: string): string {
  return new Intl.DateTimeFormat(numberLocale(lang), { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${iso}T00:00:00Z`));
}

function chart(lang: Lang, d: IntlFile) {
  const n = (v: number) => fmtInt(v, lang);
  const facet = new Map(d.facet.map((f) => [f.day, typeof f.total === "number" ? f.total : null]));
  const days = d.daily.map((r) => r.day);
  if (!days.length) return null;
  // The axis runs to the change date at least, so its line shows before it.
  const end = days[days.length - 1] < d.change_date ? d.change_date : days[days.length - 1];
  const axisDays = [days[0], end];
  const axis = dayAxis(lang, axisDays.length > 1 && axisDays[0] !== axisDays[1] ? axisDays : [days[0]]);
  // Days before the baseline are drawn a lighter step: they undercount.
  const backfill = hasBackfill(d);
  const early = (day: string) => backfill && day < (d.baseline as string);
  const bars = (value: (r: DayRow) => number | null, light?: boolean): Bar[] => d.daily.flatMap((r) => {
    const v = value(r);
    if (v === null) return [];
    const x = dayPos(r.day);
    return [{ x0: x - 0.5, x1: x + 0.5, value: v, light: light ?? early(r.day), title: t(lang, "intl.point_title", { day: r.day, n: n(v) }) }];
  });
  const panels: Panel[] = [
    { title: t(lang, "intl.panel_no_lmia"), bars: bars((r) => r.A + r.B + r.C + r.unread) },
    { title: t(lang, "intl.panel_all"), bars: bars((r) => r.all) },
  ];
  if (facet.size) panels.push({ title: t(lang, "intl.panel_facet"), bars: bars((r) => facet.get(r.day) ?? null, true) });
  // Two numbered lines, in date order: the baseline (when the series reaches
  // back before it) and the rule change.
  const inside = (x: number) => x >= axis.domain[0] && x <= axis.domain[1] + 0.5;
  const legend: string[] = [];
  const markers: Marker[] = [];
  if (backfill && inside(dayPos(d.baseline as string))) {
    markers.push({ x: dayPos(d.baseline as string), n: markers.length + 1 });
    legend.push(t(lang, "intl.marker_baseline", { n: markers.length, date: longDate(lang, d.baseline as string) }));
  }
  const changeX = dayPos(d.change_date);
  if (inside(changeX)) {
    markers.push({ x: changeX, n: markers.length + 1 });
    legend.push(t(lang, "intl.marker_legend", { n: markers.length }));
  }
  const domain: [number, number] = [axis.domain[0], Math.max(axis.domain[1], changeX + 0.5)];
  return (
    <figure class="chart">
      <ChartStack domain={domain} panels={panels} height={140} xLabels={axis.labels} grid={axis.grid} markers={markers}
        fmt={(v) => fmtInt(Math.round(v), lang)} aria={t(lang, "intl.chart_aria")} />
      <figcaption class="chart-legend muted small">
        {legend.map((line) => <span class="legend-line">{line}</span>)}
      </figcaption>
    </figure>
  );
}

const DailyTable: FC<{ lang: Lang; d: IntlFile }> = ({ lang, d }) => {
  const n = (v: number) => fmtInt(v, lang);
  const facet = new Map(d.facet.map((f) => [f.day, typeof f.total === "number" ? f.total : null]));
  return (
    <details class="top-gap">
      <summary>{t(lang, "intl.table_daily")}</summary>
      <div class="table-wrap scroll-y">
        <table>
          <thead>
            <tr>
              <th>{t(lang, "col.date")}</th>
              <th class="num">{t(lang, "intl.col_all")}</th>
              <th class="num">{t(lang, "intl.col_lmia")}</th>
              {GRADES.map((g) => <th class="num">{t(lang, GRADE_LABEL[g])}</th>)}
              <th class="num">{t(lang, "intl.col_unread")}</th>
              <th class="num">{t(lang, "intl.col_facet")}</th>
            </tr>
          </thead>
          <tbody>
            {[...d.daily].reverse().map((r) => (
              <tr>
                <td class="mono nw">{r.day}</td>
                <td class="mono num">{n(r.all)}</td>
                <td class="mono num">{n(r.lmia)}</td>
                {GRADES.map((g) => <td class="mono num">{n(r[g])}</td>)}
                <td class="mono num">{n(r.unread)}</td>
                <td class="mono num">{facet.has(r.day) && facet.get(r.day) !== null ? n(facet.get(r.day) as number) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
};

// The province and occupation breakdowns sit side by side: their headers wrap
// where the column is narrow, and on a phone each row restacks with labels.
const GradeHeads: FC<{ lang: Lang }> = ({ lang }) => (
  <>
    {GRADES.map((g) => <th class="num th-wrap">{t(lang, GRADE_LABEL[g])}</th>)}
    <th class="num th-wrap">{t(lang, "intl.col_unread")}</th>
    <th class="num">{t(lang, "intl.col_total")}</th>
  </>
);

const GradeCells: FC<{ lang: Lang; c: GradeCounts }> = ({ lang, c }) => (
  <>
    {GRADES.map((g) => <td class="mono num" data-label={t(lang, GRADE_LABEL[g])}>{fmtInt(c[g], lang)}</td>)}
    <td class="mono num" data-label={t(lang, "intl.col_unread")}>{fmtInt(c.unread, lang)}</td>
    <td class="mono num" data-label={t(lang, "intl.col_total")}>{fmtInt(total(c), lang)}</td>
  </>
);

// The occupation as its NOC code, linked to the occupation page where one
// exists, so the breakdown stays narrow beside the province table. The title
// is the link's tooltip and is read out with the code; a phone, where the row
// restacks, shows it after the code.
const NocCell: FC<{ lang: Lang; code: string; title: string; links: OccupationLinks }> = ({ lang, code, title, links }) => {
  const inner = <><span class="mono">{code}</span><span class="noc-name"> {title}</span></>;
  return (
    <td class="noc-cell" data-label={t(lang, "rank.col_code")}>
      {links.has(code) ? <a href={`/occupations/${code}`} title={title}>{inner}</a> : <span title={title}>{inner}</span>}
    </td>
  );
};

// A hundred tall rows: the table scrolls inside its own box, header pinned,
// as the Data page's long lists do.
const RecentTable: FC<{ lang: Lang; rows: IntlRow[] }> = ({ lang, rows }) => (
  <div class="table-wrap bordered scroll-y scroll-tall">
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
        {rows.map((r) => {
          const place = [r.city, r.prov].filter(Boolean).join(", ");
          return (
            <tr>
              <td class="mono nw" data-label={t(lang, "col.date")}>{r.date}</td>
              {/* One child per cell: the phone restack puts each child of a labelled cell in its own grid cell. */}
              <td data-label={t(lang, "intl.col_posting")}>
                <div>
                  <a href={r.url} rel="nofollow noopener">{r.title ?? t(lang, "search.source_jobbank", { ref: r.id })}</a>
                  <div class="small">
                    {r.employer_id ? <a href={`/employers/${r.employer_id}`}>{r.employer}</a> : r.employer}
                    {place ? `, ${place}` : ""}
                  </div>
                  {r.wage_min !== null ? <div class="small mono">{fmtWage(r.wage_min, r.wage_max, r.unit, lang)}</div> : null}
                  {!r.live ? <div class="small muted">{t(lang, "intl.gone")}</div> : null}
                </div>
              </td>
              <td data-label={t(lang, "intl.col_grade")}><GradeBadge grade={r.grade} lang={lang} /></td>
              <td data-label={t(lang, "intl.col_why")} class="small">
                <div>
                  <Reasons lang={lang} reasons={r.reasons} noc={r.noc} phrases={r.phrases} />
                  {r.lmia_history && r.employer_id ? (
                    <p class="muted">
                      {tj(lang, "intl.lmia_context", { link: <a href={`/employers/${r.employer_id}`}>{t(lang, "intl.lmia_context_link")}</a> })}
                    </p>
                  ) : null}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

// "The province's site blocks automated readers", or the community's.
export function blockedText(lang: Lang, r: RegisterRow): string {
  return t(lang, r.community ? "intl.reg_state_blocked_community" : "intl.reg_state_blocked");
}

// The reason as a clause ("the province's site blocks automated readers"), for sentences.
export function blockedReason(lang: Lang, r: RegisterRow): string {
  return t(lang, r.community ? "intl.reg_blocked_reason_community" : "intl.reg_blocked_reason");
}

function registerState(lang: Lang, r: RegisterRow): string {
  if (r.state === "ok") return t(lang, "intl.reg_state_ok", { date: r.last_ok ?? "" });
  if (r.state === "snapshot" && r.snapshot) {
    return t(lang, "intl.reg_state_snapshot", { date: r.snapshot.list_date, loaded: r.snapshot.loaded_on });
  }
  if (r.state === "blocked") {
    return r.last_ok ? t(lang, "intl.reg_state_kept", { state: blockedText(lang, r), date: r.last_ok }) : blockedText(lang, r);
  }
  if (r.state === "unreadable") return t(lang, "intl.reg_state_unreadable");
  if (r.state === "not_read") return t(lang, "intl.reg_state_not_read");
  return r.last_ok ? t(lang, "intl.reg_state_failing", { date: r.last_ok }) : t(lang, "intl.reg_state_never");
}

// The count: blank for a site that blocks automated readers and was never
// read, a dash for any other list never read (0 would claim an empty list).
const RegisterCount: FC<{ lang: Lang; r: RegisterRow }> = ({ lang, r }) => {
  if (r.last_ok) return <>{fmtInt(r.rows, lang)}</>;
  if (r.state === "blocked") return null;
  return <><span aria-hidden="true">{"–"}</span><span class="visually-hidden">{t(lang, "intl.reg_never_read")}</span></>;
};

// Lists whose current rows come from the copy loaded by hand: the sentence
// that says so (where the list comes from, its date, the day it was loaded,
// why), for this page, the methodology and the Data page.
export function snapshotRows(rows: RegisterRow[]): (RegisterRow & { snapshot: RegisterSnapshot })[] {
  return rows.filter((r): r is RegisterRow & { snapshot: RegisterSnapshot } => r.state === "snapshot" && !!r.snapshot);
}

export function snapshotSentence(lang: Lang, r: RegisterRow & { snapshot: RegisterSnapshot }): string {
  return t(lang, r.community ? "intl.reg_snapshot_community" : "intl.reg_snapshot", {
    program: programName(lang, r.program), where: registerPlace(lang, r), date: r.snapshot.list_date, loaded: r.snapshot.loaded_on,
  });
}

const RegistersSection: FC<{ lang: Lang; rows: RegisterRow[] }> = ({ lang, rows }) => {
  const listed = rows.reduce((s, r) => s + r.rows, 0);
  const matched = rows.reduce((s, r) => s + r.matched, 0);
  const copies = snapshotRows(rows);
  return (
    <section aria-labelledby="registers">
      <h2 id="registers">{t(lang, "intl.reg_h")}</h2>
      <p>{t(lang, "intl.reg_text")}</p>
      <p class="muted small">{t(lang, "intl.reg_totals", { rows: fmtInt(listed, lang), matched: fmtInt(matched, lang) })}</p>
      {copies.map((r) => <p class="small">{snapshotSentence(lang, r)} {t(lang, "intl.reg_snapshot_check")}</p>)}
      {rows.filter((r) => r.state === "blocked").map((r) => (
        <p class="small">{t(lang, r.community ? "intl.reg_blocked_community" : "intl.reg_blocked", { program: programName(lang, r.program), where: registerPlace(lang, r) })}</p>
      ))}
      <div class="table-wrap bordered">
        <table class="restack">
          <thead>
            <tr>
              <th>{t(lang, "intl.reg_col_program")}</th>
              <th>{t(lang, "intl.reg_col_where")}</th>
              <th class="num">{t(lang, "intl.reg_col_rows")}</th>
              <th class="num">{t(lang, "intl.reg_col_matched")}</th>
              <th>{t(lang, "intl.reg_col_state")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td data-label={t(lang, "intl.reg_col_program")}>{programName(lang, r.program)}</td>
                <td data-label={t(lang, "intl.reg_col_where")}><a href={r.page_url} rel="nofollow noopener">{registerPlace(lang, r)}</a></td>
                <td class="mono num" data-label={t(lang, "intl.reg_col_rows")}><RegisterCount lang={lang} r={r} /></td>
                <td class="mono num" data-label={t(lang, "intl.reg_col_matched")}>{fmtInt(r.matched, lang)}</td>
                <td data-label={t(lang, "intl.reg_col_state")} class="nw">{registerState(lang, r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

// -- the handler ---------------------------------------------------------------------------

// Exported for the head a link preview gets (preview.ts).
export function internationalSeo(lang: Lang): Seo {
  const title = t(lang, "intl.seo_title");
  return {
    path: "/international",
    title: pageTitle(title),
    socialTitle: title,
    description: fitDescription([t(lang, "intl.seo_desc")]),
    image: SOCIAL_CARD,
    jsonLd: [breadcrumbJsonLd([{ name: t(lang, "common.home"), path: "/" }, { name: t(lang, "intl.crumb") }])],
  };
}

export async function internationalPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  // The occupation index decides which codes link; a missing file means plain codes.
  const [stats, data, occupations] = await Promise.all([
    loadStats(c.env), loadJson<unknown>(c.env, "international/index.json"), occupationLinks(c.env),
  ]);
  if (!stats) return noDataPage(c, "intl.h1");
  const methodLink = <a href="/methodology#express-entry">{t(lang, "intl.method_link")}</a>;
  if (!isIntlFile(data)) {
    // Missing (no pass yet) or unreadable: the page says so and guesses at nothing.
    return page(
      c,
      <Layout lang={lang} title={t(lang, "intl.h1")} dataAsOf={stats.data_as_of} active="/international" seo={internationalSeo(lang)}>
        <h1>{t(lang, "intl.h1")}</h1>
        <p class="lead">{t(lang, "intl.lead")}</p>
        <p>{t(lang, "intl.not_published")}</p>
        <p>{tj(lang, "intl.method", { link: methodLink })}</p>
      </Layout>,
      503,
    );
  }
  const d = data;
  const n = (v: number) => fmtInt(v, lang);
  const listUrl = lang === "fr" ? d.high_wage.source_url_fr : d.high_wage.source_url;
  return page(
    c,
    <Layout lang={lang} title={t(lang, "intl.h1")} dataAsOf={stats.data_as_of} active="/international" seo={internationalSeo(lang)}>
      <h1>{t(lang, "intl.h1")}</h1>
      <p class="lead">{t(lang, "intl.lead")}</p>
      <p>{t(lang, "intl.is_not")}</p>
      <p>{tj(lang, "intl.method", { link: methodLink })}</p>

      <section class="tiles" aria-label={t(lang, "intl.h1")}>
        <div class="tile">
          <span class="tile-value">{n(d.totals.live)}</span>
          <span>{t(lang, "intl.tile_live")}</span>
          <span class="tile-note">{t(lang, "intl.tile_live_note", { n: n(d.totals.live_lmia) })}</span>
        </div>
        <div class="tile">
          <span class="tile-value">{n(d.totals.live_no_lmia)}</span>
          <span>{t(lang, "intl.tile_no_lmia")}</span>
          <span class="tile-note">{t(lang, "intl.tile_no_lmia_note", { n: n(d.totals.unread) })}</span>
        </div>
        <div class="tile">
          <span class="tile-value">{n(d.by_grade.A)}</span>
          <span>{t(lang, "intl.tile_a")}</span>
          <span class="tile-note">{t(lang, "intl.tile_a_note")}</span>
        </div>
      </section>

      <section class="panel" aria-labelledby="change">
        <h2 id="change">{t(lang, "intl.change_h")}</h2>
        <p>{tj(lang, "intl.change_text", { list: <a href={listUrl} rel="noopener">{t(lang, "intl.list_link")}</a> })}</p>
        <p class="muted small">
          {tj(lang, "intl.list_version", {
            read: d.high_wage.read_on ?? t(lang, "common.na"),
            modified: d.high_wage.page_modified ?? t(lang, "common.na"),
            count: n(d.high_wage.count),
            link: <a href={listUrl} rel="noopener">{t(lang, "intl.list_source")}</a>,
          })}
          {d.high_wage.stale ? ` ${t(lang, "intl.list_stale")}` : ""}
        </p>
      </section>

      <h2>{t(lang, "intl.chart_h")}</h2>
      <p class="muted small">
        {hasBackfill(d)
          ? t(lang, "intl.chart_note_backfill", { baseline: d.baseline ?? d.as_of })
          : t(lang, "intl.chart_note", { baseline: d.baseline ?? d.as_of })}
      </p>
      {chart(lang, d)}
      <DailyTable lang={lang} d={d} />

      <h2>{t(lang, "intl.by_grade_h")}</h2>
      <div class="table-wrap bordered">
        <table class="restack">
          <thead>
            <tr>
              <th>{t(lang, "intl.col_grade")}</th>
              <th>{t(lang, "intl.col_rule")}</th>
              <th class="num">{t(lang, "intl.col_postings")}</th>
            </tr>
          </thead>
          <tbody>
            {(["A", "B", "C", "unread"] as const).map((g) => (
              <tr>
                <td data-label={t(lang, "intl.col_grade")}><GradeBadge grade={g} lang={lang} /></td>
                <td data-label={t(lang, "intl.col_rule")}>{t(lang, GRADE_RULE[g])}</td>
                <td class="mono num" data-label={t(lang, "intl.col_postings")}>{n(d.by_grade[g])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="two-col">
        <div>
          <h2>{t(lang, "intl.by_prov_h")}</h2>
          <div class="table-wrap">
            <table class="restack restack-compact intl-split">
              <thead><tr><th>{t(lang, "search.province")}</th><GradeHeads lang={lang} /></tr></thead>
              <tbody>
                {d.by_province.map((r) => (
                  <tr><td data-label={t(lang, "search.province")}>{provLabel(lang, r.k)}</td><GradeCells lang={lang} c={r} /></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2>{t(lang, "intl.by_noc_h")}</h2>
          <p class="muted small">{t(lang, "intl.by_noc_note", { n: d.by_noc.length })}</p>
          <div class="table-wrap">
            <table class="restack restack-compact intl-split">
              <thead>
                <tr><th class="th-wrap">{t(lang, "rank.col_code")}</th><th class="th-wrap">{t(lang, "intl.col_list")}</th><GradeHeads lang={lang} /></tr>
              </thead>
              <tbody>
                {d.by_noc.map((r) => (
                  <tr>
                    <NocCell lang={lang} code={r.k} title={r.title[lang]} links={occupations} />
                    <td class="nw" data-label={t(lang, "intl.col_list")}>{r.points ? t(lang, "intl.points", { n: r.points }) : t(lang, "intl.not_listed")}</td>
                    <GradeCells lang={lang} c={r} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <h2>{t(lang, "intl.recent_h")}</h2>
      <p class="muted small">{t(lang, "intl.recent_note", { n: d.recent.length })}</p>
      {d.recent.length ? <RecentTable lang={lang} rows={d.recent} /> : <p class="muted">{t(lang, "intl.none_yet")}</p>}

      {d.registers.length ? <RegistersSection lang={lang} rows={d.registers} /> : null}

      <p class="muted small top-gap">{t(lang, "intl.last_run", { date: d.last_run.slice(0, 10), sweep: (d.sweep_at ?? "").slice(0, 10) || t(lang, "common.na") })}</p>
    </Layout>,
  );
}
