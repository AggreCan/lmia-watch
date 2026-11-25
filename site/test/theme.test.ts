// public/theme.js, evaluated with a stand-in window: the theme switch it
// starts with, and the guard that reloads a page whose own request met
// Cloudflare's browser check (the header cf-mitigated: challenge).
import { describe, expect, it } from "vitest";
import themeJs from "../public/theme.js?raw";
import { app } from "../src/index";
import { testEnv } from "./assets";

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

// Runs the file once, as a page load does. store stands for the tab's
// sessionStorage, shared by the pages the tab loads; null makes every
// storage call throw, as a browser with site data blocked does.
function load(answer: () => Promise<Response>, store: Map<string, string> | null = new Map()) {
  const sessionStorage: Storage = store
    ? { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, String(value)) }
    : { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
  let reloads = 0;
  const location = { reload: () => { reloads += 1; } };
  const calls: unknown[][] = [];
  const window: { fetch?: (...args: unknown[]) => Promise<Response>; sessionStorage: Storage; location: typeof location } = {
    fetch: (...args: unknown[]) => {
      calls.push(args);
      return answer();
    },
    sessionStorage,
    location,
  };
  const document = {
    documentElement: { classList: { add() {} }, setAttribute() {}, getAttribute: () => null },
    addEventListener() {},
  };
  const localStorage = { getItem: () => null, setItem() {} };
  new Function("window", "document", "localStorage", "sessionStorage", "location", themeJs)(window, document, localStorage, sessionStorage, location);
  return { fetch: window.fetch!, reloads: () => reloads, calls };
}

const challenged = () => new Response("Just a moment...", { status: 403, headers: { "cf-mitigated": "challenge", "content-type": "text/html" } });

describe("the challenge guard in theme.js", () => {
  it("reloads the page on a challenged answer and hands the answer back untouched", async () => {
    let sent: Response | null = null;
    const page = load(async () => (sent = challenged()));
    const init = { signal: new AbortController().signal };
    const res = await page.fetch("/api/search?q=farm", init);
    expect(res).toBe(sent);
    expect(page.calls).toEqual([["/api/search?q=farm", init]]);
    expect(page.reloads()).toBe(1);
  });

  it("reloads at most once a minute in a tab, across the pages it loads", async () => {
    const store = new Map<string, string>();
    const first = load(async () => challenged(), store);
    await first.fetch("/data/clusters/latest.json");
    await first.fetch("/data/areas/V0N.json");
    expect(first.reloads()).toBe(1);
    // The page after the reload, in the same tab, within the minute.
    const second = load(async () => challenged(), store);
    await second.fetch("/data/profiles/a00.json");
    expect(second.reloads()).toBe(0);
    // A minute later it may reload again.
    const [key] = [...store.keys()];
    expect(store.size).toBe(1);
    store.set(key, String(Date.now() - 61_000));
    const third = load(async () => challenged(), store);
    await third.fetch("/data/profiles/a00.json");
    expect(third.reloads()).toBe(1);
  });

  it("leaves a normal answer, a refusal without the header and a network failure alone", async () => {
    for (const answer of [new Response("{}", { status: 200 }), new Response("no", { status: 403 }), new Response("busy", { status: 429 })]) {
      const page = load(async () => answer);
      expect(await page.fetch("/api/search")).toBe(answer);
      expect(page.reloads(), String(answer.status)).toBe(0);
    }
    const offline = load(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(offline.fetch("/api/search")).rejects.toThrow("Failed to fetch");
    expect(offline.reloads()).toBe(0);
  });

  it("still reloads when storage throws, once for the page", async () => {
    const page = load(async () => challenged(), null);
    await page.fetch("/api/search");
    await page.fetch("/api/search");
    expect(page.reloads()).toBe(1);
  });

  it("runs in the head before any page script, with no inline script", async () => {
    for (const path of ["/map", "/watchlist", "/search", "/employers/emp-a000000001"]) {
      const res = await app.request(path, { headers: { "sec-fetch-mode": "navigate" } }, testEnv());
      expect(res.status, path).toBe(200);
      const html = await res.text();
      const tags = html.match(/<script\b[^>]*>/g) ?? [];
      // Not deferred: it runs where it stands, before the map and watchlist scripts make their first request.
      expect(tags.filter((t) => !t.includes("application/")).at(0), path).toBe('<script src="/theme.js">');
      expect(html.indexOf('<script src="/theme.js">'), path).toBeLessThan(html.indexOf("</head>"));
      for (const tag of tags) expect(/\bsrc="|type="application\/(?:ld\+)?json"/.test(tag), tag).toBe(true);
    }
  });
});
