// Link previews the edge lets through unverified (WhatsApp, iMessage,
// Mastodon and the like) get a page's head only; see limits.ts previewHead.
import { describe, expect, it } from "vitest";
import edgeAgents from "../src/edge_agents.json";
import { app } from "../src/index";
import { CRAWLER_RETRY_S, previewOf } from "../src/limits";
import { agentClass } from "../src/views";
import { testEnv } from "./assets";

// iMessage writes a browser's agent around the preview names it borrows.
const IMESSAGE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
const WHATSAPP = "WhatsApp/2.23.20.0";
const READER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" };
const PROFILE = "/employers/emp-a000000002";

// A limiter that keeps every key it is asked about and always allows. The
// real bindings would count these requests across the file's tests.
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
const open = () => ({ CRAWLER_LIMIT: keeper().limiter, PAGE_LIMIT: keeper().limiter });

type Options = { category?: unknown; headers?: Record<string, string>; extra?: Record<string, unknown>; method?: string };

// A request as the edge hands it over: the address, the agent, and the verified-bot category when the edge gave one.
function send(ua: string, path: string, { category, headers = {}, extra = {}, method = "GET" }: Options = {}) {
  const req = new Request(`http://localhost${path}`, { method, headers: { "user-agent": ua, "cf-connecting-ip": "203.0.113.80", ...headers } });
  if (category !== undefined) Object.defineProperty(req, "cf", { value: { country: "CA", verifiedBotCategory: category } });
  return app.fetch(req, { ...testEnv(), ...open(), ...extra });
}
const full = async (path: string, headers: Record<string, string> = {}) => {
  const res = await send(READER, path, { headers: { ...NAVIGATE, ...headers } });
  expect(res.status, path).toBe(200);
  return res.text();
};

