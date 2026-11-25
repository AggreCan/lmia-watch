// The government notices page, /notices: IRCC and ESDC news items on
// Canada.ca whose title or summary names one of the programs behind the
// records. The pipeline reads the departments' English and French news feeds
// nightly (pipeline/lmia_pipeline/sources/notices.py), pairs the two
// languages and writes notices.json, which this page and the home page's
// short list render.
//
// Records, not findings: each item is the department's own title, summary
// and link; the page says that the list is not complete and that a notice
// listed here changed no record on the site.

import type { Context } from "hono";
import type { FC } from "hono/jsx";
import { loadJson, loadStats } from "../data";
import type { AppEnv, Env } from "../env";
import { t, tj, tn, type Key, type Lang } from "../i18n";
import { Layout, noDataPage, page } from "../layout";
import { CANADA_TERMS_URL, SOCIAL_CARD, pageTitle, type Seo } from "../seo";
import { isListOf, isNum, isObj, isStr } from "../valid";
import { breadcrumbJsonLd, fitDescription } from "./releases";

// -- the file ----------------------------------------------------------------------------

type Both<T> = { en: T; fr: T };

export interface NoticeItem {
  id: string;
  department: "ircc" | "esdc";
  type: string;
  published: string;
  title: Both<string | null>;
  summary: Both<string | null>;
  url: Both<string | null>;
  terms: Both<string[]>;
  first_seen: string;
}

export interface NoticeFeed {
  key: string;
  department: "ircc" | "esdc";
  lang: Lang;
  state: string;
  checked: string | null;
  last_ok: string | null;
}

