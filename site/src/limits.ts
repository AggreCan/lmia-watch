import type { Context, Next } from "hono";
import type { AppEnv, Env } from "./env";
import { t } from "./i18n";
import { absoluteUrl } from "./seo";

// Which cap a request falls under. The API and the downloads get their own
// because a script can hammer them without ever looking like a visitor; form
// posts get the tightest because each one writes to the database; everything
// else (pages) gets a cap no reader reaches. The Atom feeds get a wide cap of
// their own: one feed service polls many of the feeds for all its readers
// from one address, and a 429 there would also hide those polls from the
// counts (views.ts). Other static files are served before the Worker runs
// and never arrive here.
export type Bucket = "page" | "api" | "download" | "form" | "feed";

export function bucketFor(method: string, path: string): Bucket {
  if (path.startsWith("/data/feeds/")) return "feed";
  if (path.startsWith("/api/")) return "api";
  if (path.startsWith("/downloads/")) return "download";
  if (method === "POST" && (path === "/corrections" || /^\/employers\/[^/]+\/respond$/.test(path))) return "form";
  return "page";
}

// -- AI crawlers ------------------------------------------------------------------------------
//
// The crawlers that read the site for an AI search index, an answer engine or
// a model, by the token each writes in its user agent (lower case). Each has
// one budget for all its addresses: CRAWLER_LIMIT in wrangler.jsonc, counted
// by the crawler's name, since a crawler asks from hundreds of addresses and
// the per-address caps below never see it. In the first two weeks of
// November 2026 Claude-SearchBot, Applebot, Amzn-SearchBot and
// meta-webindexer asked for more than 600,000 pages between them, a quarter
// of the site's requests. public/robots.txt asks them for ten seconds between
// requests, which Apple's crawler does not follow (it "adjusts automatically
// when a site slows down or returns errors"), so the Worker answers 429 past
// the budget.
//
// Not here: the search engines' own crawlers (Googlebot, Bingbot, Yandex),
// which the site wants at their own pace, and an assistant fetching one page
// for a person who asked (ChatGPT-User, Claude-User, Perplexity-User), which
// is a reader. The tokens are whole names, so none of those matches one.
export const AI_CRAWLERS: readonly string[] = [
  "applebot", "claude-searchbot", "claudebot", "anthropic-ai", "oai-searchbot", "gptbot", "perplexitybot", "amzn-searchbot", "meta-webindexer",
  "exasearchbot", "exabot", "keenablebot", "epochal-search", "reflectionbot", "youbot", "duckassistbot", "timpibot", "ai2bot", "bytespider",
  "amazonbot", "ccbot", "meta-externalagent", "facebookbot", "cohere-ai", "diffbot", "imagesiftbot", "omgili", "petalbot",
];

// The crawler a user agent names, as its token; null for a reader, a search
// engine or an agent the list does not hold.
export function crawlerOf(userAgent: string | undefined): string | null {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return null;
  return AI_CRAWLERS.find((token) => ua.includes(token)) ?? null;
}

// The seconds a refused crawler is asked to wait: the budget's own period.
export const CRAWLER_RETRY_S = 60;

// -- search engines ---------------------------------------------------------------------------
//
// Googlebot and Bingbot index the site for people's searches, and the site
// wants every page they will take, at any pace. Google reads no Crawl-delay
// and, on meeting 429s, "reduces your site's crawl rate across the whole
// hostname"; Bing's group in robots.txt carries no delay. So a request that
// Cloudflare's edge has verified as a search engine's crawler, and whose user
// agent names one of the two, is never counted against the per-address page
// cap below. Neither test is enough alone: anyone can write the name, and the
// edge gives the same category to the crawlers of AI indexes (KeenableBot,
// ExaSearchBot and OAI-SearchBot on 2026-11-14), which keep their budget
// above. The other caps (the API, the downloads, the forms) hold for everyone.
export const SEARCH_ENGINES: readonly string[] = ["googlebot", "google-inspectiontool", "bingbot"];
export const SEARCH_ENGINE_CATEGORY = "Search Engine Crawler";

