import type { Context } from "hono";
import { HowToCite } from "../cite";
import { loadStats } from "../data";
import type { AppEnv } from "../env";
import { t, tj, type Key, type Lang } from "../i18n";
import { Layout, fmtInt, noDataPage, page, periodLabel } from "../layout";
import { CANADA_TERMS_URL, type DownloadLicence, OGL_URL, datasetJsonLd, pageSeo } from "../seo";
import { TERMS } from "./program";
import { isRegister, programName, registerPlace, snapshotRows, snapshotSentence } from "./international";
import { EE_LINKS } from "./methodology";
import { isListOf, isNum, isNumOrNull, isObj, isStr, isStrOrNull } from "../valid";

// The changelog, newest first whatever order the entries are written in.
// Add an entry here; the table sorts by date, and entries of the same date
// keep their order here (the sort is stable).
export type ChangeRow = { date: string; change: Key; recomputed: Key; vars?: Record<string, string | number> };
export const CHANGELOG: readonly ChangeRow[] = [
  { date: "2026-10-12", change: "data.change_drafted", recomputed: "data.recomputed_all", vars: { rules: "0.1" } },
  { date: "2026-10-17", change: "data.change_wages", recomputed: "data.recomputed_wages", vars: { rules: "0.2" } },
  { date: "2026-10-18", change: "data.change_matching", recomputed: "data.recomputed_profiles" },
  { date: "2026-10-18", change: "data.change_households", recomputed: "data.recomputed_households" },
  {
    date: "2026-10-19", change: "data.change_esdc_rows", recomputed: "data.recomputed_esdc_rows",
    vars: { rows: 8359, positions: 49043, streams: 55006, provinces: 2349, headers: 473, header_positions: 1606 },
  },
  { date: "2026-10-20", change: "data.change_trends", recomputed: "data.recomputed_trends" },
  { date: "2026-10-22", change: "data.change_program", recomputed: "data.recomputed_program", vars: { rules: "0.3" } },
  { date: "2026-10-23", change: "data.change_search", recomputed: "data.recomputed_search" },
  { date: "2026-10-24", change: "data.change_surfaces", recomputed: "data.recomputed_none" },
  { date: "2026-10-26", change: "data.change_notices", recomputed: "data.recomputed_notices" },
  { date: "2026-10-25", change: "data.change_intl", recomputed: "data.recomputed_intl" },
  { date: "2026-10-25", change: "data.change_card_links", recomputed: "data.recomputed_none" },
  { date: "2026-10-30", change: "data.change_directory", recomputed: "data.recomputed_directory" },
  { date: "2026-10-30", change: "data.change_audience", recomputed: "data.recomputed_audience" },
  { date: "2026-11-04", change: "data.change_privacy_links", recomputed: "data.recomputed_none" },
];
// Numbers in an entry are formatted for the page's language; the drafted entry names the latest period.
export function changelog(latestPeriod: string, lang: Lang): { date: string; change: Key; recomputed: Key; vars: Record<string, string> }[] {
  return [...CHANGELOG]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((row) => {
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(row.vars ?? {})) vars[k] = typeof v === "number" ? fmtInt(v, lang) : v;
      if (row.change === "data.change_drafted") vars.period = latestPeriod;
      return { date: row.date, change: row.change, recomputed: row.recomputed, vars };
    });
}

// "2026-10-20T02:46:39Z" -> "2026-10-20 02:46 UTC" ("02 h 46" in French); anything else as given.
export function runTime(iso: string | null | undefined, lang: Lang): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(iso ?? "");
  return m ? t(lang, "data.run_time", { date: m[1], hh: m[2], mm: m[3] }) : (iso ?? "");
}