export interface NoticesFile {
  as_of: string;
  last_checked: string;
  window_from: string;
  count: number;
  first: string | null;
  last: string | null;
  terms: { label: string; lang: Lang }[];
  feeds: NoticeFeed[];
  items: NoticeItem[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Every title is rendered as a link, so each address is held to canada.ca.
const CANADA_CA = /^https:\/\/www\.canada\.ca\/(en|fr)\/[A-Za-z0-9/._%-]+$/;
const DEPARTMENTS = new Set(["ircc", "esdc"]);
const LANGS = new Set(["en", "fr"]);

const isDate = (v: unknown): v is string => isStr(v) && ISO_DATE.test(v);
const isDateOrNull = (v: unknown): boolean => v === null || isDate(v);
const isTextOrNull = (v: unknown): boolean => v === null || (isStr(v) && v.length > 0);
const isUrlOrNull = (v: unknown): boolean => v === null || (isStr(v) && CANADA_CA.test(v));
const isBoth = (v: unknown, each: (x: unknown) => boolean): boolean => isObj(v) && each(v.en) && each(v.fr);

// One language at least, and each language whole: a title with its link.
const isItem = (v: unknown): v is NoticeItem => isObj(v) && isStr(v.id) && DEPARTMENTS.has(v.department) && isStr(v.type) &&
  isDate(v.published) && isBoth(v.title, isTextOrNull) && isBoth(v.summary, (x) => x === null || isStr(x)) &&
  isBoth(v.url, isUrlOrNull) && isBoth(v.terms, (x) => isListOf(x, isStr)) && isDate(v.first_seen) &&
  (v.title.en !== null || v.title.fr !== null) && (v.title.en === null) === (v.url.en === null) &&
  (v.title.fr === null) === (v.url.fr === null);

const isFeed = (v: unknown): v is NoticeFeed => isObj(v) && isStr(v.key) && DEPARTMENTS.has(v.department) && LANGS.has(v.lang) &&
  isStr(v.state) && isDateOrNull(v.checked) && isDateOrNull(v.last_ok);

export function isNoticesFile(v: unknown): v is NoticesFile {
  if (!isObj(v) || !isDate(v.as_of) || !isDate(v.last_checked) || !isDate(v.window_from)) return false;
  if (!isNum(v.count) || !Number.isInteger(v.count) || v.count < 0 || !isDateOrNull(v.first) || !isDateOrNull(v.last)) return false;
  if (!isListOf(v.terms, (x) => isObj(x) && isStr(x.label) && LANGS.has(x.lang))) return false;
  if (!isListOf(v.feeds, isFeed)) return false;
  // About 300 items a year at the most: a far longer list is a damaged file.
  return isListOf(v.items, isItem) && v.items.length <= 2000 && v.items.length === v.count;
}

export async function loadNotices(env: Env): Promise<NoticesFile | null> {
  const data = await loadJson<unknown>(env, "notices.json").catch(() => null);
  return isNoticesFile(data) ? data : null;
}

// -- formats -----------------------------------------------------------------------------

const TYPE_LABEL: Record<string, Key> = {
  news_release: "notices.type.news_release",
  backgrounder: "notices.type.backgrounder",
  statement: "notices.type.statement",
  speech: "notices.type.speech",
  media_advisory: "notices.type.media_advisory",
};
const DEPT_SHORT: Record<string, Key> = { ircc: "notices.dept.ircc", esdc: "notices.dept.esdc" };
const DEPT_LONG: Record<string, Key> = { ircc: "notices.dept.ircc_long", esdc: "notices.dept.esdc_long" };
const FEED_NAME: Record<string, Key> = { ircc: "notices.feed.ircc", esdc: "notices.feed.esdc" };
const FEED_LANG: Record<string, Key> = { en: "notices.feed_lang.en", fr: "notices.feed_lang.fr" };

// The item in the page's language, or in the other one (marked) when the
// department's feed in this language did not carry it.
export function shown(item: NoticeItem, lang: Lang): { title: string; summary: string; url: string; from: Lang } {
  const other: Lang = lang === "fr" ? "en" : "fr";
  const from = item.title[lang] !== null ? lang : other;
  return { title: item.title[from] ?? "", summary: item.summary[from] ?? "", url: item.url[from] ?? "", from };
}

const NoticeRow: FC<{ item: NoticeItem; lang: Lang }> = ({ item, lang }) => {
  const s = shown(item, lang);
  const other: Lang = lang === "fr" ? "en" : "fr";
  const own = item.terms[s.from];
  const fallback = s.from !== lang;
  const typeKey = TYPE_LABEL[item.type];
  const termsLine = own.length
    ? t(lang, "notices.terms", { terms: own.join(", ") })
    : item.terms[other].length
      ? t(lang, "notices.terms_other", { terms: item.terms[other].join(", ") })
      : "";
  return (
    <li>
      <p class="notice-meta">
        <span class="mono">{item.published}</span> ·{" "}
        <abbr title={t(lang, DEPT_LONG[item.department])}>{t(lang, DEPT_SHORT[item.department])}</abbr>
        {typeKey ? <> · {t(lang, typeKey)}</> : null}
      </p>
      <h3 class="notice-title" lang={fallback ? s.from : undefined}>
        <a href={s.url} rel="nofollow noopener">{s.title}</a>
      </h3>
      {s.summary ? <p class="notice-summary" lang={fallback ? s.from : undefined}>{s.summary}</p> : null}
      {fallback ? <p class="notice-feed">{t(lang, lang === "fr" ? "notices.fr_missing" : "notices.en_missing")}</p> : null}
      <p class="notice-feed">
        {t(lang, "notices.feed", { feed: t(lang, FEED_NAME[item.department]) })}
        {termsLine ? ` ${termsLine}` : ""}
      </p>
    </li>
  );
};

// The keyword list, the page's own language first.
function termList(d: NoticesFile, lang: Lang): string {
  const own = d.terms.filter((x) => x.lang === lang).map((x) => x.label);
  const rest = d.terms.filter((x) => x.lang !== lang).map((x) => x.label);
  return [...own, ...rest].join(", ");
}

// Exported for the head a link preview gets (preview.ts).
export function noticesSeo(lang: Lang): Seo {
  const title = t(lang, "notices.seo_title");
  return {
    path: "/notices",
    title: pageTitle(title),
    socialTitle: title,
    description: fitDescription([t(lang, "notices.seo_desc")]),
    image: SOCIAL_CARD,
    jsonLd: [breadcrumbJsonLd([{ name: t(lang, "common.home"), path: "/" }, { name: t(lang, "notices.h1") }])],
  };
}

const Intro: FC<{ lang: Lang }> = ({ lang }) => (
  <>
    <nav aria-label={t(lang, "employer.breadcrumb")} class="breadcrumb">
      <a href="/">{t(lang, "common.home")}</a> / {t(lang, "notices.h1")}
    </nav>
    <h1>{t(lang, "notices.h1")}</h1>
    <p class="lead">{t(lang, "notices.lead")} {t(lang, "notices.passing")}</p>
    <p>{tj(lang, "notices.is_not", { link: <a href="/methodology">{t(lang, "notices.method_link")}</a> })}</p>
  </>
);

export async function noticesPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const [stats, d] = await Promise.all([loadStats(c.env), loadNotices(c.env)]);
  if (!stats) return noDataPage(c, "notices.h1");
  if (!d) {
    // Missing (no read yet) or unreadable: the page says so and guesses at nothing.
    return page(
      c,
      <Layout lang={lang} title={t(lang, "notices.h1")} dataAsOf={stats.data_as_of} active="/notices" seo={noticesSeo(lang)}>
        <Intro lang={lang} />
        <p>{t(lang, "notices.not_published")}</p>
      </Layout>,
      503,
    );
  }
  const failing = d.feeds.filter((f) => f.state !== "ok");
  return page(
    c,
    <Layout lang={lang} title={t(lang, "notices.h1")} dataAsOf={stats.data_as_of} active="/notices" seo={noticesSeo(lang)}>
      <Intro lang={lang} />
      <h2>
        {d.count && d.first && d.last
          ? tn(lang, "notices.count_one", "notices.count_many", d.count, { n: d.count, first: d.first, last: d.last })
          : t(lang, "notices.none")}
      </h2>
      <p class="muted small">{t(lang, "notices.order")}</p>
      <p class="muted small notice-kept">{t(lang, "notices.kept", { date: d.last_checked })}</p>
      {failing.length ? (
        <p class="muted small notice-kept">
          {t(lang, "notices.not_read", {
            feeds: failing
              .map((f) => {
                const vars = { dept: t(lang, DEPT_SHORT[f.department]), lang: t(lang, FEED_LANG[f.lang]) };
                return f.last_ok
                  ? t(lang, "notices.not_read_feed", { ...vars, date: f.last_ok })
                  : t(lang, "notices.not_read_feed_never", vars);
              })
              .join("; "),
          })}
        </p>
      ) : null}
      {d.items.length ? (
        <ol class="notice-list">
          {d.items.map((item) => <NoticeRow item={item} lang={lang} />)}
        </ol>
      ) : null}
      <section class="panel" aria-labelledby="sources">
        <h2 id="sources">{t(lang, "notices.src_h")}</h2>
        <p>{t(lang, "notices.src_read")}</p>
        <p>{t(lang, "notices.src_terms", { terms: termList(d, lang) })}</p>
        <p>{t(lang, "notices.src_not_covered")}</p>
        <p>{tj(lang, "notices.src_licence", { terms: <a href={CANADA_TERMS_URL[lang]}>{t(lang, "notices.src_terms_link")}</a> })}</p>
      </section>
    </Layout>,
  );
}

// -- the home page's short list ------------------------------------------------------------

export const HOME_NOTICES = 3;

export const HomeNotices: FC<{ d: NoticesFile; lang: Lang }> = ({ d, lang }) => {
  const items = d.items.slice(0, HOME_NOTICES);
  if (!items.length) return null;
  return (
    <section class="topic home-notices" aria-labelledby="home-notices">
      <div class="topic-head">
        <h2 id="home-notices">{t(lang, "notices.home_h")}</h2>
        <a href="/notices">{t(lang, "notices.home_all")}</a>
      </div>
      <ul class="home-notice-list">
        {items.map((item) => {
          const s = shown(item, lang);
          return (
            <li>
              <span class="mono">{item.published}</span>{" "}
              <a href={s.url} rel="nofollow noopener" lang={s.from !== lang ? s.from : undefined}>{s.title}</a>{" "}
              <span class="muted small">{t(lang, DEPT_SHORT[item.department])}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