const title = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
const tag = (html: string, attr: "name" | "property", name: string) =>
  new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`).exec(html)?.[1];
const canonical = (html: string) => /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
// What a preview reads, as the full page's head carries it.
const card = (html: string) => ({
  title: title(html),
  description: tag(html, "name", "description"),
  canonical: canonical(html),
  ogTitle: tag(html, "property", "og:title"),
  ogDescription: tag(html, "property", "og:description"),
  ogUrl: tag(html, "property", "og:url"),
  ogImage: tag(html, "property", "og:image"),
  ogType: tag(html, "property", "og:type"),
  siteName: tag(html, "property", "og:site_name"),
  twitterCard: tag(html, "name", "twitter:card"),
});

describe("a link preview's head", () => {
  it("names the preview fetchers from the edge's list, and no reader or in-app browser", () => {
    expect(previewOf(IMESSAGE)).toBe("facebookexternalhit");
    expect(previewOf(WHATSAPP)).toBe("whatsapp/");
    expect(previewOf("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)")).toBe("discordbot");
    expect(previewOf("http.rb/5.1.1 (Mastodon/4.2.1; +https://mastodon.social/)")).toBe("mastodon/");
    // The desktop apps of Discord and Slack open links in a browser of their own, which names the app without "bot".
    for (const ua of [READER, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.105 Chrome/128.0.0.0 Electron/32.0.0 Safari/537.36 Slack_SSB/4.41.105",
      "", undefined]) {
      expect(previewOf(ua), String(ua)).toBeNull();
    }
    // Matched against the lowered agent, as the edge rule matches them.
    expect(edgeAgents.preview.every((token) => token === token.toLowerCase() && token.length >= 4)).toBe(true);
  });

  it("gives iMessage and WhatsApp a profile's title, description and card with an empty body and no record", async () => {
    const page = await full(PROFILE);
    // The records the full page shows: the street, the posting's title and id, the postal code.
    for (const record of ["405 Martin Street", "assistant store manager", "50440025", "V2A 5L1"]) expect(page).toContain(record);
    for (const ua of [IMESSAGE, WHATSAPP]) {
      const res = await send(ua, PROFILE);
      expect(res.status, ua).toBe(200);
      // Hono writes UTF-8 in capitals on every page; charset names ignore case.
      expect(res.headers.get("content-type"), ua).toMatch(/^text\/html; charset=utf-8$/i);
      expect(res.headers.get("cache-control"), ua).toBe("public, max-age=300");
      expect(res.headers.get("vary"), ua).toContain("User-Agent");
      expect(res.headers.get("link"), ua).toBeNull();
      const head = await res.text();
      expect(head.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>'), ua).toBe(true);
      expect(head.endsWith("</head><body></body></html>"), ua).toBe(true);
      expect(card(head), ua).toEqual(card(page));
      expect(title(head)).toBe("Edsa Mini Mart | LMIA Watch");
      expect(tag(head, "property", "og:title")).toBe("Edsa Mini Mart");
      expect(tag(head, "name", "description")).toBe("Edsa Mini Mart, Penticton, BC: 1 pending Job Bank posting. LMIA records from Job Bank and ESDC, each linked to its source.");
      // The profile's square mark, as the full page carries it.
      expect(tag(head, "property", "og:image")).toBe("https://lmiawatch.ca/social-square.png");
      expect(tag(head, "name", "twitter:card")).toBe("summary");
      for (const record of ["405 Martin Street", "assistant store manager", "50440025", "V2A 5L1"]) expect(head, `${ua} ${record}`).not.toContain(record);
      expect(head).not.toContain("<script");
      expect(head).not.toContain("<main");
    }
  });

  it("answers a HEAD with the head's headers and no body", async () => {
    const res = await send(WHATSAPP, PROFILE, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html; charset=utf-8$/i);
    expect(await res.text()).toBe("");
  });

  it("speaks French by the cookie and by ?lang=fr, as the page does", async () => {
    const path = "/employers/emp-a000000005";
    const page = await full(`${path}?lang=fr`);
    for (const [url, headers] of [[`${path}?lang=fr`, {}], [path, { cookie: "lang=fr" }]] as [string, Record<string, string>][]) {
      const head = await (await send(WHATSAPP, url, { headers })).text();
      expect(head.startsWith('<!doctype html><html lang="fr">'), url).toBe(true);
      expect(card(head), url).toEqual(card(page));
      expect(canonical(head)).toBe("https://lmiawatch.ca/employers/emp-a000000005?lang=fr");
      expect(tag(head, "name", "description")).toContain("EIMT approuvées");
      expect(head).not.toContain("Harvesting labourers");
    }
  });

  it("gives the home page and the pages whose head needs no data file their own title and description", async () => {
    for (const path of ["/", "/methodology", "/search", "/map", "/data", "/support", "/cite", "/corrections", "/watchlist", "/international", "/notices", "/program"]) {
      const page = await full(path);
      const head = await (await send(IMESSAGE, path)).text();
      expect(card(head), path).toEqual(card(page));
      expect(head.endsWith("</head><body></body></html>"), path).toBe(true);
      // The site's wide card on site pages.
      expect(tag(head, "property", "og:image"), path).toBe("https://lmiawatch.ca/social-card.png");
      expect(tag(head, "name", "twitter:card"), path).toBe("summary_large_image");
    }
    const fr = await (await send(IMESSAGE, "/methodology?lang=fr")).text();
    expect(card(fr)).toEqual(card(await full("/methodology?lang=fr")));
  });

  it("gives a page whose head needs its data the home page's title and description under the page's own address", async () => {
    const home = await (await send(WHATSAPP, "/")).text();
    for (const path of ["/places/BC", "/occupations/73300", "/releases/2026-q1", "/trends/pending"]) {
      const head = await (await send(WHATSAPP, path)).text();
      expect(title(head), path).toBe(title(home));
      expect(tag(head, "name", "description"), path).toBe(tag(home, "name", "description"));
      expect(canonical(head), path).toBe(`https://lmiawatch.ca${path}`);
      expect(tag(head, "property", "og:url"), path).toBe(`https://lmiawatch.ca${path}`);
    }
  });

  it("leaves an unknown or malformed employer id to the page's own 404, and a retired id to its redirect", async () => {
    for (const path of ["/employers/emp-ffffffffff", "/employers/nope"]) {
      const res = await send(WHATSAPP, path);
      expect(res.status, path).toBe(404);
      const html = await res.text();
      expect(html, path).toContain("<main");
      const page = await send(READER, path, { headers: NAVIGATE });
      expect(page.status, path).toBe(404);
      await page.body?.cancel();
    }
    const moved = await send(WHATSAPP, "/employers/emp-a00dead001");
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/employers/emp-a000000001");
  });

  it("leaves the response form, the API, the downloads and the feeds as they are", async () => {
    // The response form answers clients that are not browsers with its own 403 (forms.tsx).
    const form = await send(WHATSAPP, "/employers/emp-a000000001/respond");
    const other = await send("ExampleClient/1.0", "/employers/emp-a000000001/respond");
    expect(form.status).toBe(other.status);
    expect(await form.text()).toBe(await other.text());
    const api = await send(WHATSAPP, "/api/stats");
    expect(api.status).toBe(200);
    expect(api.headers.get("content-type")).toMatch(/^application\/json/);
    await api.body?.cancel();
    const csv = "employer_id,name\nemp-a000000001,Example\n";
    const download = await send(WHATSAPP, "/downloads/employers.csv", { extra: { DATA: { get: async () => ({ body: new Response(csv).body }) } } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(csv);
    const feedAssets = {
      fetch: async () => new Response("<feed/>", { headers: { "content-type": "application/atom+xml" } }),
    } as unknown as Fetcher;
    const feed = await app.fetch(
      new Request("http://localhost/data/feeds/canada/pending.xml", { headers: { "user-agent": WHATSAPP, "cf-connecting-ip": "203.0.113.80" } }),
      { ...testEnv(feedAssets), ...open() },
    );
    expect(feed.status).toBe(200);
    expect(await feed.text()).toBe("<feed/>");
  });

  it("gives the full page to a preview fetcher Cloudflare has verified, and to a browser", async () => {
    for (const category of ["Page Preview", "Search Engine Crawler"]) {
      const res = await send(IMESSAGE, PROFILE, { category });
      expect(res.status, category).toBe(200);
      const html = await res.text();
      expect(html, category).toContain("<main");
      expect(html, category).toContain("405 Martin Street");
    }
    // An empty category is no verification.
    expect(await (await send(IMESSAGE, PROFILE, { category: "" })).text()).not.toContain("<main");
    const page = await send(READER, PROFILE, { headers: NAVIGATE });
    expect(await page.text()).toContain("405 Martin Street");
    // A browser-shaped agent with no preview name, even without Fetch Metadata.
    expect(await (await send(READER, PROFILE)).text()).toContain("<main");
  });
});