// Each file's licence group, shown beside it, declared per file in the
// Dataset JSON-LD and detailed in the licence table. Job Bank and IRCC
// material is under canada.ca's terms, which the site cannot relicense;
// employers.csv and indicators.csv mix sources column by column.
const DOWNLOAD_LICENCE_LABEL: Record<DownloadLicence, Key> = {
  ogl: "data.lic.ogl",
  canada: "data.dl.canada",
  mixed: "data.dl.mixed",
};

export const DOWNLOADS: { file: string; contents: Key; licence: DownloadLicence }[] = [
  { file: "pending_observations.csv", contents: "data.file.pending_observations", licence: "canada" },
  { file: "approved_quarterly.csv", contents: "data.file.approved_quarterly", licence: "ogl" },
  { file: "refused_quarterly.csv", contents: "data.file.refused_quarterly", licence: "ogl" },
  { file: "employers.csv", contents: "data.file.employers", licence: "mixed" },
  { file: "indicators.csv", contents: "data.file.indicators", licence: "mixed" },
  { file: "findings.csv", contents: "data.file.findings", licence: "canada" },
  { file: "esdc_resources.csv", contents: "data.file.esdc_resources", licence: "ogl" },
];

// The licence table: what each source supplies and the terms it carries.
export const LICENCE_ROWS: readonly { material: Key; terms: Key }[] = [
  { material: "data.lic.esdc", terms: "data.lic.esdc_terms" },
  { material: "data.lic.jobbank", terms: "data.lic.jobbank_terms" },
  { material: "data.lic.ircc", terms: "data.lic.ircc_terms" },
  { material: "data.lic.quebec", terms: "data.lic.quebec_terms" },
  { material: "data.lic.statcan", terms: "data.lic.statcan_terms" },
  { material: "data.lic.computed", terms: "data.lic.computed_terms" },
  { material: "data.lic.geonames", terms: "data.lic.geonames_terms" },
  // Public records on profiles; the grants disclosure is under the same OGL as ESDC's lists.
  { material: "data.lic.grants", terms: "data.lic.esdc_terms" },
  { material: "data.lic.alberta", terms: "data.lic.alberta_terms" },
  { material: "data.lic.fmcsa", terms: "data.lic.fmcsa_terms" },
  // The November 3 change: postings open to international candidates, IRCC's list, the designated-employer lists.
  { material: "data.lic.jobbank_intl", terms: "data.lic.jobbank_terms" },
  { material: "data.lic.high_wage", terms: "data.lic.high_wage_terms" },
  { material: "data.lic.registers", terms: "data.lic.registers_terms" },
  // Government notices: the departments' own titles and summaries, under canada.ca's terms.
  { material: "data.lic.notices", terms: "data.lic.notices_terms" },
];

// Job Bank's search under the international-candidates filter, in each language.
const FACET_URL: Record<Lang, string> = {
  en: "https://www.jobbank.gc.ca/jobsearch/jobsearch?fglo=1",
  fr: "https://www.guichetemplois.gc.ca/jobsearch/rechercheemplois?fglo=1",
};
const TERMS_NAME: Record<string, Key> = {
  nb_disclaimer: "data.terms.nb_disclaimer",
  ns_crown: "data.terms.ns_crown",
  pe_policy: "data.terms.pe_policy",
  nl_disclaimer: "data.terms.nl_disclaimer",
  community_site: "data.terms.community_site",
};

const LICENCE_LINKS: Record<"terms" | "cc" | "oglab", Record<Lang, string>> = {
  terms: CANADA_TERMS_URL,
  cc: {
    en: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    fr: "https://creativecommons.org/licenses/by-nc-sa/4.0/deed.fr",
  },
  // Alberta publishes its licence in English only.
  oglab: { en: "https://open.alberta.ca/licence", fr: "https://open.alberta.ca/licence" },
};

const API_ROWS: [string, Key][] = [
  ["GET /api/stats", "data.api.stats"],
  ["GET /api/employers/{id}", "data.api.employer"],
  ["GET /api/pending?since=YYYY-MM-DD", "data.api.pending"],
  ["GET /api/clusters?scope=latest|since_2023q4", "data.api.clusters"],
  ["GET /api/area/{fsa}", "data.api.area"],
  ["GET /api/search/facets", "data.api.facets"],
];

