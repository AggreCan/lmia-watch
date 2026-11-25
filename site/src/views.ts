import type { Context, Next } from "hono";
import edgeAgents from "./edge_agents.json";
import type { AppEnv } from "./env";
import { DOWNLOADS } from "./pages/data";

// Aggregate counts of what the Worker serves, written to Workers Analytics
// Engine (the VIEWS binding in wrangler.jsonc): one data point per response,
// holding the route template, the kind of request, the page language, the
// country code Cloudflare's edge attaches, the referring site's host name,
// the status code, whether the request came from a crawler or a person's
// browser, and the device class read from the user agent. No address, user
// agent, cookie, full referrer or raw path is written (a mistyped or pasted
// URL could carry anything, so a path that matches no route is stored as
// "other"). No script runs in the browser for this.
//
// Blob positions are fixed, because the roll-up reads older days with the
// same columns: blob1 route, blob2 kind, blob3 language, blob4 country,
// blob5 referring host, blob6 method, blob7 feed file (empty except for a
// feed), blob8 "bot" or "human", blob9 device ("desktop", "mobile" or
// "tablet"; empty for a bot), blob10 the visitor code (empty for a bot and
// when VIEWS_SALT_KEY is not set), blob11 the page cache (pagecache.ts):
// "hit" for a page served from it, "miss" for a page it could have served
// that was rendered, empty for everything it does not consider (other
// routes and methods, forms, the API, files, errors). Points written before
// 2026-10-30 stop at blob6 or blob7, and points written before the page
// cache at blob10; the later columns read back as empty strings.
//
// The visitor code counts people per day without keeping anything that
// identifies them: SHA-256 of the day's salt, the client address and the
// user agent, cut to 16 hex characters, where the salt is HMAC-SHA-256 of
// the UTC date under the Worker secret VIEWS_SALT_KEY. The address and the
// user agent are hashed and dropped; the code changes at midnight UTC; and
// without the secret no one can compute a code from an address. Whoever
// holds the secret could recompute a past day's salt, so the secret stays in
// the Worker and nowhere else.
//
// The Atom feeds are the one static file counted: wrangler.jsonc runs the
// Worker first for /data/feeds/*, so a feed reader's poll passes through
// here. Its point also holds the feed's file name (only when the file was
// served, so a typed path is never stored) and the subscriber count the
// reader states in its user agent. A feed poll is always a bot: a reader
// polls on a schedule whoever reads the result.
//
// Other static files under /data/ and /fonts/ never reach the Worker, and a
// request the per-address limits answer with 429 stops before this
// middleware, so neither is counted. The plan's included data points match
// its included requests (100,000 a day on the free plan, 10 million a month
// on the paid one), so one point per response cannot exceed them. Data
// points are kept for three months; the nightly run keeps a daily roll-up in
// R2 (pipeline/lmia_pipeline/views_rollup.py).

export type Kind = "page" | "api" | "download" | "form" | "hook" | "file" | "feed" | "other";

const PAGES = new Set([
  "/", "/search", "/map", "/methodology", "/data", "/support", "/cite", "/corrections",
  "/feeds", "/watchlist", "/releases", "/rankings", "/trends", "/program", "/occupations", "/places",
  "/international", "/notices",
]);
const API_FIXED = new Set(["/api/stats", "/api/pending", "/api/clusters", "/api/search", "/api/search/facets"]);
const DOWNLOAD_FILES = new Set(DOWNLOADS.map((d) => d.file));
// The feed files feeds.py writes: feeds/<scope folders>/<event>.xml.
const FEED_PATH = /^\/data\/(feeds\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.xml)$/;

export function routeTemplate(method: string, path: string): { route: string; kind: Kind } {
  if (PAGES.has(path)) return { route: path, kind: method === "POST" ? "form" : "page" };
  if (/^\/employers\/[^/]+$/.test(path)) return { route: "/employers/:id", kind: "page" };
  if (/^\/employers\/[^/]+\/respond$/.test(path)) return { route: "/employers/:id/respond", kind: method === "POST" ? "form" : "page" };
  if (/^\/releases\/[^/]+$/.test(path)) return { route: "/releases/:slug", kind: "page" };
  if (/^\/rankings\/[^/]+$/.test(path)) return { route: "/rankings/:year", kind: "page" };
  if (/^\/trends\/[^/]+$/.test(path)) return { route: "/trends/:view", kind: "page" };
  if (/^\/occupations\/[^/]+$/.test(path)) return { route: "/occupations/:noc", kind: "page" };
  if (/^\/places\/[^/]+$/.test(path)) return { route: "/places/:prov", kind: "page" };
  if (/^\/places\/[^/]+\/employers$/.test(path)) return { route: "/places/:prov/employers", kind: "page" };
  if (/^\/places\/[^/]+\/employers\/[^/]+$/.test(path)) return { route: "/places/:prov/employers/:page", kind: "page" };
  if (/^\/places\/[^/]+\/[^/]+$/.test(path)) return { route: "/places/:prov/:slug", kind: "page" };
  if (path.startsWith("/api/")) {
    if (API_FIXED.has(path)) return { route: path, kind: "api" };
    if (/^\/api\/employers\/[^/]+$/.test(path)) return { route: "/api/employers/:id", kind: "api" };
    if (/^\/api\/area\/[^/]+$/.test(path)) return { route: "/api/area/:fsa", kind: "api" };
    return { route: "/api/other", kind: "api" };
  }
  if (path.startsWith("/downloads/")) {
    const file = path.slice("/downloads/".length);
    if (DOWNLOAD_FILES.has(file)) return { route: path, kind: "download" };
    if (/^mirror\/[A-Za-z0-9._-]+$/.test(file)) return { route: "/downloads/mirror/:file", kind: "download" };
    return { route: "/downloads/other", kind: "download" };
  }
  if (FEED_PATH.test(path)) return { route: "/data/feeds/:file", kind: "feed" };
  if (path === "/data/feeds/index.json") return { route: path, kind: "file" };
  if (path === "/hooks/kofi") return { route: path, kind: "hook" };
  if (path === "/robots.txt" || path === "/llms.txt") return { route: path, kind: "file" };
  if (/^\/sitemap(?:-[0-9]+)?\.xml$/.test(path)) return { route: "/sitemap.xml", kind: "file" };
  return { route: "other", kind: "other" };
}

