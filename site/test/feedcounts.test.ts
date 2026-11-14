import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { feedFile, routeTemplate, subscriberCount } from "../src/views";
import { testEnv } from "./assets";

const FEED = `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>New pending postings</title></feed>\n`;
const ETAG = '"feed-etag-1"';
const FEEDLY = "Feedly/1.0 (+https://feedly.com/poller.html; 12 subscribers; like FeedFetcher-Google)";
const IP = "198.51.100.7";

// A stand-in for the assets binding holding one feed and the feed index. It
// answers a matching If-None-Match with 304, as the asset server does, and
// keeps every request it was given.
function feedAssets(fail = false) {
  const asked: Request[] = [];
  const assets = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (fail) throw new Error("assets unavailable");
      const req = input instanceof Request ? input : new Request(input, init);
      asked.push(req);
      const path = new URL(req.url).pathname;
      const headers = { "content-type": "application/atom+xml", etag: ETAG, "cache-control": "public, max-age=0, must-revalidate", "x-asset": "yes" };
      if (path === "/data/feeds/index.json") return new Response('{"feeds":[]}', { headers: { "content-type": "application/json" } });
      if (path !== "/data/feeds/canada/pending.xml") return new Response("not found", { status: 404 });
      if (req.headers.get("if-none-match") === ETAG) return new Response(null, { status: 304, headers });
      return new Response(FEED, { headers });
    },
  } as unknown as Fetcher;
  return { asked, assets };
}

function recorder() {
  const points: AnalyticsEngineDataPoint[] = [];
  const dataset = {
    writeDataPoint(p?: AnalyticsEngineDataPoint) {
      if (p) points.push(p);
    },
  } as AnalyticsEngineDataset;
  return { points, dataset };
}

function poll(path: string, assets: Fetcher, dataset: AnalyticsEngineDataset, init: RequestInit = {}) {
  const headers = { "user-agent": FEEDLY, "cf-connecting-ip": IP, ...(init.headers as Record<string, string>) };
  return app.request(path, { ...init, headers }, { ...testEnv(assets), VIEWS: dataset });
}

describe("subscriber counts in a feed reader's user agent", () => {
  it("reads only the number before the word", () => {
    expect(subscriberCount(FEEDLY)).toBe(12);
    expect(subscriberCount("inoreader.com; 9 subscribers")).toBe(9);
    expect(subscriberCount("NewsBlur Feed Fetcher - 1 subscriber - https://www.newsblur.com/site/1/x")).toBe(1);
    expect(subscriberCount("Feedbin feed-id:1234 - 42 subscribers")).toBe(42);
    expect(subscriberCount("theoldreader.com (3 Subscribers)")).toBe(3);
    expect(subscriberCount("Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0")).toBe(0);
    expect(subscriberCount("12 subscribed")).toBe(0);
    expect(subscriberCount(undefined)).toBe(0);
    expect(subscriberCount("")).toBe(0);
    // Ten digits or more is a forged header, not a figure.
    expect(subscriberCount("Reader 12345678901 subscribers")).toBe(0);
  });
});

describe("feed route templates", () => {
  it("names every feed by one template and keeps the file name only for a file that was served", () => {
    expect(routeTemplate("GET", "/data/feeds/canada/pending.xml")).toEqual({ route: "/data/feeds/:file", kind: "feed" });
    expect(routeTemplate("GET", "/data/feeds/prov/BC/approved.xml")).toEqual({ route: "/data/feeds/:file", kind: "feed" });
    expect(routeTemplate("GET", "/data/feeds/index.json")).toEqual({ route: "/data/feeds/index.json", kind: "file" });
    for (const path of ["/data/feeds/someone@example.com.xml", "/data/feeds/a/../b.xml", "/data/feeds/x.txt", "/data/stats.json"]) {
      expect(routeTemplate("GET", path), path).toEqual({ route: "other", kind: "other" });
    }
    expect(feedFile("/data/feeds/canada/pending.xml", 200)).toBe("feeds/canada/pending.xml");
    expect(feedFile("/data/feeds/canada/pending.xml", 304)).toBe("feeds/canada/pending.xml");
    expect(feedFile("/data/feeds/made-up/name.xml", 404)).toBe("");
    expect(feedFile("/data/feeds/canada/pending.xml", 503)).toBe("");
  });
});