const LIST_NAME: Record<string, Key> = { positive: "data.list.positive", negative: "data.list.negative" };

// Where the reference tables behind the wage and unemployment indicators are published.
const SOURCE_LINKS: Record<
  "wages" | "lfs" | "boundaries" | "statcan" | "vacancies" | "noc" | "grants" | "alberta" | "fmcsa", Record<Lang, string>
> = {
  wages: {
    en: "https://open.canada.ca/data/en/dataset/adad580f-76b0-4502-bd05-20c125de9116",
    fr: "https://open.canada.ca/data/fr/dataset/adad580f-76b0-4502-bd05-20c125de9116",
  },
  lfs: {
    en: "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1410045901",
    fr: "https://www150.statcan.gc.ca/t1/tbl1/fr/tv.action?pid=1410045901",
  },
  boundaries: {
    en: "https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/index2021-eng.cfm",
    fr: "https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/index2021-fra.cfm",
  },
  statcan: {
    en: "https://www.statcan.gc.ca/en/reference/licence",
    fr: "https://www.statcan.gc.ca/fr/reference/licence",
  },
  vacancies: {
    en: "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1410044401",
    fr: "https://www150.statcan.gc.ca/t1/tbl1/fr/tv.action?pid=1410044401",
  },
  noc: {
    en: "https://www.statcan.gc.ca/en/subjects/standard/noc/2021/indexV1",
    fr: "https://www.statcan.gc.ca/fr/sujets/norme/cnp/2021/indexV1",
  },
  grants: {
    en: "https://open.canada.ca/data/en/dataset/432527ab-7aac-45b5-81d6-7597107a7013",
    fr: "https://open.canada.ca/data/fr/dataset/432527ab-7aac-45b5-81d6-7597107a7013",
  },
  alberta: { en: "https://open.alberta.ca/opendata/employer-records", fr: "https://open.alberta.ca/opendata/employer-records" },
  // The catalogue's short link for the dataset, which redirects to its page.
  fmcsa: { en: "https://data.transportation.gov/d/az4n-8mr2", fr: "https://data.transportation.gov/d/az4n-8mr2" },
};

// The two lists of stats.json that only this page reads. They are checked here
// rather than in loadStats, so a malformed row costs this page, not every page.
const isResource = (r: unknown): boolean => isObj(r) && isStr(r.dataset) && isStr(r.period) && isStrOrNull(r.published) &&
  isNum(r.rows_loaded) && isStr(r.loaded_at);
const isRun = (r: unknown): boolean => isObj(r) && isStr(r.run_at) && isStr(r.source) && isStrOrNull(r.detail) &&
  isNumOrNull(r.rows_new) && isNum(r.ok);