// The host name of an http(s) referrer, lower case, and nothing else: no
// path, no query, no port. Anything else is "".
export function referrerHost(header: string | undefined | null): string {
  if (!header) return "";
  try {
    const url = new URL(header);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    const host = url.hostname.toLowerCase();
    return /^[a-z0-9.-]{1,100}$/.test(host) ? host : "";
  } catch {
    return "";
  }
}

export function countryCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z0-9]{2}$/.test(value) ? value : "";
}

// Readers that poll a feed for many people say how many in their user agent:
// "Feedly/1.0 (+https://feedly.com/poller.html; 12 subscribers; like
// FeedFetcher-Google)", "inoreader.com; 9 subscribers". Only the number before
// the word is read; 0 when there is none. The cap keeps a forged header from
// writing an absurd figure.
export function subscriberCount(userAgent: string | undefined | null): number {
  if (!userAgent) return 0;
  const m = /(?:^|[^0-9])([0-9]{1,9})\s+subscribers?\b/i.exec(userAgent.slice(0, 512));
  return m ? Number(m[1]) : 0;
}

// The feed's path under /data/, kept only when the file was served (200, or
// 304 to a reader that already has it): the file names are the pipeline's,
// while a path that found no file could hold whatever was typed.
export function feedFile(path: string, status: number): string {
  if (status !== 200 && status !== 304) return "";
  const m = FEED_PATH.exec(path);
  return m && m[1].length <= 120 ? m[1] : "";
}

export type Agent = "bot" | "human";
export type Device = "desktop" | "mobile" | "tablet" | "";

// Words that crawlers, link previews, monitors and scripts put in their user
// agents. "bot" is not matched inside "Cubot", a phone maker whose model names
// appear in ordinary Android user agents. "lmiawatch" is the site's own
// client (the nightly smoke test and key check). The link-preview names the
// edge lets through unverified (edge_agents.json) are all here too, since
// the Worker answers them with a page's head (limits.ts) and some write a
// browser's agent around their own name (iMessage), so each counts as a bot
// whatever headers come with it.
const BOT_UA = new RegExp(
  [
    "(?<!cu)bot", "crawl", "spider", "slurp", "fetch", "python-requests", "curl", "wget", "headless", "lmiawatch",
    "http-client", "okhttp", "axios", "libwww", "scrapy", "httpx", "aiohttp", "java/", "facebookexternalhit",
    "embedly", "whatsapp", "preview", "lighthouse", "pingdom", "uptime", "monitor", "archiver", "validator",
    "googleother", "google-", "feed", "rss", "phantomjs", "selenium", "puppeteer", "playwright",
    ...edgeAgents.preview.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  ].join("|"),
  "i",
);
// Every browser in use names itself "Mozilla/5.0 (...)" (old Opera: "Opera/9.80"),
// so an agent that does not is a program: Go-http-client, Dart, PostmanRuntime.
const BROWSER_UA = /^(?:Mozilla|Opera)\//;

// Fetch Metadata: every current browser sends these three headers with a
// navigation and with its pages' own requests (over HTTPS, which the zone
// enforces). A plain HTTP client sends none of them, even when it borrows a
// browser's user agent. Browsers from before them (Chrome before 76, Firefox
// before 90, Safari before 16.4) send none either, so the few still in use
// are undercounted as people.
const FETCH_METADATA = ["sec-fetch-mode", "sec-fetch-dest", "sec-fetch-site"];

export function hasFetchMetadata(headers: Headers): boolean {
  return FETCH_METADATA.some((name) => headers.has(name));
}