describe("the feed route", () => {
  it("serves the feed's bytes and headers with a short cache, and records one point with the count and no user agent", async () => {
    const { assets, asked } = feedAssets();
    const { points, dataset } = recorder();
    const res = await poll("/data/feeds/canada/pending.xml", assets, dataset);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FEED);
    expect(res.headers.get("content-type")).toBe("application/atom+xml");
    expect(res.headers.get("etag")).toBe(ETAG);
    expect(res.headers.get("x-asset")).toBe("yes");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0].url).pathname).toBe("/data/feeds/canada/pending.xml");
    // One point: the measure middleware writes it, the route adds none.
    expect(points).toEqual([
      {
        indexes: ["/data/feeds/:file"],
        blobs: ["/data/feeds/:file", "feed", "en", "", "", "GET", "feeds/canada/pending.xml", "bot", "", "", ""],
        doubles: [200, 12],
      },
    ]);
    const raw = JSON.stringify(points);
    for (const secret of [IP, "Feedly", "feedly.com", "poller", "FeedFetcher", "subscribers"]) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  it("passes the reader's conditional request on, so a reader that has the file gets a 304", async () => {
    const { assets } = feedAssets();
    const { points, dataset } = recorder();
    const res = await poll("/data/feeds/canada/pending.xml", assets, dataset, {
      headers: { "if-none-match": ETAG, "user-agent": "inoreader.com; 9 subscribers" },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(ETAG);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(points).toHaveLength(1);
    expect(points[0].blobs?.[6]).toBe("feeds/canada/pending.xml");
    expect(points[0].doubles).toEqual([304, 9]);
  });

  it("answers a feed path with no file with the site's 404 page, and stores no name for it", async () => {
    const { assets } = feedAssets();
    const { points, dataset } = recorder();
    for (const path of ["/data/feeds/prov/ZZ/pending.xml", "/data/feeds/someone@example.com.xml", "/data/feeds/nothing.txt"]) {
      const res = await poll(path, assets, dataset);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain("<h1>");
    }
    expect(points.map((p) => [p.blobs?.[0], p.blobs?.[1], p.blobs?.[6], p.doubles?.[0]])).toEqual([
      ["/data/feeds/:file", "feed", "", 404],
      ["other", "other", "", 404],
      ["other", "other", "", 404],
    ]);
    expect(JSON.stringify(points)).not.toContain("someone@example.com");
    expect(JSON.stringify(points)).not.toContain("ZZ");
  });

  it("still serves the feed index, counted as a file", async () => {
    const { assets } = feedAssets();
    const { points, dataset } = recorder();
    const res = await poll("/data/feeds/index.json", assets, dataset);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ feeds: [] });
    expect(points).toEqual([
      { indexes: ["/data/feeds/index.json"], blobs: ["/data/feeds/index.json", "file", "en", "", "", "GET", "", "bot", "", "", ""], doubles: [200] },
    ]);
  });

  it("answers 503 when the assets binding fails, and 404 when there is none", async () => {
    const { points, dataset } = recorder();
    const res = await poll("/data/feeds/canada/pending.xml", feedAssets(true).assets, dataset);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
    expect(points).toHaveLength(1);
    expect(points[0].doubles).toEqual([503, 12]);
    expect(points[0].blobs?.[6]).toBe("");
    const bare = await app.request("/data/feeds/canada/pending.xml", {}, { ...testEnv(), ASSETS: undefined });
    expect(bare.status).toBe(404);
  });
});
