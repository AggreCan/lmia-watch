import type { Context } from "hono";
import { loadStats } from "../data";
import type { AppEnv } from "../env";
import { clientStrings, numberLocale, t, tj, type Key, type Lang } from "../i18n";
import { ClientData, Layout, page } from "../layout";
import { SOCIAL_CARD, type Seo, pageTitle } from "../seo";

// The watchlist lives in the visitor's browser (localStorage) and nowhere
// else. The server sends a shell that reads as a document with scripts off;
// public/watchlist.js fills the table from the same profile shards the
// profile pages read (/data/profiles/<abc>.json), served as static files.

// The most employers one browser can watch: each costs one shard fetch on load.
export const WATCH_MAX = 100;

// Every string watchlist.js draws, handed over in the page's JSON block.
export const WATCHLIST_CLIENT_KEYS: readonly Key[] = [
  "status.pending", "status.approved", "status.refused", "status.lapsed", "status.finding", "status.none",
  "col.employer", "col.status", "employer.pending_postings", "employer.approved_lmias", "employer.refused_lmias",
  "employer.findings_count", "employer.positions_paren_one", "employer.positions_paren_many",
  "watch.col_latest", "watch.col_new", "watch.col_manage", "watch.remove", "watch.remove_aria",
  "watch.loading", "watch.count_one", "watch.count_many", "watch.last_visit", "watch.first_visit",
  "watch.nothing_new", "watch.added_since",
  "watch.new_postings_one", "watch.new_postings_many", "watch.new_approved_one", "watch.new_approved_many",
  "watch.new_positive_one", "watch.new_positive_many", "watch.new_negative_one", "watch.new_negative_many",
  "watch.new_findings_one", "watch.new_findings_many", "watch.status_was",
  "watch.missing", "watch.load_failed", "watch.no_storage",
  "watch.export_empty", "watch.import_one", "watch.import_many", "watch.import_known", "watch.import_none",
  "watch.import_full",
];

export function watchlistClientData(lang: Lang) {
  return { lang, locale: numberLocale(lang), max: WATCH_MAX, strings: clientStrings(lang, WATCHLIST_CLIENT_KEYS) };
}

// Exported for the head a link preview gets (preview.ts).
export function watchlistSeo(lang: Lang): Seo {
  const name = t(lang, "watch.title");
  return { path: "/watchlist", title: pageTitle(name), socialTitle: name, description: t(lang, "watch.description"), image: SOCIAL_CARD };
}

export async function watchlistPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const stats = await loadStats(c.env).catch(() => null);
  const columns: Key[] = [
    "col.employer", "col.status", "employer.pending_postings", "employer.approved_lmias", "employer.refused_lmias",
    "employer.findings_count", "watch.col_latest", "watch.col_new", "watch.col_manage",
  ];
  return page(
    c,
    <Layout lang={lang} title={t(lang, "watch.title")} dataAsOf={stats?.data_as_of ?? null} active="/watchlist" seo={watchlistSeo(lang)}>
      <h1>{t(lang, "watch.title")}</h1>
      <p class="lead">{t(lang, "watch.lead")}</p>
      <p>{t(lang, "watch.privacy")}</p>
      <p class="muted small">{t(lang, "watch.records_note")} {t(lang, "watch.limit_note", { max: WATCH_MAX })}</p>

      <p id="watch-status" class="top-gap" aria-live="polite"></p>
      <div class="table-wrap bordered" id="watchlist" data-max={String(WATCH_MAX)}>
        <table class="restack">
          <thead>
            <tr>
              {columns.map((k) => <th class={/lmias|pending_postings|findings_count/.test(k) ? "num" : undefined}>{t(lang, k)}</th>)}
            </tr>
          </thead>
          <tbody id="watch-rows">
            <tr>
              <td colspan={columns.length} class="muted" id="watch-empty">
                {tj(lang, "watch.empty", { search: <a href="/search">{t(lang, "watch.search_link")}</a> })}
                <noscript> {t(lang, "watch.noscript")}</noscript>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div id="watch-move" hidden>
        <h2>{t(lang, "watch.move_h")}</h2>
        <p>{t(lang, "watch.move_text")}</p>
        <div class="stack">
          <p>
            <button type="button" class="btn" id="watch-export">{t(lang, "watch.export")}</button>
          </p>
          {/* hidden sits on a plain div: .stack label sets display, which would override it */}
          <div id="watch-code-box" hidden>
            <label>
              {t(lang, "watch.export_label")}
              <textarea id="watch-code" rows={3} readonly spellcheck={false}></textarea>
            </label>
          </div>
          <label>
            {t(lang, "watch.import_label")}
            <textarea id="watch-import-text" rows={3} spellcheck={false}></textarea>
          </label>
          <button type="button" class="btn" id="watch-import">{t(lang, "watch.import")}</button>
          <p id="watch-move-status" class="muted" aria-live="polite"></p>
        </div>
      </div>
      <ClientData id="i18n" data={watchlistClientData(lang)} />
      <script src="/watchlist.js"></script>
    </Layout>,
  );
}
