import type { Context } from "hono";
import { loadJson, loadStats } from "../data";
import type { AppEnv } from "../env";
import { fmtInt, provinceName, streamLabel, t, tj, type Key, type Lang } from "../i18n";
import { Layout, page } from "../layout";
import { SITE_ORIGIN, SOCIAL_CARD, type Seo, pageTitle } from "../seo";

// The pipeline writes the feeds as static files under /data/feeds/ (feeds.py).
// A reader's poll passes through the Worker only to be counted (index.tsx
// serves the file from the assets binding with a short cache). This page
// reads only the small index of what was written: scoped feeds come and go
// with the data, the four national feeds are always there.

export const FEED_EVENTS = ["pending", "approved", "findings", "quarters"] as const;
export type FeedEvent = (typeof FEED_EVENTS)[number];
type ScopeKind = "canada" | "prov" | "stream" | "noc" | "cma";

export interface FeedRow {
  scope: ScopeKind;
  key: string;
  name: string | null;
  event: FeedEvent;
  path: string;
  entries: number;
  updated: string | null;
}

export interface FeedIndex {
  as_of: string;
  max_entries: number;
  fresh_days: number;
  quarter_fresh_days: number;
  feeds: FeedRow[];
}

const EVENT_KEY: Record<FeedEvent, Key> = {
  pending: "feeds.ev.pending",
  approved: "feeds.ev.approved",
  findings: "feeds.ev.findings",
  quarters: "feeds.ev.quarters",
};
const ABOUT_KEY: Record<FeedEvent, Key> = {
  pending: "feeds.about.pending",
  approved: "feeds.about.approved",
  findings: "feeds.about.findings",
  quarters: "feeds.about.quarters",
};
const NOC_CATEGORY: Record<string, Key> = {
  "0": "feeds.noc_cat.0", "1": "feeds.noc_cat.1", "2": "feeds.noc_cat.2", "3": "feeds.noc_cat.3", "4": "feeds.noc_cat.4",
  "5": "feeds.noc_cat.5", "6": "feeds.noc_cat.6", "7": "feeds.noc_cat.7", "8": "feeds.noc_cat.8", "9": "feeds.noc_cat.9",
};

export const nationalFeedPath = (event: FeedEvent) => `feeds/canada/${event}.xml`;

// The NOC 2021 major group is the first two digits of a code: the broad
// occupational category, then the TEER level.
export function nocGroupLabel(lang: Lang, code: string): string {
  const category = NOC_CATEGORY[code.charAt(0)];
  if (!/^\d{2}$/.test(code) || !category) return code;
  return t(lang, "feeds.noc_group", { code, category: t(lang, category), teer: code.charAt(1) });
}

// Atom autodiscovery for the national feeds, for a page's head (home, search, feeds).
export const FeedLinks = ({ lang }: { lang: Lang }) => (
  <>
    {FEED_EVENTS.map((e) => (
      <link rel="alternate" type="application/atom+xml" title={t(lang, "feeds.link_title", { event: t(lang, EVENT_KEY[e]) })} href={`/data/${nationalFeedPath(e)}`} />
    ))}
  </>
);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// A missing or malformed index reads as "no scoped feeds yet", never an error.
export async function loadFeedIndex(c: Context<AppEnv>): Promise<FeedIndex | null> {
  const index = await loadJson<FeedIndex>(c.env, "feeds/index.json").catch(() => null);
  if (!isObject(index) || !Array.isArray(index.feeds)) return null;
  const feeds = index.feeds.filter(
    (f): f is FeedRow => isObject(f) && typeof f.path === "string" && /^feeds\/[A-Za-z0-9/_-]+\.xml$/.test(f.path)
      && FEED_EVENTS.includes(f.event as FeedEvent) && typeof f.key === "string",
  );
  return { ...index, feeds };
}

// Exported for the head a link preview gets (preview.ts).
export function feedsSeo(lang: Lang): Seo {
  const name = t(lang, "feeds.title");
  return { path: "/feeds", title: pageTitle(name), socialTitle: name, description: t(lang, "feeds.description"), image: SOCIAL_CARD };
}

const Address = ({ path }: { path: string }) => (
  <a href={`/data/${path}`} class="mono" style="overflow-wrap:anywhere">{`${SITE_ORIGIN}/data/${path}`}</a>
);

