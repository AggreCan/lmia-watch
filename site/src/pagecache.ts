// A cache of rendered pages, in the Cache API of the Cloudflare location
// running the Worker. A scraper fleet and the AI search crawlers fetch each
// of the 160,000 profiles three or four times a day, through the same
// location, and nothing on a page depends on who asks: the watchlist lives in
// the browser, and the daily visitor code is computed from the request
// (views.ts), not from the body. A render costs several milliseconds of CPU
// (the profile shard parsed, the other files read, the page built and
// hashed; the mean request, start-up aside, was about 8 ms on 2026-11-13)
// and a hit under a tenth of that (scripts/bench-render.mjs: 1.8 ms against
// 0.14 ms in Node).
//
// What is cached: a GET for a page whose content is a function of the URL,
// the language and the data, answered 200 with HTML and no cookie. Never the
// response form, the corrections form, the support page (it reads the
// donation notices, which arrive at any time), the citation page (it prints
// today's date), a search with a query string, the API, the downloads, the
// feeds, or any request carrying ?lang= (the language middleware answers it
// with a cookie). The rate limits and the refusal of automated browsers run
// before this middleware (index.tsx), so a refused request never reaches the
// cache; the views counter runs around it, so a hit is counted like a render.
//
// The key holds everything the page is a function of: the Worker's version id
// (a deploy of new code never serves a page the old code rendered), the ETag
// of stats.json (the data deploy), the page's language, path and query, and
// for a profile a digest of its published responses and corrections in the
// forms database, which change between deploys: a response or correction
// published, resolved or withdrawn changes the key at once. Those rows are
// read before the lookup and handed to the page through the context
// (siteRows), so a profile still reads them once. The copy is stored with a
// day's max-age so the Cache API keeps it that long; the version in the key
// bounds what can be stale, and keys of older versions age out unread.
//
// A hit is sent with the page's own headers (stored without any cookie), with
// the page's five-minute Cache-Control in place of the stored one. The copy
// carries the page's ETag, computed once when it is stored, and conditional.ts
// compares a hit's tag without hashing the body again. X-Page-Cache says
// "hit" or "miss" on every page the cache could answer, and the context's
// pageCache variable carries the same word to the views counter.
//
// Every failure (no Cache API, no execution context as in the tests, no
// version binding, no data ETag, the forms database unreadable, a Cache API
// call that throws) falls back to rendering the page as if there were no
// cache.

import type { Context, Next } from "hono";
import { bodyEtag } from "./conditional";
import { assetResponse, EMPLOYER_ID_RE } from "./data";
import type { AppEnv } from "./env";
import { loadSiteRows, type SiteRows } from "./pages/employer";
import { routeTemplate } from "./views";

const CACHE_NAME = "pages";
const KEY_ORIGIN = "https://pages.lmiawatch.invalid";
// The page's own Cache-Control (layout.tsx, page()), sent with a hit.
const PAGE_CACHE_CONTROL = "public, max-age=300";
// What the stored copy carries, so the Cache API keeps it for a day.
const STORED_CACHE_CONTROL = "public, max-age=86400";
// Headers the Cache API adds to a matched response, which are not the page's:
// an Age past 300 seconds would make a browser treat the page as stale.
const ADDED_BY_CACHE = ["age", "cf-cache-status", "expires"];

// Page routes (views.ts routeTemplate) whose content is not a function of the
// URL, the language and the deployed data.
const NEVER = new Set(["/employers/:id/respond", "/corrections", "/support", "/cite"]);

export function pageCacheable(method: string, url: URL): boolean {
  if (method !== "GET" || url.searchParams.has("lang")) return false;
  const { route, kind } = routeTemplate(method, url.pathname);
  if (kind !== "page" || NEVER.has(route)) return false;
  return !(route === "/search" && url.search !== "");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A short digest of a profile's published responses and corrections: every
// column the page shows, so a statement or a resolution edited in place also
// changes it. "0" for the usual profile with neither.
export async function formsDigest(rows: SiteRows): Promise<string> {
  if (rows.responses.length === 0 && rows.corrections.length === 0) return "0";
  const text = JSON.stringify([rows.responses, rows.corrections]);
  return hex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text))).slice(0, 16);
}

// The synthetic URL a page is stored under.
export function pageCacheKey(versionId: string, dataTag: string, forms: string | null, lang: string, url: URL): string {
  const version = [versionId, dataTag, forms ?? ""].map(encodeURIComponent).join(".");
  return `${KEY_ORIGIN}/${version}/${lang}${url.pathname}${url.search}`;
}

function isHtml(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");
}

function executionContext(c: Context<AppEnv>): { waitUntil(promise: Promise<unknown>): void } | null {
  try {
    return c.executionCtx; // Hono throws when the request came without one
  } catch {
    return null;
  }
}

// The key for this request, or null when the cache cannot be used for it.
async function keyFor(c: Context<AppEnv>, url: URL): Promise<string | null> {
  const versionId = c.env.CF_VERSION_METADATA?.id;
  if (!versionId || typeof caches === "undefined") return null;
  const id = /^\/employers\/([^/]+)$/.exec(url.pathname)?.[1];
  // A malformed id is a 404 page, which is never stored.
  if (id !== undefined && !EMPLOYER_ID_RE.test(id)) return null;
  const [stats, rows] = await Promise.all([assetResponse(c.env, "stats.json"), id ? loadSiteRows(c.env, id) : null]);
  const dataTag = stats?.headers.get("etag") ?? null;
  await stats?.body?.cancel().catch(() => undefined);
  if (!dataTag) return null;
  if (id) {
    if (!rows) return null; // the page reads them again and renders without the cache
    c.set("siteRows", rows);
  }
  return pageCacheKey(versionId, dataTag, rows ? await formsDigest(rows) : null, c.get("lang"), url);
}

export async function pageCache(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const url = new URL(c.req.url);
  if (!pageCacheable(c.req.method, url)) return next();
  const ctx = executionContext(c);
  if (!ctx) return next();
  let key: string | null = null;
  try {
    key = await keyFor(c, url);
  } catch (e) {
    console.error(`page cache key: ${String(e).slice(0, 200)}`);
  }
  if (!key) return next();

  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(key);
    if (hit && hit.status === 200) {
      const headers = new Headers(hit.headers);
      for (const name of ADDED_BY_CACHE) headers.delete(name);
      headers.set("Cache-Control", PAGE_CACHE_CONTROL);
      headers.set("X-Page-Cache", "hit");
      c.set("pageCache", "hit");
      return new Response(hit.body, { status: 200, headers });
    }
  } catch (e) {
    console.error(`page cache read: ${String(e).slice(0, 200)}`);
    cache = null;
  }

  await next();
  const res = c.res;
  if (res.status !== 200 || !isHtml(res)) return;
  c.set("pageCache", "miss");
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  if (!headers.has("etag")) headers.set("ETag", await bodyEtag(body));
  headers.set("X-Page-Cache", "miss");
  // As in conditional.ts: cleared first so Hono does not merge the old
  // response's headers into the new one.
  c.res = undefined;
  c.res = new Response(body, { status: 200, headers });
  if (!cache || headers.has("set-cookie")) return;
  const stored = new Headers(headers);
  stored.delete("x-page-cache");
  stored.set("Cache-Control", STORED_CACHE_CONTROL);
  try {
    ctx.waitUntil(
      cache.put(key, new Response(body, { status: 200, headers: stored })).catch((e) => {
        console.error(`page cache write: ${String(e).slice(0, 200)}`);
      }),
    );
  } catch (e) {
    console.error(`page cache write: ${String(e).slice(0, 200)}`);
  }
}
