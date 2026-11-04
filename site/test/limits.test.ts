import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { bucketFor, machineRoute } from "../src/limits";
import { testEnv } from "./assets";

const from = (ip: string, path: string, init: RequestInit = {}, assets?: Fetcher) =>
  app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), "cf-connecting-ip": ip } }, testEnv(assets));

const FEED = "/data/feeds/canada/pending.xml";
// One feed, served the way the assets binding serves it.
const feedAssets = {
  fetch: async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).pathname === FEED
      ? new Response("<feed/>", { headers: { "content-type": "application/atom+xml" } })
      : new Response("not found", { status: 404 });
  },
} as unknown as Fetcher;

// A limiter that keeps every key it is asked about and always allows.
function keeper() {
  const keys: string[] = [];
  const limiter = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: true };
    },
  } as unknown as RateLimit;
  return { keys, limiter };
}

describe("request buckets", () => {
  it("sorts paths into the right cap", () => {
    expect(bucketFor("GET", "/api/stats")).toBe("api");
    expect(bucketFor("GET", "/downloads/employers.csv")).toBe("download");
    expect(bucketFor("POST", "/corrections")).toBe("form");
    expect(bucketFor("POST", "/employers/emp-a000000001/respond")).toBe("form");
    expect(bucketFor("GET", "/corrections")).toBe("page");
    expect(bucketFor("GET", "/employers/emp-a000000001")).toBe("page");
    expect(bucketFor("POST", "/hooks/kofi")).toBe("page");
    expect(bucketFor("GET", FEED)).toBe("feed");
    expect(bucketFor("GET", "/data/feeds/index.json")).toBe("feed");
    expect(bucketFor("GET", "/feeds")).toBe("page");
  });

  it("counts a feed poll against the feed cap, never the page cap", async () => {
    const page = keeper();
    const feed = keeper();
    const env = { ...testEnv(feedAssets), PAGE_LIMIT: page.limiter, FEED_LIMIT: feed.limiter };
    const poll = await app.request(FEED, { headers: { "cf-connecting-ip": "203.0.113.20" } }, env);
    expect(poll.status).toBe(200);
    expect(feed.keys).toEqual(["feed:203.0.113.20"]);
    expect(page.keys).toEqual([]);
    expect((await app.request("/feeds", { headers: { "cf-connecting-ip": "203.0.113.20" } }, env)).status).toBe(200);
    expect(page.keys).toEqual(["page:203.0.113.20"]);
    expect(feed.keys).toHaveLength(1);
  });
});