// "bot" when Cloudflare's edge names the request a verified bot (any
// category: search engine, monitoring, feed fetcher and so on), when the
// user agent is missing, is not shaped like a browser's or carries one of the
// words above, when a browser-shaped agent comes with no Fetch Metadata
// header, and for every feed poll and payment hook (programs by nature).
// Everything else is "human": a person's browser, or a crawler that copies
// a browser's headers too, which no header can tell apart. fetchMetadata says
// whether the request carried any of the three headers; it defaults to true
// so a test of the user agent alone reads it as a browser would send it.
export function agentClass(
  userAgent: string | undefined | null, verifiedBotCategory: unknown, kind?: Kind, fetchMetadata = true,
): Agent {
  if (kind === "feed" || kind === "hook") return "bot";
  if (typeof verifiedBotCategory === "string" && verifiedBotCategory.trim() !== "") return "bot";
  const ua = (userAgent ?? "").slice(0, 512);
  if (!ua.trim() || !BROWSER_UA.test(ua) || BOT_UA.test(ua)) return "bot";
  if (!fetchMetadata) return "bot";
  return "human";
}

// The device class a user agent states. iPadOS asks for desktop pages and
// says "Macintosh", so most iPads count as desktop; Chromium's client hint
// Sec-CH-UA-Mobile ("?1") marks a phone that asked for the desktop site.
export function deviceClass(userAgent: string | undefined | null, mobileHint?: string | null): Device {
  const ua = (userAgent ?? "").slice(0, 512);
  if (!ua.trim()) return "";
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/Mobi|iPhone|iPod|Windows Phone|BlackBerry|BB10|Opera Mini/i.test(ua) || mobileHint?.trim() === "?1") return "mobile";
  return "desktop";
}

// The UTC date a request belongs to, as YYYY-MM-DD. Inside a request the
// Worker's clock stands at the request's start.
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One salt per UTC day per isolate: HMAC-SHA-256 of the date under the secret.
let saltCache: { day: string; secret: string; salt: string } | null = null;

export async function dailySalt(secret: string, day: string): Promise<string> {
  if (saltCache && saltCache.day === day && saltCache.secret === secret) return saltCache.salt;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const salt = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(day)));
  saltCache = { day, secret, salt };
  return salt;
}

// The visitor code: SHA-256 of salt, address and user agent (newline
// separated, so no two different inputs run together into the same text),
// cut to 16 hex characters. "" without a secret: then no uniques are counted.
export async function visitorHash(secret: string | undefined | null, day: string, ip: string, userAgent: string): Promise<string> {
  if (!secret) return "";
  const salt = await dailySalt(secret, day);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}\n${ip}\n${userAgent}`));
  return hex(digest).slice(0, 16);
}

type EdgeProps = { country?: unknown; verifiedBotCategory?: unknown };

function edge(c: Context<AppEnv>): EdgeProps | undefined {
  return (c.req.raw as Request & { cf?: EdgeProps }).cf;
}

export function requestAgent(c: Context<AppEnv>): Agent {
  const { kind } = routeTemplate(c.req.method, c.req.path);
  return agentClass(c.req.header("user-agent"), edge(c)?.verifiedBotCategory, kind, hasFetchMetadata(c.req.raw.headers));
}

// The data point for the response in c. visitor is the visitor code, written
// for a human request only.
export function viewPoint(c: Context<AppEnv>, visitor = ""): AnalyticsEngineDataPoint {
  const { route, kind } = routeTemplate(c.req.method, c.req.path);
  const cf = edge(c);
  const lang = c.get("lang") === "fr" ? "fr" : "en";
  const ua = c.req.header("user-agent");
  const agent = agentClass(ua, cf?.verifiedBotCategory, kind, hasFetchMetadata(c.req.raw.headers));
  const blobs = [
    route, kind, lang, countryCode(cf?.country), referrerHost(c.req.header("referer")), c.req.method.slice(0, 8),
    kind === "feed" ? feedFile(c.req.path, c.res.status) : "",
    // The device and the visitor code describe a person's browser, so a bot leaves both empty.
    agent, agent === "human" ? deviceClass(ua, c.req.header("sec-ch-ua-mobile")) : "",
    agent === "human" && /^[0-9a-f]{16}$/.test(visitor) ? visitor : "",
    c.get("pageCache") ?? "",
  ];
  const doubles = [c.res.status];
  // double2 for a feed only; every other point leaves it empty (read back as 0).
  if (kind === "feed") doubles.push(subscriberCount(ua));
  return { indexes: [route], blobs, doubles };
}

export async function recordView(c: Context<AppEnv>): Promise<void> {
  const dataset = c.env.VIEWS;
  if (!dataset) return; // tests and local development have no binding
  try {
    let visitor = "";
    if (requestAgent(c) === "human") {
      try {
        visitor = await visitorHash(c.env.VIEWS_SALT_KEY, utcDay(), c.req.header("cf-connecting-ip") ?? "", c.req.header("user-agent") ?? "");
      } catch (e) {
        // The point is still written, with no code; that day's uniques read blank.
        console.error(`views: no visitor code: ${String(e).slice(0, 200)}`);
      }
    }
    dataset.writeDataPoint(viewPoint(c, visitor));
  } catch (e) {
    // A counting fault must never cost a reader the page.
    console.error(`views: ${String(e).slice(0, 200)}`);
  }
}

export async function measure(c: Context<AppEnv>, next: Next): Promise<void> {
  try {
    await next();
  } finally {
    await recordView(c);
  }
}