export function searchEngine(userAgent: string | undefined, verifiedBotCategory: unknown): boolean {
  if (verifiedBotCategory !== SEARCH_ENGINE_CATEGORY) return false;
  const ua = (userAgent ?? "").toLowerCase();
  return SEARCH_ENGINES.some((token) => ua.includes(token));
}

// The verified-bot category Cloudflare's edge gave the request, when it gave one.
function edgeCategory(c: Context<AppEnv>): unknown {
  return (c.req.raw as Request & { cf?: { verifiedBotCategory?: unknown } }).cf?.verifiedBotCategory;
}

const BINDING: Record<Bucket, keyof Env> = {
  page: "PAGE_LIMIT", api: "API_LIMIT", download: "DOWNLOAD_LIMIT", form: "FORM_LIMIT", feed: "FEED_LIMIT",
};

// The address Cloudflare saw. The edge sets this header itself and drops any
// copy a client sends, so it cannot be spoofed from outside.
export function clientKey(c: Context<AppEnv>): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

export async function throttle(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  // A crawler's own budget first, before anything is read for it: the answer
  // past it is a few bytes, and its addresses are never counted one by one.
  // The routes made for machines (machineRoute below) stay open to it, so a
  // crawler past its budget can still read the rules, the map and the files.
  const crawler = crawlerOf(c.req.header("user-agent"));
  if (crawler && c.env.CRAWLER_LIMIT && !machineRoute(c.req.path)) {
    let within = true;
    try {
      within = (await c.env.CRAWLER_LIMIT.limit({ key: `crawler:${crawler}` })).success;
    } catch {
      within = true; // a limiter fault must never take the site down
    }
    if (!within) {
      c.header("Retry-After", String(CRAWLER_RETRY_S));
      c.header("Cache-Control", "no-store");
      return c.text(t(c.get("lang") ?? "en", "limits.too_many"), 429);
    }
  }
  const bucket = bucketFor(c.req.method, c.req.path);
  // A verified search engine's crawler reads the pages at its own pace.
  if (bucket === "page" && searchEngine(c.req.header("user-agent"), edgeCategory(c))) return next();
  const limiter = c.env[BINDING[bucket]] as RateLimit | undefined;
  if (!limiter) return next();
  let allowed = true;
  try {
    allowed = (await limiter.limit({ key: `${bucket}:${clientKey(c)}` })).success;
  } catch {
    allowed = true; // a limiter fault must never take the site down
  }
  if (allowed) return next();
  c.header("Retry-After", "60");
  c.header("Cache-Control", "no-store");
  const lang = c.get("lang") ?? "en";
  if (bucket === "api") {
    return c.json({ error: t(lang, "limits.too_many_api") }, 429);
  }
  return c.text(t(lang, "limits.too_many"), 429);
}

// The Lightpanda headless browser names itself "Lightpanda/1.0" (a launch
// flag can append a suffix, hence the prefix match). One operator fetched
// about 32,000 pages a day with it through proxy address ranges, ignoring
// robots.txt. A refusal costs under a millisecond of CPU against about seven
// for a rendered page. The agent string is the operator's to change with a
// launch flag, so this only slows them down; the per-address caps above and
// the edge rules stay the brakes. The routes made for machines stay open, so
// a polite tool still gets the data: the downloads, llms.txt, robots.txt, the
// sitemaps and the Atom feeds. Registered inside the measure middleware
// (index.tsx), so each refusal is counted as a 403 from a bot.
const REFUSED_AGENT = "Lightpanda/";

export function machineRoute(path: string): boolean {
  return (
    path.startsWith("/downloads/") ||
    path.startsWith("/data/feeds/") ||
    path === "/llms.txt" ||
    path === "/robots.txt" ||
    /^\/sitemap(?:-[0-9]+)?\.xml$/.test(path)
  );
}

export async function refuseAutomatedBrowser(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  if (!(c.req.header("user-agent") ?? "").startsWith(REFUSED_AGENT) || machineRoute(c.req.path)) return next();
  c.header("Cache-Control", "private, no-store");
  const text = t(c.get("lang") ?? "en", "limits.automated_browser", {
    downloads: absoluteUrl("/downloads/"),
    example: absoluteUrl("/downloads/employers.csv"),
    llms: absoluteUrl("/llms.txt"),
  });
  return c.text(text, 403);
}