export async function feedsPage(c: Context<AppEnv>): Promise<Response> {
  const lang = c.get("lang");
  const stats = await loadStats(c.env).catch(() => null);
  const index = await loadFeedIndex(c);
  const feeds = index?.feeds ?? [];
  const n = (v: number) => fmtInt(v, lang);

  // One table per scope kind: a row per scope, a column per event it can carry.
  const ScopeTable = ({ kind, events, head, label, order }: {
    kind: ScopeKind;
    events: readonly FeedEvent[];
    head: Key;
    label: (row: FeedRow) => string;
    order?: (a: FeedRow, b: FeedRow) => number;
  }) => {
    const rows = feeds.filter((f) => f.scope === kind);
    const byKey = new Map<string, Map<FeedEvent, FeedRow>>();
    for (const f of rows) {
      if (!byKey.has(f.key)) byKey.set(f.key, new Map());
      byKey.get(f.key)!.set(f.event, f);
    }
    const keys = [...byKey.values()].map((m) => [...m.values()][0]);
    keys.sort(order ?? ((a, b) => label(a).localeCompare(label(b), lang === "fr" ? "fr-CA" : "en-CA")));
    if (!index) return <p class="muted">{t(lang, "feeds.none_yet")}</p>;
    if (keys.length === 0) return <p class="muted">{t(lang, "feeds.none_scope")}</p>;
    return (
      <div class="table-wrap bordered">
        <table class="restack">
          <thead>
            <tr>
              <th>{t(lang, head)}</th>
              {events.map((e) => <th>{t(lang, EVENT_KEY[e])}</th>)}
            </tr>
          </thead>
          <tbody>
            {keys.map((first) => {
              const name = label(first);
              const cells = byKey.get(first.key)!;
              return (
                <tr>
                  <td data-label={t(lang, head)}>{name}</td>
                  {events.map((e) => {
                    const f = cells.get(e);
                    return (
                      <td data-label={t(lang, EVENT_KEY[e])}>
                        {f ? (
                          <a href={`/data/${f.path}`} class="mono" aria-label={t(lang, "feeds.cell_aria", { scope: name, event: t(lang, EVENT_KEY[e]) })}>
                            {f.path.split("/").pop()}
                          </a>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const pattern = (folder: string) => (
    <p class="muted small">
      {tj(lang, "feeds.pattern", { pattern: <span class="mono" style="overflow-wrap:anywhere">{`${SITE_ORIGIN}/data/feeds/${folder}/<feed>.xml`}</span> })}
    </p>
  );

  const toc: [string, Key][] = [
    ["kinds", "feeds.toc_kinds"],
    ["canada", "feeds.toc_canada"],
    ["province", "feeds.toc_prov"],
    ["stream", "feeds.toc_stream"],
    ["occupation", "feeds.toc_noc"],
    ["area", "feeds.toc_cma"],
    ["subscribe", "feeds.toc_subscribe"],
  ];

  return page(
    c,
    <Layout lang={lang} title={t(lang, "feeds.title")} dataAsOf={stats?.data_as_of ?? null} active="/feeds" head={<FeedLinks lang={lang} />} seo={feedsSeo(lang)}>
      <div class="doc-layout">
        <nav class="toc" aria-label={t(lang, "toc.label")}>
          <span class="toc-title">{t(lang, "toc.title")}</span>
          {toc.map(([id, key]) => <a href={`#${id}`}>{t(lang, key)}</a>)}
        </nav>
        <div class="doc">
          <h1>{t(lang, "feeds.title")}</h1>
          <p class="lead">{t(lang, "feeds.lead")}</p>
          <p>{t(lang, "feeds.privacy")}</p>
          <p>{t(lang, "feeds.records_note")}</p>

          <h2 id="kinds">{t(lang, "feeds.toc_kinds")}</h2>
          <ul>
            {FEED_EVENTS.map((e) => (
              <li><strong>{t(lang, EVENT_KEY[e])}</strong>{lang === "fr" ? " : " : ": "}{t(lang, ABOUT_KEY[e])}</li>
            ))}
          </ul>
          <p class="muted small">
            {t(lang, "feeds.fresh_note", { days: n(index?.fresh_days ?? 90), qdays: n(index?.quarter_fresh_days ?? 400) })}
          </p>

          <h2 id="canada">{t(lang, "feeds.toc_canada")}</h2>
          <div class="table-wrap bordered">
            <table class="restack">
              <thead>
                <tr>
                  <th>{t(lang, "feeds.col_feed")}</th>
                  <th>{t(lang, "feeds.col_address")}</th>
                </tr>
              </thead>
              <tbody>
                {FEED_EVENTS.map((e) => (
                  <tr>
                    <td data-label={t(lang, "feeds.col_feed")}>{t(lang, EVENT_KEY[e])}</td>
                    <td data-label={t(lang, "feeds.col_address")}><Address path={nationalFeedPath(e)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 id="province">{t(lang, "feeds.toc_prov")}</h2>
          {pattern("prov/<code>")}
          <ScopeTable
            kind="prov"
            events={FEED_EVENTS}
            head="feeds.col_prov"
            label={(f) => provinceName(lang, f.key)}
            order={(a, b) => (a.key === "XX" ? 1 : b.key === "XX" ? -1 : provinceName(lang, a.key).localeCompare(provinceName(lang, b.key), lang === "fr" ? "fr-CA" : "en-CA"))}
          />

          <h2 id="stream">{t(lang, "feeds.toc_stream")}</h2>
          <p>{t(lang, "feeds.stream_note")}</p>
          {pattern("stream/<stream>")}
          <ScopeTable kind="stream" events={["quarters"]} head="col.stream" label={(f) => streamLabel(lang, f.name ?? f.key)} />

          <h2 id="occupation">{t(lang, "feeds.toc_noc")}</h2>
          <p>{t(lang, "feeds.noc_note")}</p>
          {pattern("noc/<group>")}
          <ScopeTable
            kind="noc"
            events={["pending", "approved", "quarters"]}
            head="feeds.col_noc"
            label={(f) => nocGroupLabel(lang, f.key)}
            order={(a, b) => a.key.localeCompare(b.key)}
          />

          <h2 id="area">{t(lang, "feeds.toc_cma")}</h2>
          <p>{t(lang, "feeds.cma_note")}</p>
          {pattern("cma/<code>")}
          <ScopeTable kind="cma" events={FEED_EVENTS} head="feeds.col_cma" label={(f) => f.name ?? f.key} />

          <h2 id="subscribe">{t(lang, "feeds.toc_subscribe")}</h2>
          <ul>
            <li>{t(lang, "feeds.sub_reader")}</li>
            <li>{tj(lang, "feeds.sub_slack", { command: <span class="mono id">/feed subscribe</span> })}</li>
            <li>{t(lang, "feeds.sub_teams")}</li>
            <li>{t(lang, "feeds.sub_email")}</li>
          </ul>
          <p>{tj(lang, "feeds.watch_note", { watchlist: <a href="/watchlist">{t(lang, "feeds.watch_link")}</a> })}</p>
        </div>
      </div>
    </Layout>,
  );
}
