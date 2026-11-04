import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { agentClass, countryCode, dailySalt, deviceClass, hasFetchMetadata, referrerHost, routeTemplate, utcDay, visitorHash } from "../src/views";
import { testEnv } from "./assets";

// A stand-in for the Analytics Engine binding that keeps what it is given.
function recorder(fail = false) {
  const points: AnalyticsEngineDataPoint[] = [];
  const dataset = {
    writeDataPoint(p?: AnalyticsEngineDataPoint) {
      if (fail) throw new Error("dataset unavailable");
      if (p) points.push(p);
    },
  } as AnalyticsEngineDataset;
  return { points, dataset };
}

const IP = "203.0.113.42";
const UA = "Mozilla/5.0 (X11; Linux x86_64) ExampleBrowser/1.0";
// The Fetch Metadata a current browser sends when a link on another site is followed.
const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" };

function visit(path: string, dataset?: AnalyticsEngineDataset, init: RequestInit = {}) {
  const headers = {
    "cf-connecting-ip": IP,
    "user-agent": UA,
    cookie: "lang=fr; theme=dark",
    referer: "https://news.example.org/2026/10/story?utm_source=x#frag",
    ...NAVIGATE,
    ...(init.headers as Record<string, string>),
  };
  return app.request(path, { ...init, headers }, { ...testEnv(), VIEWS: dataset });
}

describe("route templates", () => {
  it("names every route by its template, never by its parameters", () => {
    expect(routeTemplate("GET", "/")).toEqual({ route: "/", kind: "page" });
    expect(routeTemplate("GET", "/search")).toEqual({ route: "/search", kind: "page" });
    expect(routeTemplate("GET", "/employers/emp-a000000001")).toEqual({ route: "/employers/:id", kind: "page" });
    expect(routeTemplate("GET", "/employers/emp-a000000001/respond")).toEqual({ route: "/employers/:id/respond", kind: "page" });
    expect(routeTemplate("POST", "/employers/emp-a000000001/respond")).toEqual({ route: "/employers/:id/respond", kind: "form" });
    expect(routeTemplate("POST", "/corrections")).toEqual({ route: "/corrections", kind: "form" });
    expect(routeTemplate("GET", "/api/employers/emp-a000000001")).toEqual({ route: "/api/employers/:id", kind: "api" });
    expect(routeTemplate("GET", "/api/area/V0N")).toEqual({ route: "/api/area/:fsa", kind: "api" });
    expect(routeTemplate("GET", "/api/stats")).toEqual({ route: "/api/stats", kind: "api" });
    expect(routeTemplate("GET", "/api/search")).toEqual({ route: "/api/search", kind: "api" });
    expect(routeTemplate("GET", "/api/search/facets")).toEqual({ route: "/api/search/facets", kind: "api" });
    expect(routeTemplate("GET", "/api/anything/else")).toEqual({ route: "/api/other", kind: "api" });
    expect(routeTemplate("GET", "/downloads/employers.csv")).toEqual({ route: "/downloads/employers.csv", kind: "download" });
    expect(routeTemplate("GET", "/downloads/mirror/SHA256SUMS")).toEqual({ route: "/downloads/mirror/:file", kind: "download" });
    expect(routeTemplate("GET", "/downloads/secret.txt")).toEqual({ route: "/downloads/other", kind: "download" });
    expect(routeTemplate("POST", "/hooks/kofi")).toEqual({ route: "/hooks/kofi", kind: "hook" });
    expect(routeTemplate("GET", "/sitemap-12.xml")).toEqual({ route: "/sitemap.xml", kind: "file" });
    expect(routeTemplate("GET", "/robots.txt")).toEqual({ route: "/robots.txt", kind: "file" });
    for (const page of ["/cite", "/feeds", "/watchlist", "/releases", "/rankings", "/trends", "/program", "/occupations", "/places"]) {
      expect(routeTemplate("GET", page), page).toEqual({ route: page, kind: "page" });
    }
    expect(routeTemplate("GET", "/releases/2026-q1")).toEqual({ route: "/releases/:slug", kind: "page" });
    expect(routeTemplate("GET", "/rankings/2025")).toEqual({ route: "/rankings/:year", kind: "page" });
    expect(routeTemplate("GET", "/trends/streams")).toEqual({ route: "/trends/:view", kind: "page" });
    expect(routeTemplate("GET", "/occupations/63200")).toEqual({ route: "/occupations/:noc", kind: "page" });
    expect(routeTemplate("GET", "/places/mb")).toEqual({ route: "/places/:prov", kind: "page" });
    expect(routeTemplate("GET", "/places/mb/winnipeg")).toEqual({ route: "/places/:prov/:slug", kind: "page" });
  });

  it("stores a path that matches no route as 'other', whatever it holds", () => {
    for (const path of ["/someone@example.com", "/search/", "/wp-login.php", "/employers/a/b/c", "/%E2%80%94", "/places/a/b/c", "/trends/a/b", "/program/2026"]) {
      expect(routeTemplate("GET", path), path).toEqual({ route: "other", kind: "other" });
    }
  });
});