export async function dataPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const stats = await loadStats(c.env);
  if (!stats || !isListOf(stats.resources, isResource) || !isListOf(stats.runs, isRun)) return noDataPage(c, "nav.data");
  const na = t(lang, "common.na");
  // The designated-employer lists, checked here, their only reader: a list that fails leaves the table out.
  const registers = isListOf(stats.registers, isRegister) ? stats.registers : [];
  // English shows the period code as stored (2026Q1); French shows the label.
  const latestPeriod = lang === "fr" ? periodLabel(stats.esdc_latest_period, lang) : stats.esdc_latest_period;

  return page(
    c,
    <Layout
      lang={lang}
      title={t(lang, "nav.data")}
      dataAsOf={stats.data_as_of}
      active="/data"
      seo={pageSeo("data", lang, {
        jsonLd: [datasetJsonLd(DOWNLOADS.map((d) => ({ file: d.file, contents: t(lang, d.contents), licence: d.licence })), stats.data_as_of, lang)],
      })}
    >
      <div class="doc-layout">
        <nav aria-label={t(lang, "toc.label")} class="toc">
          <span class="toc-title">{t(lang, "toc.title")}</span>
          <a href="#downloads">{t(lang, "data.toc_downloads")}</a>
          <a href="#api">{t(lang, "data.toc_api")}</a>
          <a href="#licence">{t(lang, "data.toc_licence")}</a>
          <a href="#changelog">{t(lang, "data.toc_changelog")}</a>
          <a href="#reply">{t(lang, "data.toc_reply")}</a>
          <a href="#about">{t(lang, "data.toc_about")}</a>
        </nav>
        <div class="doc">
          <h1>{t(lang, "nav.data")}</h1>
          <p class="lead">{t(lang, "data.lead")}</p>
          <p>
            {tj(lang, "places.browse", {
              occupations: <a href="/occupations">{t(lang, "places.browse_occupations")}</a>,
              places: <a href="/places">{t(lang, "places.browse_places")}</a>,
            })}
          </p>

          <h2 id="downloads">{t(lang, "data.toc_downloads")}</h2>
          <div class="table-wrap bordered">
            <table>
              <thead>
                <tr>
                  <th>{t(lang, "data.col_file")}</th>
                  <th>{t(lang, "data.col_contents")}</th>
                  <th>{t(lang, "data.toc_licence")}</th>
                  <th>{t(lang, "data.col_updated")}</th>
                </tr>
              </thead>
              <tbody>
                {DOWNLOADS.map((d) => (
                  <tr>
                    <td><a href={`/downloads/${d.file}`} class="mono">{d.file}</a></td>
                    <td>{t(lang, d.contents)}</td>
                    <td><a href="#licence">{t(lang, DOWNLOAD_LICENCE_LABEL[d.licence])}</a></td>
                    <td class="mono">{stats.data_as_of ?? na}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="muted small">
            {tj(lang, "data.mirror", { mirror: <a href="/downloads/mirror/SHA256SUMS" class="mono">mirror/</a> })}
          </p>

          <h3>{t(lang, "data.esdc_files")}</h3>
          <div class="table-wrap bordered scroll-y">
            <table>
              <thead>
                <tr>
                  <th>{t(lang, "data.col_list")}</th>
                  <th>{t(lang, "data.col_period")}</th>
                  <th>{t(lang, "data.col_published")}</th>
                  <th class="num">{t(lang, "data.col_rows")}</th>
                  <th>{t(lang, "data.col_loaded")}</th>
                </tr>
              </thead>
              <tbody>
                {stats.resources.length === 0 ? <tr><td colspan={5} class="muted">{t(lang, "data.no_files")}</td></tr> : stats.resources.map((r) => (
                  <tr>
                    <td>{LIST_NAME[r.dataset] ? t(lang, LIST_NAME[r.dataset]) : r.dataset}</td>
                    <td class="mono">{r.period}</td>
                    <td class="mono">{r.published ?? ""}</td>
                    <td class="mono num">{fmtInt(r.rows_loaded, lang)}</td>
                    <td class="mono">{r.loaded_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="muted small top-gap">
            {tj(lang, "rel.data_link", { link: <a href="/releases">{t(lang, "rel.index_title")}</a> })}
          </p>

          <HowToCite lang={lang} citation={stats.citation} />

          <h2 id="api">{t(lang, "data.toc_api")}</h2>
          <p>{t(lang, "data.api_text")}</p>
          <p class="muted small">{t(lang, "data.api_limits")}</p>
          <div class="table-wrap bordered">
            <table>
              <thead>
                <tr>
                  <th>{t(lang, "data.col_endpoint")}</th>
                  <th>{t(lang, "data.col_returns")}</th>
                </tr>
              </thead>
              <tbody>
                {API_ROWS.map(([endpoint, returns]) => (
                  <tr><td class="mono">{endpoint}</td><td>{t(lang, returns)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 id="licence">{t(lang, "data.licence")}</h2>
          <p>{t(lang, "data.licence_text")}</p>
          <div class="table-wrap bordered">
            <table class="restack">
              <thead>
                <tr>
                  <th>{t(lang, "data.col_material")}</th>
                  <th>{t(lang, "data.col_terms")}</th>
                </tr>
              </thead>
              <tbody>
                {LICENCE_ROWS.map((row) => (
                  <tr>
                    <td data-label={t(lang, "data.col_material")}>
                      {t(lang, row.material)}
                      {row.material === "data.lic.registers"
                        ? snapshotRows(registers).map((r) => <div class="small">{snapshotSentence(lang, r)}</div>)
                        : null}
                    </td>
                    <td data-label={t(lang, "data.col_terms")}>
                      {tj(lang, row.terms, {
                        ogl: <a href={OGL_URL[lang]}>{t(lang, "data.lic.ogl")}</a>,
                        terms: <a href={LICENCE_LINKS.terms[lang]}>{t(lang, "data.lic.canada_terms")}</a>,
                        cc: <a href={LICENCE_LINKS.cc[lang]}>{t(lang, "data.lic.cc")}</a>,
                        oglab: <a href={LICENCE_LINKS.oglab[lang]}>{t(lang, "data.lic.ogl_ab")}</a>,
                        statcan: <a href={SOURCE_LINKS.statcan[lang]}>{t(lang, "data.src.statcan_licence")}</a>,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="top-gap">
            {tj(lang, "data.sources_text", {
              wages: <a href={SOURCE_LINKS.wages[lang]}>{t(lang, "data.src.wages")}</a>,
              lfs: <a href={SOURCE_LINKS.lfs[lang]}>{t(lang, "data.src.lfs")}</a>,
              boundaries: <a href={SOURCE_LINKS.boundaries[lang]}>{t(lang, "data.src.boundaries")}</a>,
              statcan: <a href={SOURCE_LINKS.statcan[lang]}>{t(lang, "data.src.statcan_licence")}</a>,
            })}
          </p>
          <p>
            {tj(lang, "data.program_text", {
              program: <a href="/program">{t(lang, "trends.program_link")}</a>,
              terms: <a href={TERMS[lang]}>{t(lang, "program.terms_link")}</a>,
            })}
          </p>
          <p>
            {tj(lang, "places.data_sources", {
              vacancies: <a href={SOURCE_LINKS.vacancies[lang]}>{t(lang, "places.src_vacancies")}</a>,
              noc: <a href={SOURCE_LINKS.noc[lang]}>{t(lang, "places.src_noc")}</a>,
              statcan: <a href={SOURCE_LINKS.statcan[lang]}>{t(lang, "data.src.statcan_licence")}</a>,
            })}
          </p>
          <p id="public-records">
            {tj(lang, "data.public_records_text", {
              grants: <a href={SOURCE_LINKS.grants[lang]}>{t(lang, "data.src.grants")}</a>,
              alberta: <a href={SOURCE_LINKS.alberta[lang]}>{t(lang, "data.src.alberta")}</a>,
              fmcsa: <a href={SOURCE_LINKS.fmcsa[lang]}>{t(lang, "data.src.fmcsa")}</a>,
            })}
          </p>
          <p id="express-entry-sources">
            {tj(lang, "data.ee_sources_text", {
              facet: <a href={FACET_URL[lang]} rel="nofollow noopener">{t(lang, "data.src.facet")}</a>,
              list: <a href={EE_LINKS.list[lang]} rel="noopener">{t(lang, "intl.list_link")}</a>,
              terms: <a href={CANADA_TERMS_URL[lang]}>{t(lang, "data.lic.canada_terms")}</a>,
            })}
          </p>
          {registers.length ? (
            <>
              <h3 id="registers">{t(lang, "data.registers_h")}</h3>
              <div class="table-wrap bordered">
                <table class="restack">
                  <thead>
                    <tr>
                      <th>{t(lang, "data.reg_col_list")}</th>
                      <th>{t(lang, "data.reg_col_format")}</th>
                      <th>{t(lang, "data.reg_col_terms")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registers.map((r) => {
                      const terms = TERMS_NAME[r.terms] ? t(lang, TERMS_NAME[r.terms]) : r.terms;
                      return (
                        <tr>
                          <td data-label={t(lang, "data.reg_col_list")}>
                            <span>{programName(lang, r.program)}, <a href={r.page_url} rel="nofollow noopener">{registerPlace(lang, r)}</a></span>
                          </td>
                          <td data-label={t(lang, "data.reg_col_format")} class="mono">{r.format.toUpperCase()}</td>
                          <td data-label={t(lang, "data.reg_col_terms")}>
                            {r.terms_url ? <a href={r.terms_url} rel="nofollow noopener">{terms}</a> : terms}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          <p class="muted small">{t(lang, "data.code_licence")}</p>
          <p>{t(lang, "data.crawl_text")}</p>

          <h2 id="changelog">{t(lang, "data.toc_changelog")}</h2>
          <div class="table-wrap bordered scroll-y">
            <table>
              <thead>
                <tr>
                  <th>{t(lang, "col.date")}</th>
                  <th>{t(lang, "data.col_change")}</th>
                  <th>{t(lang, "data.col_recomputed")}</th>
                </tr>
              </thead>
              <tbody>
                {changelog(latestPeriod, lang).map((row) => (
                  <tr>
                    <td class="mono nw">{row.date}</td>
                    <td>{t(lang, row.change, row.vars)}</td>
                    <td>{t(lang, row.recomputed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{t(lang, "data.runs")}</h3>
          <div class="table-wrap bordered scroll-y">
            <table>
              <thead>
                <tr>
                  <th>{t(lang, "data.col_run")}</th>
                  <th>{t(lang, "data.col_stage")}</th>
                  <th>{t(lang, "data.col_detail")}</th>
                  <th class="num">{t(lang, "data.col_new_rows")}</th>
                  <th>{t(lang, "data.col_ok")}</th>
                </tr>
              </thead>
              <tbody>
                {stats.runs.length === 0 ? <tr><td colspan={5} class="muted">{t(lang, "data.no_runs")}</td></tr> : stats.runs.map((r) => (
                  <tr>
                    <td class="mono nw">{runTime(r.run_at, lang)}</td>
                    <td>{r.source}</td>
                    <td class="small">{(r.detail ?? "").slice(0, 160)}</td>
                    <td class="mono num">{fmtInt(r.rows_new, lang)}</td>
                    <td>{r.ok ? t(lang, "common.yes") : t(lang, "common.no")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 id="reply">{t(lang, "data.toc_reply")}</h2>
          <div class="cards two">
            <div class="card">
              <h3>{t(lang, "data.reply")}</h3>
              <p class="muted">{t(lang, "data.reply_text")}</p>
              <p>{t(lang, "data.reply_how", { button: t(lang, "employer.respond") })}</p>
            </div>
            <div class="card">
              <h3>{t(lang, "footer.corrections")}</h3>
              <p class="muted">{t(lang, "data.corrections_text")}</p>
              <p><a href="/corrections" class="btn">{t(lang, "employer.correct")}</a></p>
            </div>
          </div>

          <h2 id="about">{t(lang, "data.toc_about")}</h2>
          <p>{t(lang, "data.about_records")}</p>
          <p>{t(lang, "data.about_enforcement")}</p>
          <p>{tj(lang, "data.about_contact", { form: <a href="/corrections">{t(lang, "data.about_form")}</a> })}</p>
          <p>{t(lang, "data.views_note")}</p>
        </div>
      </div>
    </Layout>,
  );
}
