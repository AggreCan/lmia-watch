// Conditional requests for the HTML pages: each 200 page carries a weak ETag
// taken from its rendered body, and a request whose If-None-Match names that
// tag gets a 304 with no body. A crawler coming back to one of the 160,000
// profiles whose records did not change then gets no body back. The page is
// still rendered (the Worker cannot know the tag without it), so the saving
// is in bytes sent and in the crawler's budget, not in CPU.
//
// The tag must come from the body: one URL renders in English or in French
// depending on the lang cookie, and a page reads several data files (the
// profile, the area, the place and occupation indexes) plus the forms
// database, so neither the URL nor one file's ETag names what was sent. The
// tag is weak because the edge may compress the body, which keeps a weak tag
// and drops a strong one.
//
// Registered inside the measure middleware (index.tsx), so the views counter
// records a 304 as a 304. A page that already carries its ETag (a page served
// from the page cache, or one the page cache tagged as it stored it, see
// pagecache.ts) is compared without hashing again. Every other response
// passes untouched: other statuses, other methods, anything not HTML (the
// API, the downloads, the sitemaps, robots.txt), and the Atom feeds under
// /data/feeds, which pass the assets layer's own ETag and 304 through.

import type { Context, Next } from "hono";
import type { AppEnv } from "./env";

// The headers a 304 repeats from the full response (RFC 9110, section
// 15.4.5): the validator, the caching rules, and the cookie the language
// middleware sets on a ?lang= visit, so switching language still sticks.
const KEPT = ["etag", "cache-control", "vary"];

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function bodyEtag(body: ArrayBuffer): Promise<string> {
  return `W/"${hex(await crypto.subtle.digest("SHA-1", body))}"`;
}

// If-None-Match compares weakly: W/"x" and "x" name the same tag. "*" matches
// any current representation.
export function noneMatch(header: string | undefined | null, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  const want = opaque(etag);
  return header.split(",").some((tag) => {
    const t = tag.trim();
    return t === "*" || (t !== "" && opaque(t) === want);
  });
}

// The empty 304 for a page whose tag the request named.
function notModified(headers: Headers): Response {
  const kept = new Headers();
  for (const name of KEPT) {
    const value = headers.get(name);
    if (value !== null) kept.set(name, value);
  }
  for (const cookie of headers.getSetCookie()) kept.append("set-cookie", cookie);
  return new Response(null, { status: 304, headers: kept });
}

export async function conditional(c: Context<AppEnv>, next: Next): Promise<void> {
  await next();
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") return;
  const res = c.res;
  if (res.status !== 200 || c.req.path.startsWith("/data/")) return;
  if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) return;
  const tagged = res.headers.get("etag");
  if (tagged !== null) {
    if (!noneMatch(c.req.header("if-none-match"), tagged)) return;
    await res.body?.cancel().catch(() => undefined);
    const headers = new Headers(res.headers);
    c.res = undefined;
    c.res = notModified(headers);
    return;
  }
  const body = await res.arrayBuffer();
  const etag = await bodyEtag(body);
  const headers = new Headers(res.headers);
  headers.set("ETag", etag);
  // Hono copies the old response's headers onto one assigned to c.res, which
  // would put the content headers back on the 304; clearing it first stops that.
  c.res = undefined;
  if (noneMatch(c.req.header("if-none-match"), etag)) {
    c.res = notModified(headers);
    return;
  }
  c.res = new Response(body, { status: 200, headers });
}
