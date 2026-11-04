import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { WEB_ANALYTICS_SRC, WEB_ANALYTICS_TOKEN } from "../src/layout";
import { DESCRIPTION_MAX } from "../src/seo";
import { emptyAssets, fakeAssets, testEnv } from "./assets";
import rankingsYear from "./fixtures/rankings-2026.json";
import rankingsAll from "./fixtures/rankings-all.json";
import release2014 from "./fixtures/release-2014.json";
import release from "./fixtures/release-2026-q1.json";
import releaseIndex from "./fixtures/releases-index.json";

// The release and ranking files, served beside the shared fixtures.
const FILES: Record<string, unknown> = {
  "releases/index.json": releaseIndex,
  "releases/2026-q1.json": release,
  "releases/2014.json": release2014,
  "rankings/all.json": rankingsAll,
  "rankings/2026.json": rankingsYear,
};
const assets = {
  fetch: async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const file = FILES[new URL(url).pathname.replace(/^\/data\//, "")];
    if (file === undefined) return fakeAssets.fetch(input as RequestInfo);
    return new Response(JSON.stringify(file), { headers: { "content-type": "application/json" } });
  },
} as unknown as Fetcher;

const get = (path: string, headers: Record<string, string> = {}, env: object = testEnv(assets)) => app.request(path, { headers }, env);
const html = async (path: string) => (await get(path)).text();
const EM_DASH = String.fromCharCode(0x2014);
const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const head = (page: string) => page.slice(0, page.indexOf("</head>"));
const meta = (page: string, key: string) => decode(page.match(new RegExp(`<meta name="${key}" content="([^"]*)"`))?.[1] ?? "");
const jsonLd = (page: string): any[] =>
  [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
// Visible text only: tags and the JSON blocks removed.
const text = (page: string) => decode(page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

const PAGES = ["/releases", "/releases/2026-q1", "/releases/2014", "/rankings", "/rankings/2026"];
const CAVEAT_EN = "Positions on approved LMIAs are not workers who arrived.";
const LEADERS_EN = "Large farms, packers and health authorities lead these tables by design";
const CAVEAT_FR = "Les postes visés par des EIMT approuvées ne sont pas des travailleurs arrivés.";
const LEADERS_FR = "Les grandes exploitations agricoles, les emballeurs et les autorités sanitaires arrivent en tête de ces tableaux par conception";

describe("release pages", () => {
  it("the index lists every release with its totals", async () => {
    const page = await html("/releases");
    expect(page).toContain("<h1>Quarterly Releases</h1>");
    expect(page).toContain('<a href="/releases/2026-q1">2026 Q1</a>');
    expect(page).toContain('<a href="/releases/2017-q1-q2">2017 Q1 to Q2</a>');
    expect(page).toContain('<a href="/releases/2014">2014</a>');
    expect(page).toContain("33,202");
    expect(page).toContain('<a href="/rankings">');
  });

  it("a release shows its totals, largest approvals, new employers, changes, refusals and sources", async () => {
    const page = await html("/releases/2026-q1");
    const body = text(page);
    expect(page).toContain("<h1>LMIA Employer Lists, 2026 Q1</h1>");
    expect(body).toContain("published 2026-07-22");
    // Totals against the previous release, with the change signed.
    expect(body).toContain("Previous (2025 Q4)");
    expect(body).toContain("33,202");
    expect(body).toContain("47,466");
    expect(body).toContain("\u221214,264");
    // Largest approvals link to the profiles.
    expect(page).toContain('<a href="/employers/emp-e70240102a">Jealous Fruits Ltd.</a>');
    expect(body).toContain("1,587 employers appear on the positive list for the first time, with 2,472 positions.");
    expect(body).toContain("Largest Changes from 2025 Q4");
    expect(body).toContain("+626");
    expect(body).toContain("\u2212515");
    // Refusals carry the methodology's label and its link, never a verdict.
    expect(body).toContain("Rows from the ESDC negative LMIA employers list, which the Methodology page counts as Refused.");
    expect(page).toContain('<a href="/methodology#status">Methodology page</a>');
    expect(body).toContain("Positions requested");
    // Every source file: the ESDC page, the original download and the mirror copy.
    expect(page).toContain('href="https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97/resource/4ee7a4e0-ffc3-47af-94e7-30929d1eeb67"');
    expect(page).toContain('href="/downloads/mirror/positive_2026Q1_tfwp_2026q1_pos_en.xlsx"');
    expect(page).toContain('href="/downloads/mirror/negative_2026Q1_tfwp_2026q1_neg_en.xlsx"');
    expect(page).toContain('title="2f48cb522180ff82e6768a68b679bed4d4c89efa28d1c5aca7bc1604c99a044e"');
    expect(page).toContain('<a href="/releases/2025-q4">Previous release: 2025 Q4</a>');
  });

  it("the first release says every employer is new and shows no stream breakdown it does not have", async () => {
    const body = text(await html("/releases/2014"));
    expect(body).toContain("This is the first list on record, so every employer on it is new.");
    expect(body).toContain("The 2014 lists cover LMIAs issued from June 20 to December 31, 2014.");
    expect(body).toContain("Most rows in this file carry no stream, so no breakdown by stream is shown.");
    expect(body).not.toContain("Largest Changes");
    expect(body).not.toContain("Previous release");
  });

  it("an unknown or malformed release is a 404, and no data at all is the not-published page", async () => {
    for (const path of ["/releases/2099-q1", "/releases/2026Q1", "/releases/..%2Fstats", "/releases/2026-q5"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain("Release Not Found");
    }
    expect((await get("/releases/2026-q1", {}, testEnv(emptyAssets))).status).toBe(503);
    expect((await get("/releases", {}, testEnv(emptyAssets))).status).toBe(503);
  });
});

describe("rankings", () => {
  it("all years: provinces, streams with the years they cover, two NOC eras and employers", async () => {
    const page = await html("/rankings");
    const body = text(page);
    expect(page).toContain("<h1>Rankings: All Years</h1>");
    expect(body).toContain("39 releases, 2014 to 2026 Q1.");
    expect(body).toContain("1,496,943 positions approved");
    expect(body).toContain("Ontario");
    expect(body).toContain("31.2%");
    expect(body).toContain("Years included: 2020, 2021, 2022, 2023, 2024, 2025 and 2026.");
    // The two classifications sit in separate tables, each with its own span.
    expect(body).toContain("NOC 2011, 2016 to 2024 Q1");
    expect(body).toContain("NOC 2021, 2024 Q2 to 2026 Q1");
    expect(body).toContain("no figure adds the two together");
    expect(body).toContain("The 2014 and 2015 lists name no occupation");
    expect(page).toContain('<a href="/employers/emp-631b67144f">Procyk Farms (1994) Ltd</a>');
    expect(page).toContain('<strong aria-current="page">All years</strong>');
    // Every ranking table has compact phone rows, the rank (and the NOC code) leading the title line.
    const tables = page.match(/<table class="[^"]*">/g) ?? [];
    expect(tables.length).toBeGreaterThanOrEqual(5);
    expect(new Set(tables)).toEqual(new Set(['<table class="restack restack-compact">']));
    expect(page).toContain('<td data-label="Rank" class="mono num title-lead">1</td>');
    expect(page).toMatch(/<td data-label="NOC code" class="mono title-lead">\d{4,5}<\/td>/);
    expect(page).toContain('<a href="/rankings/2025">2025</a>');
  });

  it("one year says when it is incomplete and links back to all years", async () => {
    const page = await html("/rankings/2026");
    const body = text(page);
    expect(page).toContain("<h1>Rankings: 2026</h1>");
    expect(body).toContain("Releases included: 2026 Q1.");
    expect(body).toContain("The latest release is 2026 Q1, so 2026 is not complete.");
    expect(body).toContain("NOC 2021, 2026 Q1");
    expect(body).not.toContain("NOC 2011");
    expect(page).toContain('<a href="/rankings">All years</a>');
    expect(page).toContain('<strong aria-current="page">2026</strong>');
  });

  it("a year with no lists, or not a year, is a 404", async () => {
    for (const path of ["/rankings/1999", "/rankings/abc", "/rankings/20261"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain("No Rankings for That Year");
    }
    expect((await get("/rankings", {}, testEnv(emptyAssets))).status).toBe(503);
  });
});

describe("every release and ranking page", () => {
  it("carries both cautions in the page's language and reads as records, not accusations", async () => {
    for (const path of PAGES) {
      const en = text(await html(path));
      expect(en, path).toContain(CAVEAT_EN);
      expect(en, path).toContain(LEADERS_EN);
      expect(en, path).not.toMatch(/\b(abuse|abusers?|fraud\w*|violat\w*|offenders?|worst|cheat\w*|wrongdoers?)\b/i);
      const fr = nbsp(text(await (await get(`${path}${path.includes("?") ? "&" : "?"}lang=fr`)).text()));
      expect(fr, path).toContain(CAVEAT_FR);
      expect(fr, path).toContain(LEADERS_FR);
      for (const sentinel of [CAVEAT_EN, "Reading These Tables", "Quarterly Releases", "Largest Approvals", "Positions Approved by"]) {
        expect(fr, `${path}: ${sentinel}`).not.toContain(sentinel);
      }
    }
  });

  it("has metadata like the other pages: title, short description, canonical, alternates, breadcrumbs", async () => {
    const expected: Record<string, [string, string[]]> = {
      "/releases": ["Quarterly Releases | LMIA Watch", ["Home", "Quarterly releases"]],
      "/releases/2026-q1": ["LMIA Approvals and Refusals, 2026 Q1 | LMIA Watch", ["Home", "Quarterly releases", "2026 Q1"]],
      "/rankings": ["LMIA Rankings by Province, Stream, Occupation and Employer | LMIA Watch", ["Home", "Rankings"]],
      "/rankings/2026": ["LMIA Rankings, 2026 | LMIA Watch", ["Home", "Rankings", "2026"]],
    };
    for (const [path, [title, crumbs]] of Object.entries(expected)) {
      for (const lang of ["en", "fr"] as const) {
        const page = await html(lang === "fr" ? `${path}?lang=fr` : path);
        const h = head(page);
        const url = `https://lmiawatch.ca${path}`;
        if (lang === "en") expect(decode(h.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""), path).toBe(title);
        const description = meta(h, "description");
        expect(description.length, `${path} ${lang}`).toBeGreaterThan(50);
        expect(description.length, `${path} ${lang}`).toBeLessThanOrEqual(DESCRIPTION_MAX);
        expect(h).toContain(`<link rel="canonical" href="${lang === "fr" ? `${url}?lang=fr` : url}"`);
        expect(h).toContain(`<link rel="alternate" hreflang="fr" href="${url}?lang=fr"`);
        expect(h).toContain(`<link rel="alternate" hreflang="x-default" href="${url}"`);
        const crumbList = jsonLd(h).find((d) => d["@type"] === "BreadcrumbList");
        if (lang === "en") expect(crumbList.itemListElement.map((i: any) => i.name), path).toEqual(crumbs);
        expect(crumbList.itemListElement[0].item).toBe("https://lmiawatch.ca/");
        expect(crumbList.itemListElement.at(-1).item, path).toBeUndefined();
        expect(page, path).not.toContain(EM_DASH);
      }
    }
  });

  it("writes numbers and periods the French way", async () => {
    const fr = nbsp(text(await (await get("/releases/2026-q1?lang=fr")).text()));
    expect(fr).toContain("Listes des employeurs EIMT, T1 2026");
    expect(fr).toContain("33 202");
    expect(fr).toContain("Précédente (T4 2025)");
    expect(fr).toContain("liste des employeurs ayant reçu une EIMT négative d’EDSC");
    const rank = nbsp(text(await (await get("/rankings?lang=fr")).text()));
    expect(rank).toContain("CNP 2011, 2016 à T1 2024");
    expect(rank).toContain("31,2 %");
  });

  it("runs no inline script: only the theme and link files, the Web Analytics beacon and JSON-LD blocks", async () => {
    const beacon = `<script type="module" src="${WEB_ANALYTICS_SRC}" data-cf-beacon="${JSON.stringify({ token: WEB_ANALYTICS_TOKEN }).replace(/"/g, "&quot;")}">`;
    for (const path of PAGES) {
      const page = await html(path);
      for (const tag of page.match(/<script[^>]*>/g) ?? []) {
        const allowed = ['<script src="/theme.js">', '<script src="/links.js" defer="">', beacon, '<script type="application/ld+json">'];
        expect(allowed.includes(tag), `${path}: ${tag}`).toBe(true);
      }
    }
  });
});

describe("links into the release pages", () => {
  it("the home page's largest approvals and the data page's ESDC files each link the release list once", async () => {
    // Apart from the main navigation, which links the release list from every page.
    const body = (page: string) => page.replace(/<nav [\s\S]*?<\/nav>/, "");
    const home = body(await html("/"));
    expect(home.match(/href="\/releases"/g)?.length).toBe(1);
    expect(home).toContain("Every quarterly release, with its largest approvals");
    const data = body(await html("/data"));
    expect(data.match(/href="\/releases"/g)?.length).toBe(1);
    expect(data).toContain('Each release also has a page with its totals and largest approvals: <a href="/releases">Quarterly Releases</a>.');
  });
});