describe("a link preview's budget", () => {
  const refuse = { limit: async () => ({ success: false }) } as unknown as RateLimit;

  it("is counted by the preview's name on pages only, before the per-address cap", async () => {
    const crawl = keeper();
    const pages = keeper();
    const extra = { CRAWLER_LIMIT: crawl.limiter, PAGE_LIMIT: pages.limiter };
    expect((await send(IMESSAGE, PROFILE, { extra })).status).toBe(200);
    expect((await send(WHATSAPP, "/", { extra })).status).toBe(200);
    expect(crawl.keys).toEqual(["crawler:facebookexternalhit", "crawler:whatsapp/"]);
    expect(pages.keys).toEqual(["page:203.0.113.80", "page:203.0.113.80"]);
    // Not on the API, not when verified, not for a reader.
    crawl.keys.length = 0;
    await (await send(WHATSAPP, "/api/stats", { extra })).body?.cancel();
    await (await send(IMESSAGE, PROFILE, { extra, category: "Page Preview" })).body?.cancel();
    await (await send(READER, PROFILE, { extra, headers: NAVIGATE })).body?.cancel();
    expect(crawl.keys).toEqual([]);
  });

  it("answers 429 with the wait past it, as for an AI crawler, and leaves everyone else alone", async () => {
    const pages = keeper();
    const extra = { CRAWLER_LIMIT: refuse, PAGE_LIMIT: pages.limiter };
    for (const ua of [IMESSAGE, WHATSAPP]) {
      const res = await send(ua, PROFILE, { extra });
      expect(res.status, ua).toBe(429);
      expect(res.headers.get("retry-after"), ua).toBe(String(CRAWLER_RETRY_S));
      expect(res.headers.get("cache-control"), ua).toBe("no-store");
      expect(await res.text(), ua).toBe("Too many requests from this address. Try again in a minute.");
    }
    // Refused before the per-address cap is asked.
    expect(pages.keys).toEqual([]);
    expect((await send(WHATSAPP, "/api/stats", { extra })).status).toBe(200);
    expect((await send(IMESSAGE, PROFILE, { extra, category: "Page Preview" })).status).toBe(200);
    expect((await send(READER, PROFILE, { extra, headers: NAVIGATE })).status).toBe(200);
  });

  it("never takes the head down when the limiter faults", async () => {
    const broken = { limit: async () => { throw new Error("limiter down"); } } as unknown as RateLimit;
    expect((await send(WHATSAPP, PROFILE, { extra: { CRAWLER_LIMIT: broken } })).status).toBe(200);
  });
});

describe("a link preview in the counts", () => {
  function recorder() {
    const points: AnalyticsEngineDataPoint[] = [];
    const dataset = { writeDataPoint: (p?: AnalyticsEngineDataPoint) => { if (p) points.push(p); } } as AnalyticsEngineDataset;
    return { points, dataset };
  }

  it("is a bot's page view with status 200, even with a browser's agent and Fetch Metadata", async () => {
    const { points, dataset } = recorder();
    const extra = { VIEWS: dataset, VIEWS_SALT_KEY: "test-secret" };
    expect((await send(IMESSAGE, PROFILE, { extra, headers: NAVIGATE })).status).toBe(200);
    expect((await send(WHATSAPP, "/?lang=fr", { extra })).status).toBe(200);
    expect(points).toEqual([
      { indexes: ["/employers/:id"], blobs: ["/employers/:id", "page", "en", "", "", "GET", "", "bot", "", "", ""], doubles: [200] },
      { indexes: ["/"], blobs: ["/", "page", "fr", "", "", "GET", "", "bot", "", "", ""], doubles: [200] },
    ]);
  });

  it("counts every preview name as a bot, the ones inside a browser's agent included", () => {
    for (const ua of [IMESSAGE, WHATSAPP, "Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)",
      "Mozilla/5.0 (compatible; Iframely/1.3.1; +https://iframely.com/docs/about)"]) {
      expect(agentClass(ua, undefined, "page", true), ua).toBe("bot");
    }
    for (const token of edgeAgents.preview) expect(agentClass(`Mozilla/5.0 (X11; Linux x86_64) ${token}`, undefined, "page", true), token).toBe("bot");
  });
});