describe("per-address limits", () => {
  const limiters = env as unknown as { API_LIMIT?: unknown; FORM_LIMIT?: unknown; PAGE_LIMIT?: unknown; FEED_LIMIT?: unknown };

  it("refuses the 121st page in a minute while a feed poll from the same address still answers", async () => {
    if (!limiters.PAGE_LIMIT || !limiters.FEED_LIMIT) return;
    const ip = "203.0.113.21";
    let first429 = 0;
    for (let i = 1; i <= 125; i++) {
      const res = await from(ip, "/methodology", {}, feedAssets);
      if (res.status === 429) {
        first429 = i;
        expect(res.headers.get("retry-after")).toBe("60");
        break;
      }
      expect(res.status, `page ${i}`).toBe(200);
    }
    expect(first429).toBe(121);
    const poll = await from(ip, FEED, {}, feedAssets);
    expect(poll.status).toBe(200);
    expect(await poll.text()).toBe("<feed/>");
  });

  it("answers 429 on the API past 60 requests a minute from one address", async () => {
    if (!limiters.API_LIMIT) return; // no binding in this environment: nothing is limited
    let first429 = 0;
    for (let i = 1; i <= 70; i++) {
      const res = await from("203.0.113.7", "/api/stats");
      if (res.status === 429) {
        first429 = i;
        expect(res.headers.get("retry-after")).toBe("60");
        expect(((await res.json()) as { error: string }).error).toContain("60 requests a minute");
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(first429).toBeGreaterThan(50);
    expect(first429).toBeLessThanOrEqual(70);
    // Another address is unaffected.
    expect((await from("203.0.113.8", "/api/stats")).status).toBe(200);
  });

  it("caps form posts tightly and leaves the form page alone", async () => {
    if (!limiters.FORM_LIMIT) return;
    const body = new URLSearchParams({ record_ref: "emp-a000000002", request: "The street address on this profile is out of date." }).toString();
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    let statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await from("203.0.113.9", "/corrections", { method: "POST", headers, body })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect((await from("203.0.113.9", "/corrections")).status).toBe(200);
  });
});

// The Lightpanda headless browser is refused on everything but the routes made
// for machines, which point it at the files instead.
describe("automated browsers", () => {
  const LIGHTPANDA = "Lightpanda/1.0";
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const as = (agent: string, ip: string, path: string, bindings: object = testEnv(), headers: Record<string, string> = {}) =>
    app.request(path, { headers: { "user-agent": agent, "cf-connecting-ip": ip, ...headers } }, bindings);

  it("refuses Lightpanda on pages with a plain-text pointer to the files", async () => {
    for (const path of ["/", "/employers/emp-a000000001", "/search?q=farm", "/corrections", "/api/stats", "/nothing-here"]) {
      const res = await as(LIGHTPANDA, "203.0.113.60", path);
      expect(res.status, path).toBe(403);
      expect(res.headers.get("content-type"), path).toMatch(/^text\/plain/);
      expect(res.headers.get("cache-control"), path).toBe("private, no-store");
      const text = await res.text();
      expect(text, path).toBe(
        "Automated browsers are not served pages on this site. The complete dataset is in the files under " +
          "https://lmiawatch.ca/downloads/ (for example https://lmiawatch.ca/downloads/employers.csv), " +
          "and the guide for machines at https://lmiawatch.ca/llms.txt lists every file.",
      );
    }
    // The flag that appends to the agent string changes nothing.
    expect((await as("Lightpanda/1.0 ExampleCrawler/2.0", "203.0.113.60", "/")).status).toBe(403);
    // In the visitor's language, resolved as for any page.
    for (const [path, headers] of [["/?lang=fr", {}], ["/", { cookie: "lang=fr" }]] as [string, Record<string, string>][]) {
      const fr = await (await as(LIGHTPANDA, "203.0.113.60", path, testEnv(), headers)).text();
      expect(fr, path).toContain("Ce site ne sert pas ses pages aux navigateurs automatisés.");
      expect(fr, path).toContain("https://lmiawatch.ca/downloads/");
      expect(fr, path).toContain("https://lmiawatch.ca/llms.txt");
    }
  });

  it("leaves the routes made for machines open to it", async () => {
    expect(["/downloads/employers.csv", "/downloads/mirror/x.csv", "/llms.txt", "/robots.txt", "/sitemap.xml", "/sitemap-3.xml", "/data/feeds/canada/pending.xml"]
      .every(machineRoute)).toBe(true);
    expect(["/", "/downloads", "/data", "/api/stats", "/sitemaps.xml", "/llms.txt/x", "/employers/emp-a000000001"].some(machineRoute)).toBe(false);

    const csv = "employer_id,name\nemp-a000000001,Example\n";
    const bucket = { ...testEnv(), DATA: { get: async () => ({ body: new Response(csv).body }) } };
    const download = await as(LIGHTPANDA, "203.0.113.61", "/downloads/employers.csv", bucket);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(csv);
    // llms.txt and robots.txt from the real assets binding, which serves site/public.
    for (const path of ["/llms.txt", "/robots.txt"]) {
      const res = await as(LIGHTPANDA, "203.0.113.61", path, env);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/^text\/plain/);
      await res.body?.cancel();
    }
    const sitemap = await as(LIGHTPANDA, "203.0.113.61", "/sitemap.xml");
    expect(sitemap.status).toBe(200);
    const feed = await as(LIGHTPANDA, "203.0.113.61", FEED, testEnv(feedAssets));
    expect(feed.status).toBe(200);
    expect(await feed.text()).toBe("<feed/>");
  });

  it("serves the same pages to a browser, and to an agent that only mentions Lightpanda", async () => {
    for (const agent of [CHROME, "Mozilla/5.0 (compatible; Lightpanda/1.0)"]) {
      for (const path of ["/", "/employers/emp-a000000001"]) {
        const res = await as(agent, "203.0.113.62", path);
        expect(res.status, `${agent} ${path}`).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        await res.body?.cancel();
      }
    }
  });
});