describe("referrer and country", () => {
  it("keeps the referring host only", () => {
    expect(referrerHost("https://News.Example.org:8443/a/b?q=1#x")).toBe("news.example.org");
    expect(referrerHost("http://www.google.com/")).toBe("www.google.com");
    expect(referrerHost("android-app://com.google.android.gm/")).toBe("");
    expect(referrerHost("not a url")).toBe("");
    expect(referrerHost(undefined)).toBe("");
    expect(referrerHost("")).toBe("");
  });

  it("keeps a two-character code from the edge and nothing else", () => {
    expect(countryCode("CA")).toBe("CA");
    expect(countryCode("T1")).toBe("T1");
    expect(countryCode("Canada")).toBe("");
    expect(countryCode(undefined)).toBe("");
    expect(countryCode(42)).toBe("");
  });
});

describe("measurement middleware", () => {
  it("writes one aggregate point per response, with no address, agent, cookie or full referrer", async () => {
    const { points, dataset } = recorder();
    const res = await visit("/employers/emp-a000000001", dataset);
    expect(res.status).toBe(200);
    expect(points).toHaveLength(1);
    const [p] = points;
    expect(p).toEqual({
      indexes: ["/employers/:id"],
      // No VIEWS_SALT_KEY in the test environment, so no visitor code.
      blobs: ["/employers/:id", "page", "fr", "", "news.example.org", "GET", "", "human", "desktop", ""],
      doubles: [200],
    });
    const raw = JSON.stringify(p);
    for (const secret of [IP, UA, "theme", "lang=fr", "utm_source", "/2026/10/story", "emp-a000000001"]) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  it("counts pages, the API, downloads, not-found pages and form posts with their status", async () => {
    const { points, dataset } = recorder();
    await visit("/?lang=en", dataset);
    await visit("/api/stats", dataset);
    await visit("/downloads/not-a-file.csv", dataset);
    await visit("/nothing-here/someone@example.com", dataset);
    await visit("/corrections", dataset, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ record_ref: "emp-a000000002", request: "The street address on this profile is out of date." }).toString(),
    });
    expect(points.map((p) => [p.blobs?.[0], p.blobs?.[1], p.blobs?.[2], p.doubles?.[0]])).toEqual([
      ["/", "page", "en", 200],
      ["/api/stats", "api", "fr", 200],
      ["/downloads/other", "download", "fr", 404],
      ["other", "other", "fr", 404],
      ["/corrections", "form", "fr", 200],
    ]);
    expect(JSON.stringify(points)).not.toContain("someone@example.com");
  });

  it("records the edge's country code when the request carries one", async () => {
    const { points, dataset } = recorder();
    const req = new Request("http://localhost/search", { headers: { referer: "https://lmiawatch.ca/" } });
    Object.defineProperty(req, "cf", { value: { country: "CA", city: "Somewhere", latitude: "1" } });
    await app.fetch(req, { ...testEnv(), VIEWS: dataset });
    // No user agent at all: a program, so a bot with no device and no code.
    expect(points[0].blobs).toEqual(["/search", "page", "en", "CA", "lmiawatch.ca", "GET", "", "bot", "", ""]);
    expect(JSON.stringify(points)).not.toContain("Somewhere");
  });

  it("serves the page when the dataset throws or is absent", async () => {
    const broken = recorder(true);
    const res = await visit("/methodology", broken.dataset);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>");
    expect((await visit("/methodology")).status).toBe(200);
    expect((await visit("/methodology", undefined)).status).toBe(200);
  });
});

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const CUBOT = "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

