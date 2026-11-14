import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { AI_CRAWLERS, CRAWLER_RETRY_S, bucketFor, crawlerOf, machineRoute } from "../src/limits";
import robotsTxt from "../public/robots.txt?raw";
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

// -- AI crawlers: one budget a crawler, whatever address it asks from ---------------------------

const APPLEBOT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)";
const CLAUDE_SEARCH = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +searchbot@anthropic.com)";
const AMZN_SEARCH = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-SearchBot/0.1) Chrome/119.0.6045.214 Safari/537.36";
const GOOGLEBOT = "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const READER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

describe("an AI crawler's budget", () => {
  const as = (ua: string, ip: string, path: string, extra: Record<string, unknown> = {}) =>
    app.request(path, { headers: { "user-agent": ua, "cf-connecting-ip": ip } }, { ...testEnv(), ...extra });

  it("names the crawlers of AI indexes and models, and no reader, search engine or assistant fetching one page for a person", () => {
    expect(crawlerOf(APPLEBOT)).toBe("applebot");
    expect(crawlerOf(CLAUDE_SEARCH)).toBe("claude-searchbot");
    expect(crawlerOf(AMZN_SEARCH)).toBe("amzn-searchbot");
    expect(crawlerOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-webindexer/1.1)")).toBe("meta-webindexer");
    expect(crawlerOf("Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai/)")).toBe("exasearchbot");
    for (const ua of [READER, GOOGLEBOT, "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)", "Perplexity-User/1.0",
      "Feedly/1.0 (+https://feedly.com/poller.html; 12 subscribers; like FeedFetcher-Google)", "", undefined]) {
      expect(crawlerOf(ua), String(ua)).toBeNull();
    }
    // Lower case, whole names, each once.
    expect(AI_CRAWLERS.every((token) => token === token.toLowerCase() && token.length >= 5)).toBe(true);
    expect(new Set(AI_CRAWLERS).size).toBe(AI_CRAWLERS.length);
  });

  it("is counted by the crawler's name and never by its address, before the per-address cap", async () => {
    const crawl = keeper();
    const pages = keeper();
    const extra = { CRAWLER_LIMIT: crawl.limiter, PAGE_LIMIT: pages.limiter };
    expect((await as(APPLEBOT, "17.22.237.11", "/methodology", extra)).status).toBe(200);
    expect((await as(APPLEBOT, "17.22.245.87", "/data", extra)).status).toBe(200);
    expect((await as(CLAUDE_SEARCH, "216.73.216.4", "/methodology", extra)).status).toBe(200);
    expect(crawl.keys).toEqual(["crawler:applebot", "crawler:applebot", "crawler:claude-searchbot"]);
    // Within its budget it is a page request like any other.
    expect(pages.keys).toEqual(["page:17.22.237.11", "page:17.22.245.87", "page:216.73.216.4"]);
    // A reader and a search engine have no such budget.
    crawl.keys.length = 0;
    expect((await as(READER, "203.0.113.50", "/methodology", extra)).status).toBe(200);
    expect((await as(GOOGLEBOT, "66.249.66.1", "/methodology", extra)).status).toBe(200);
    expect(crawl.keys).toEqual([]);
  });

  it("answers 429 past it with the wait, reading nothing more, and leaves the routes made for machines open", async () => {
    const pages = keeper();
    const refuse = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const extra = { CRAWLER_LIMIT: refuse, PAGE_LIMIT: pages.limiter };
    const res = await as(APPLEBOT, "17.22.237.11", "/employers/emp-a000000001", extra);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(CRAWLER_RETRY_S));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.text()).length).toBeLessThan(200);
    // Refused before the per-address cap is asked: nothing else ran for it.
    expect(pages.keys).toEqual([]);
    // The real assets binding, which serves site/public, with the refusing limiter beside it.
    for (const path of ["/robots.txt", "/llms.txt"]) {
      const open = await app.request(path, { headers: { "user-agent": APPLEBOT, "cf-connecting-ip": "17.22.237.11" } }, { ...env, ...extra });
      expect(open.status, path).toBe(200);
    }
    // A reader is untouched by a crawler's refusal.
    expect((await as(READER, "203.0.113.51", "/methodology", extra)).status).toBe(200);
  });

  it("never takes the site down when the limiter faults", async () => {
    const broken = { limit: async () => { throw new Error("limiter down"); } } as unknown as RateLimit;
    expect((await as(APPLEBOT, "17.22.237.11", "/methodology", { CRAWLER_LIMIT: broken })).status).toBe(200);
  });

  it("is ten requests a minute for a crawler, from any number of addresses", async () => {
    if (!(env as unknown as { CRAWLER_LIMIT?: unknown }).CRAWLER_LIMIT) return;
    let first429 = 0;
    for (let i = 1; i <= 14; i++) {
      const res = await as(AMZN_SEARCH, `198.51.100.${i}`, "/methodology");
      if (res.status === 429) {
        first429 = i;
        break;
      }
      expect(res.status, `request ${i}`).toBe(200);
    }
    expect(first429).toBe(11);
    // Another crawler has its own budget.
    expect((await as(CLAUDE_SEARCH, "198.51.100.90", "/methodology")).status).toBe(200);
  });

  it("is what robots.txt tells the same crawlers: their own group, the general rules and ten seconds apart", () => {
    const groups = robotsTxt.split(/\n\s*\n/).filter((g) => /^User-agent:/m.test(g));
    const group = groups.find((g) => /^User-agent: Applebot$/m.test(g)) ?? "";
    const lines = group.split("\n").filter((l) => l && !l.startsWith("#"));
    const agents = lines.filter((l) => l.startsWith("User-agent: ")).map((l) => l.slice(12));
    expect(agents).toEqual(expect.arrayContaining(["Applebot", "Claude-SearchBot", "OAI-SearchBot", "Amzn-SearchBot", "meta-webindexer", "ExaSearchBot"]));
    // Every crawler the file gives this group or shuts out, the Worker holds to the budget too.
    const shut = groups.find((g) => /^Disallow: \/$/m.test(g)) ?? "";
    const named = [...agents, ...shut.split("\n").filter((l) => l.startsWith("User-agent: ")).map((l) => l.slice(12))];
    // Not budgeted: two tokens that are a preference and never a crawler, and the link-index tools, which the file shuts out and are not AI crawlers.
    const NOT_BUDGETED = ["ShapBot", "Google-Extended", "Applebot-Extended", "DataForSeoBot", "AhrefsBot", "SemrushBot", "MJ12bot", "DotBot"];
    for (const name of named.filter((n) => !NOT_BUDGETED.includes(n))) expect(crawlerOf(`${name}/1.0`), name).not.toBeNull();
    // The general group's rules, repeated, since a crawler reads only its own group.
    const general = (groups.find((g) => /^User-agent: \*$/m.test(g)) ?? "").split("\n").filter((l) => /^(Allow|Disallow):/.test(l));
    for (const rule of general) expect(lines, rule).toContain(rule);
    expect(lines).toContain("Crawl-delay: 10");
    // The pages stay open to them.
    for (const closed of ["Disallow: /employers/", "Disallow: /occupations/", "Disallow: /places/", "Disallow: /"]) expect(lines).not.toContain(closed);
  });
});
