import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { app } from "../src/index";
import { formsDigest, pageCache, pageCacheable, pageCacheKey } from "../src/pagecache";
import { makeFakeAssets, testEnv } from "./assets";

// Every test runs under a version id of its own, so an entry one test stores
// (in this file or another) never answers a request in another.
function bindings(extra: object = {}) {
  return { ...testEnv(), CF_VERSION_METADATA: { id: `test-${crypto.randomUUID()}`, tag: "" }, ...extra };
}

// A request with an execution context, as in production, waiting for the
// cache write the page cache hands to waitUntil before returning.
async function get(path: string, b: object, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await app.request(path, { headers }, b, ctx);
  const body = await res.text();
  await waitOnExecutionContext(ctx);
  return { res, body };
}

function recorder() {
  const points: AnalyticsEngineDataPoint[] = [];
  const dataset = { writeDataPoint: (p?: AnalyticsEngineDataPoint) => void (p && points.push(p)) } as AnalyticsEngineDataset;
  return { points, dataset };
}

const PROFILE = "/employers/emp-a000000005";
// The headers a page carries besides the cache's own word.
const PAGE_HEADERS = ["content-type", "cache-control", "etag", "link", "content-security-policy", "x-frame-options", "referrer-policy", "x-content-type-options"];
const pick = (res: Response) => Object.fromEntries(PAGE_HEADERS.map((h) => [h, res.headers.get(h)]));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("which requests the page cache considers", () => {
  const ok = (path: string) => pageCacheable("GET", new URL(`https://lmiawatch.ca${path}`));
  it("takes the pages whose content is a function of the URL, the language and the data", () => {
    for (const path of ["/", "/employers/emp-a000000005", "/search", "/map", "/methodology", "/places/bc", "/places/bc/kelowna", "/places/bc/employers/2", "/occupations/63200", "/releases/2026-q1", "/trends/streams", "/rankings/2025", "/feeds", "/watchlist", "/data"]) {
      expect(ok(path), path).toBe(true);
    }
  });

  it("leaves out the forms, the pages that read the clock or the donations, searches, the API, files and ?lang= visits", () => {
    for (const path of ["/employers/emp-a000000005/respond", "/corrections", "/support", "/cite", "/search?q=farm", "/search?status=pending", "/api/stats", "/api/employers/emp-a000000005", "/downloads/employers.csv", "/robots.txt", "/sitemap.xml", "/data/feeds/canada/pending.xml", "/?lang=fr", "/employers/emp-a000000005?lang=en", "/nowhere"]) {
      expect(ok(path), path).toBe(false);
    }
    expect(pageCacheable("HEAD", new URL("https://lmiawatch.ca/methodology"))).toBe(false);
    expect(pageCacheable("POST", new URL("https://lmiawatch.ca/corrections"))).toBe(false);
  });

  it("keys on the version, the data, the forms digest, the language, the path and the query", () => {
    const url = new URL("https://lmiawatch.ca/places/bc/employers/2?x=1");
    expect(pageCacheKey("v1", '"abc"', null, "fr", url)).toBe("https://pages.lmiawatch.invalid/v1.%22abc%22./fr/places/bc/employers/2?x=1");
    expect(pageCacheKey("v1", '"abc"', "0", "en", new URL("https://lmiawatch.ca/employers/emp-a000000005"))).toBe(
      "https://pages.lmiawatch.invalid/v1.%22abc%22.0/en/employers/emp-a000000005",
    );
  });

  it("digests every published row, so an edit in place changes the key", async () => {
    expect(await formsDigest({ responses: [], corrections: [] })).toBe("0");
    const row = { received_at: "2026-11-01T00:00:00Z", record_ref: null, request: "Fix the city.", resolution: null, resolved_at: null };
    const open = await formsDigest({ responses: [], corrections: [row] });
    const resolved = await formsDigest({ responses: [], corrections: [{ ...row, resolution: "Done.", resolved_at: "2026-11-02T00:00:00Z" }] });
    const reworded = await formsDigest({ responses: [], corrections: [{ ...row, request: "Fix the city name." }] });
    expect(open).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set([open, resolved, reworded]).size).toBe(3);
  });
});