describe("bot or human", () => {
  it("counts a browser as a person", () => {
    for (const ua of [CHROME, IPHONE, ANDROID_PHONE, ANDROID_TABLET, IPAD, FIREFOX, CUBOT, UA]) {
      expect(agentClass(ua, undefined), ua).toBe("human");
    }
  });

  it("counts crawlers, scripts, the site's own client and a missing agent as bots", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)",
      "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
      "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
      "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)",
      "Mozilla/5.0 (compatible; LMIAWatch/0.1; +https://lmiawatch.ca)",
      "LMIAWatch/0.1 (+https://lmiawatch.ca; https://lmiawatch.ca/corrections)",
      "python-requests/2.32.3",
      "curl/8.5.0",
      "Wget/1.21.4",
      "Go-http-client/2.0",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Feedly/1.0 (+https://feedly.com/poller.html; 12 subscribers; like FeedFetcher-Google)",
      "",
      "   ",
    ]) {
      expect(agentClass(ua, undefined), ua).toBe("bot");
    }
    expect(agentClass(undefined, undefined)).toBe("bot");
    expect(agentClass(null, undefined)).toBe("bot");
  });

  it("takes the edge's verified-bot category over the user agent, whatever the category", () => {
    expect(agentClass(CHROME, "Search Engine Crawler")).toBe("bot");
    expect(agentClass(CHROME, "Monitoring & Analytics")).toBe("bot");
    expect(agentClass(CHROME, "")).toBe("human");
    expect(agentClass(CHROME, 7)).toBe("human");
  });

  it("counts every feed poll and payment hook as a bot, whatever its agent", () => {
    expect(agentClass(CHROME, undefined, "feed")).toBe("bot");
    expect(agentClass(CHROME, undefined, "hook")).toBe("bot");
    expect(agentClass(CHROME, undefined, "page")).toBe("human");
    expect(agentClass(CHROME, undefined, "api")).toBe("human");
  });

  it("counts a browser's user agent with no Fetch Metadata header as a bot", () => {
    for (const ua of [CHROME, IPHONE, FIREFOX, UA]) {
      expect(agentClass(ua, undefined, "page", false), ua).toBe("bot");
      expect(agentClass(ua, undefined, "page", true), ua).toBe("human");
    }
    // The other rules hold whatever the headers say.
    expect(agentClass("curl/8.5.0", undefined, "page", true)).toBe("bot");
    expect(agentClass(CHROME, "Search Engine Crawler", "page", true)).toBe("bot");
    expect(agentClass(CHROME, undefined, "feed", true)).toBe("bot");
  });

  it("takes any one of Sec-Fetch-Mode, Sec-Fetch-Dest and Sec-Fetch-Site as Fetch Metadata", () => {
    expect(hasFetchMetadata(new Headers())).toBe(false);
    expect(hasFetchMetadata(new Headers({ "user-agent": CHROME, referer: "https://lmiawatch.ca/", "sec-ch-ua-mobile": "?0" }))).toBe(false);
    expect(hasFetchMetadata(new Headers({ "Sec-Fetch-Mode": "navigate" }))).toBe(true);
    expect(hasFetchMetadata(new Headers({ "sec-fetch-dest": "document" }))).toBe(true);
    expect(hasFetchMetadata(new Headers({ "sec-fetch-site": "none" }))).toBe(true);
  });

  it("writes a browser-shaped request with no Fetch Metadata as a bot, with no device and no code", async () => {
    const { points, dataset } = recorder();
    const env = { ...testEnv(), VIEWS: dataset, VIEWS_SALT_KEY: "test-secret" };
    await app.request("/methodology", { headers: { "cf-connecting-ip": IP, "user-agent": CHROME } }, env);
    await app.request("/methodology", { headers: { "cf-connecting-ip": IP, "user-agent": CHROME, "sec-fetch-site": "same-origin" } }, env);
    expect(points[0].blobs?.slice(7)).toEqual(["bot", "", ""]);
    expect(points[1].blobs?.slice(7, 9)).toEqual(["human", "desktop"]);
    expect(points[1].blobs?.[9]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records a refused automated browser as a bot with status 403, like the response form's refusals", async () => {
    const { points, dataset } = recorder();
    const env = { ...testEnv(), VIEWS: dataset, VIEWS_SALT_KEY: "test-secret" };
    const headers = { "cf-connecting-ip": IP, "user-agent": "Lightpanda/1.0", ...NAVIGATE };
    expect((await app.request("/employers/emp-a000000001", { headers }, env)).status).toBe(403);
    expect((await app.request("/?lang=fr", { headers }, env)).status).toBe(403);
    expect(points).toEqual([
      { indexes: ["/employers/:id"], blobs: ["/employers/:id", "page", "en", "", "", "GET", "", "bot", "", ""], doubles: [403] },
      { indexes: ["/"], blobs: ["/", "page", "fr", "", "", "GET", "", "bot", "", ""], doubles: [403] },
    ]);
  });

  it("records the edge's verified-bot category as a bot on the data point", async () => {
    const { points, dataset } = recorder();
    const req = new Request("http://localhost/search", { headers: { "user-agent": CHROME } });
    Object.defineProperty(req, "cf", { value: { country: "US", verifiedBotCategory: "Search Engine Crawler" } });
    await app.fetch(req, { ...testEnv(), VIEWS: dataset, VIEWS_SALT_KEY: "test-secret" });
    expect(points[0].blobs?.slice(6)).toEqual(["", "bot", "", ""]);
  });
});

describe("device class", () => {
  it("reads desktop, mobile or tablet from the user agent", () => {
    expect(deviceClass(CHROME)).toBe("desktop");
    expect(deviceClass(FIREFOX)).toBe("desktop");
    expect(deviceClass(IPHONE)).toBe("mobile");
    expect(deviceClass(ANDROID_PHONE)).toBe("mobile");
    expect(deviceClass(CUBOT)).toBe("mobile");
    expect(deviceClass(ANDROID_TABLET)).toBe("tablet");
    expect(deviceClass(IPAD)).toBe("tablet");
    expect(deviceClass("Mozilla/5.0 (Android 4.4; Tablet; rv:41.0) Gecko/41.0 Firefox/41.0")).toBe("tablet");
    expect(deviceClass("")).toBe("");
    expect(deviceClass(undefined)).toBe("");
  });

  it("takes Chromium's mobile hint for a phone that asked for the desktop site", () => {
    expect(deviceClass(CHROME, "?1")).toBe("mobile");
    expect(deviceClass(CHROME, "?0")).toBe("desktop");
  });
});

describe("the daily visitor code", () => {
  // Expected values computed outside the Worker with Python's hmac and hashlib:
  // salt = HMAC-SHA-256(b"test-secret", day) as hex, code = SHA-256(salt + "\n" + ip + "\n" + ua) as hex, first 16.
  it("is SHA-256 of the day's salt, the address and the agent, cut to 16 hex characters", async () => {
    expect(await dailySalt("test-secret", "2026-10-30")).toBe("5b0248d5b21c43729cd708863dd2f9e467325491b708a44979acbedbd34c2683");
    expect(await visitorHash("test-secret", "2026-10-30", IP, UA)).toBe("79b509108f501ba3");
  });

  it("changes every UTC day, with the address and with the secret", async () => {
    expect(await dailySalt("test-secret", "2026-10-31")).toBe("d90ec944394394b6b987859d350ad7ff658f75d0db9b3f50a1d5ae0a7dcaadbb");
    expect(await visitorHash("test-secret", "2026-10-31", IP, UA)).toBe("e16bd6bd25051507");
    expect(await visitorHash("test-secret", "2026-10-30", "203.0.113.43", UA)).not.toBe("79b509108f501ba3");
    expect(await visitorHash("other-secret", "2026-10-30", IP, UA)).not.toBe("79b509108f501ba3");
    expect(utcDay(new Date("2026-10-30T23:59:59.999Z"))).toBe("2026-10-30");
    expect(utcDay(new Date("2026-10-31T00:00:00Z"))).toBe("2026-10-31");
  });

  it("is empty without the secret", async () => {
    expect(await visitorHash(undefined, "2026-10-30", IP, UA)).toBe("");
    expect(await visitorHash("", "2026-10-30", IP, UA)).toBe("");
  });

  it("is written for a person's request and never for a bot's, and the address and agent are not", async () => {
    const { points, dataset } = recorder();
    const env = { ...testEnv(), VIEWS: dataset, VIEWS_SALT_KEY: "test-secret" };
    const headers = { "cf-connecting-ip": IP, "user-agent": UA, ...NAVIGATE };
    await app.request("/methodology", { headers }, env);
    await app.request("/methodology", { headers: { ...headers, "user-agent": "Mozilla/5.0 (compatible; bingbot/2.0)" } }, env);
    await app.request("/methodology", { headers: { ...headers, "user-agent": IPHONE } }, env);
    expect(points).toHaveLength(3);
    const [person, bot, phone] = points.map((p) => p.blobs ?? []);
    expect(person.slice(6)).toEqual(["", "human", "desktop", await visitorHash("test-secret", utcDay(), IP, UA)]);
    expect(person[9]).toMatch(/^[0-9a-f]{16}$/);
    expect(bot.slice(6)).toEqual(["", "bot", "", ""]);
    expect(phone.slice(7, 9)).toEqual(["human", "mobile"]);
    expect(phone[9]).toMatch(/^[0-9a-f]{16}$/);
    expect(phone[9]).not.toBe(person[9]);
    const raw = JSON.stringify(points);
    for (const secret of [IP, UA, IPHONE, "bingbot", "test-secret", await dailySalt("test-secret", utcDay())]) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  it("writes the point with an empty code when no secret is set", async () => {
    const { points, dataset } = recorder();
    const res = await app.request("/methodology", { headers: { "user-agent": UA, ...NAVIGATE } }, { ...testEnv(), VIEWS: dataset });
    expect(res.status).toBe(200);
    expect(points[0].blobs?.slice(7)).toEqual(["human", "desktop", ""]);
  });
});