describe("the page cache", () => {
  it("serves a profile's second request from the cache with the same body and headers, and counts both", async () => {
    const { points, dataset } = recorder();
    const b = bindings({ VIEWS: dataset });
    const first = await get(PROFILE, b);
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get("x-page-cache")).toBe("miss");
    const second = await get(PROFILE, b);
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get("x-page-cache")).toBe("hit");
    expect(second.body).toBe(first.body);
    expect(pick(second.res)).toEqual(pick(first.res));
    expect(second.res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(second.res.headers.get("link")).toContain("</llms.txt>");
    expect(second.res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(second.res.headers.get("age")).toBeNull();
    expect(second.res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{40}"$/);
    expect(points.map((p) => [p.blobs?.[0], p.blobs?.[1], p.doubles?.[0], p.blobs?.[10]])).toEqual([
      ["/employers/:id", "page", 200, "miss"],
      ["/employers/:id", "page", 200, "hit"],
    ]);
  });

  it("answers a hit's own ETag with an empty 304 without hashing the page", async () => {
    const { points, dataset } = recorder();
    const b = bindings({ VIEWS: dataset });
    const etag = (await get(PROFILE, b)).res.headers.get("etag")!;
    // The page's tag is SHA-1; the test's fake assets binding hashes with SHA-256 for its own ETags.
    const digest = vi.spyOn(crypto.subtle, "digest");
    const again = await get(PROFILE, b, { "if-none-match": etag });
    expect(again.res.status).toBe(304);
    expect(again.body).toBe("");
    expect(again.res.headers.get("etag")).toBe(etag);
    expect(again.res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(again.res.headers.get("content-type")).toBeNull();
    expect(digest.mock.calls.filter(([algorithm]) => algorithm === "SHA-1")).toEqual([]);
    // A tag that does not match gets the cached page itself.
    const other = await get(PROFILE, b, { "if-none-match": 'W/"0000000000000000000000000000000000000000"' });
    expect(other.res.status).toBe(200);
    expect(other.res.headers.get("x-page-cache")).toBe("hit");
    expect(points.map((p) => [p.doubles?.[0], p.blobs?.[10]])).toEqual([[200, "miss"], [304, "hit"], [200, "hit"]]);
  });

  it("keeps the English and French pages apart", async () => {
    const b = bindings();
    const en = await get(PROFILE, b);
    const fr = await get(PROFILE, b, { cookie: "lang=fr" });
    expect(fr.res.headers.get("x-page-cache")).toBe("miss");
    expect(fr.body).toContain("Employeur");
    expect(fr.body).not.toBe(en.body);
    const enAgain = await get(PROFILE, b);
    const frAgain = await get(PROFILE, b, { cookie: "lang=fr" });
    expect([enAgain.res.headers.get("x-page-cache"), frAgain.res.headers.get("x-page-cache")]).toEqual(["hit", "hit"]);
    expect(enAgain.body).toBe(en.body);
    expect(frAgain.body).toBe(fr.body);
  });

  it("misses after a deploy of new code or of new data", async () => {
    const b = bindings();
    await get("/methodology", b);
    expect((await get("/methodology", b)).res.headers.get("x-page-cache")).toBe("hit");
    const newCode = { ...b, CF_VERSION_METADATA: { id: `test-${crypto.randomUUID()}`, tag: "" } };
    expect((await get("/methodology", newCode)).res.headers.get("x-page-cache")).toBe("miss");
    const newData = { ...b, ASSETS: makeFakeAssets({ "stats.json": '"another-deploy"' }) };
    expect((await get("/methodology", newData)).res.headers.get("x-page-cache")).toBe("miss");
    expect((await get("/methodology", newData)).res.headers.get("x-page-cache")).toBe("hit");
  });

  it("changes a profile's key as soon as a correction is published for it", async () => {
    const b = bindings();
    const db = (env as unknown as { DB: D1Database }).DB;
    await get(PROFILE, b);
    const before = await get(PROFILE, b);
    expect(before.res.headers.get("x-page-cache")).toBe("hit");
    const request = "The city on this profile is out of date (page cache test).";
    await db.prepare(
      "INSERT INTO corrections (employer_id, record_ref, received_at, request, resolution, resolved_at, published) VALUES (?, NULL, '2026-11-14T12:00:00Z', ?, NULL, NULL, 1)",
    ).bind("emp-a000000005", request).run();
    try {
      const after = await get(PROFILE, b);
      expect(after.res.headers.get("x-page-cache")).toBe("miss");
      expect(after.body).toContain(request);
      expect((await get(PROFILE, b)).res.headers.get("x-page-cache")).toBe("hit");
    } finally {
      await db.prepare("DELETE FROM corrections WHERE request = ?").bind(request).run();
    }
    // Withdrawn again: the key is the one from before, whose page has no correction.
    const withdrawn = await get(PROFILE, b);
    expect(withdrawn.body).toBe(before.body);
  });

  it("never stores the forms, the corrections page, a search with a query, the API or a ?lang= visit", async () => {
    const { points, dataset } = recorder();
    const b = bindings({ VIEWS: dataset });
    const paths: [string, Record<string, string>][] = [
      ["/employers/emp-a000000005/respond", { "sec-fetch-mode": "navigate" }],
      ["/corrections", {}],
      ["/search?q=farm", {}],
      ["/api/stats", {}],
      ["/api/employers/emp-a000000005", { "sec-fetch-site": "same-origin" }],
      ["/methodology?lang=fr", {}],
    ];
    for (const [path, headers] of paths) {
      for (let i = 0; i < 2; i++) {
        const { res } = await get(path, b, headers);
        expect(res.status, path).toBe(200);
        expect(res.headers.get("x-page-cache"), path).toBeNull();
      }
    }
    expect(points.map((p) => p.blobs?.[10])).toEqual(Array(paths.length * 2).fill(""));
  });

  it("does not store a not-found page", async () => {
    const { points, dataset } = recorder();
    const b = bindings({ VIEWS: dataset });
    for (let i = 0; i < 2; i++) {
      const { res } = await get("/employers/emp-ffffffffff", b);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-page-cache")).toBeNull();
    }
    expect(points.map((p) => [p.doubles?.[0], p.blobs?.[10]])).toEqual([[404, ""], [404, ""]]);
  });

  it("does not store a response that sets a cookie", async () => {
    // A route on a cacheable path that sets a cookie of its own, behind the
    // page cache alone.
    const mini = new Hono<AppEnv>();
    mini.use("*", async (c, next) => {
      c.set("lang", "en");
      await next();
    });
    mini.use("*", pageCache);
    mini.get("/methodology", (c) => {
      c.header("Set-Cookie", "seen=1; Path=/");
      return c.html("<p>a page with a cookie</p>");
    });
    const b = bindings();
    for (let i = 0; i < 2; i++) {
      const ctx = createExecutionContext();
      const res = await mini.request("/methodology", {}, b, ctx);
      await res.text();
      await waitOnExecutionContext(ctx);
      expect(res.headers.get("x-page-cache")).toBe("miss");
      expect(res.headers.get("set-cookie")).toBe("seen=1; Path=/");
    }
  });

  it("renders as usual when the Cache API fails", async () => {
    const normal = await app.request("/methodology", {}, testEnv());
    const html = await normal.text();
    vi.stubGlobal("caches", { open: () => Promise.reject(new Error("cache unavailable")) });
    const b = bindings();
    for (let i = 0; i < 2; i++) {
      const { res, body } = await get("/methodology", b);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-page-cache")).toBe("miss");
      expect(body).toBe(html);
    }
    // A cache that opens but whose reads and writes throw.
    const broken = { match: () => { throw new Error("read failed"); }, put: () => Promise.reject(new Error("write failed")) };
    vi.stubGlobal("caches", { open: async () => broken });
    const { res, body } = await get("/methodology", b);
    expect(res.status).toBe(200);
    expect(body).toBe(html);
  });

  it("renders as usual with no execution context or no version binding, and says nothing about the cache", async () => {
    const plain = await app.request(PROFILE, {}, bindings());
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-page-cache")).toBeNull();
    // The test runtime gives the version binding as production does.
    expect((env as unknown as { CF_VERSION_METADATA?: { id: string } }).CF_VERSION_METADATA?.id).toBeTruthy();
    const { res } = await get(PROFILE, { ...testEnv(), CF_VERSION_METADATA: undefined });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-page-cache")).toBeNull();
  });
});
