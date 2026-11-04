// The government notices page, the home page's short list, the nav and footer
// entries, the About rename, the Data page's licence row and changelog, and
// the watchdog's notices. The fixture is the pipeline's own export of its feed
// fixtures (pipeline/tests/fixtures/notices_*.xml): ten items, one with no
// French pair and one only the French matches.
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { changelog, LICENCE_ROWS } from "../src/pages/data";
import { isNoticesFile } from "../src/pages/notices";
import { routeTemplate } from "../src/views";
import { buildEmail, collectAlerts, collectNotices, readStatus } from "../src/watchdog";
import { emptyAssets, makeFakeAssets, testEnv } from "./assets";
import notices from "./fixtures/notices.json";

const EM_DASH = String.fromCharCode(0x2014);
const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const get = (path: string, assets?: Fetcher) => app.request(path, {}, testEnv(assets));
const mainNav = (html: string) => html.slice(html.indexOf('<nav aria-label="'), html.indexOf("</nav>"));
const footer = (html: string) => html.slice(html.indexOf('<footer class="site-footer">'));
const items = (html: string) => {
  const start = html.indexOf('<ol class="notice-list">');
  return html.slice(start, html.indexOf("</ol>", start)).split("<li>").slice(1);
};

// The fixtures with notices.json replaced (or removed with null).
function withNotices(body: unknown): Fetcher {
  const base = makeFakeAssets();
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (new URL(req.url).pathname === "/data/notices.json") {
        return body === null ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(body));
      }
      return base.fetch(req);
    },
  } as unknown as Fetcher;
}
const copy = () => JSON.parse(JSON.stringify(notices));

describe("the government notices page", () => {
  it("renders the lede, the count and each notice as the department published it, in English", async () => {
    const res = await get("/notices");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Government Notices</h1>");
    expect(html).toContain(
      '<p class="lead">Official notices from IRCC and ESDC whose title or summary mentions the programs behind these records. ' +
        "Some listed notices may touch these programs only in passing.</p>",
    );
    // The sentence the owner removed from the prototype's lede.
    expect(html).not.toContain("This site adds nothing to them.");
    expect(html).toContain("A notice listed here has not changed any record on this site.");
    expect(html).toContain('set out in the <a href="/methodology">methodology</a>.');
    expect(html).toContain("<h2>10 notices, 2026-02-17 to 2026-10-16</h2>");
    expect(html).toContain("Newest first, from the last 12 months.");
    expect(html).toContain("Checked each night; last checked 2026-10-25.");
    expect(html).not.toContain("Could not be read at the last check");
    const rows = items(html);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toContain(
      '<p class="notice-meta"><span class="mono">2026-10-16</span> · <abbr title="Immigration, Refugees and Citizenship Canada">IRCC</abbr> · News release</p>',
    );
    expect(rows[0]).toContain(
      '<a href="https://www.canada.ca/en/immigration-refugees-citizenship/news/2026/10/canada-refocusing-express-entry-on-top-talent-that-drives-economic-growth.html" rel="nofollow noopener">Canada refocusing Express Entry on top talent that drives economic growth</a>',
    );
    // The summary without its dateline.
    expect(rows[0]).toContain('<p class="notice-summary">Building a stronger Canada means restoring confidence');
    expect(rows[0]).not.toContain("Kitchener, Ontario");
    expect(rows[0]).toContain('<p class="notice-feed">Feed: IRCC news, Canada.ca (Atom). Terms: Express Entry.</p>');
    expect(rows[1]).toContain("Terms: LMIA, labour market impact assessment, Express Entry.");
    expect(rows[2]).toContain('<abbr title="Employment and Social Development Canada">ESDC</abbr>');
    expect(rows[2]).toContain("Feed: ESDC news, Canada.ca (Atom). Terms: Temporary Foreign Worker.");
    // Only the French version matched: its terms are named as such.
    expect(rows[3]).toContain("Terms (French version): permis de travail.");
    expect(html).toContain("· Speech</p>");
    expect(html).toContain("· Media advisory</p>");
    expect(html).toContain("· Backgrounder</p>");
    expect(html).not.toContain(EM_DASH);
  });

  it("states its sources, the full list of terms and the Crown copyright terms", async () => {
    const html = await (await get("/notices")).text();
    const panel = html.slice(html.indexOf('<section class="panel" aria-labelledby="sources">'));
    expect(panel).toContain('<h2 id="sources">Sources and Terms</h2>');
    expect(panel).toContain(
      "contains one of these terms: LMIA, labour market impact assessment, Temporary Foreign Worker, TFWP, Express Entry, work permit, " +
        "Job Bank, wage threshold, refusal to process, International Mobility Program, permanent residence job offer, EIMT, " +
        "étude d’impact sur le marché du travail, travailleurs étrangers temporaires, Entrée express, permis de travail, Guichet-Emplois.",
    );
    expect(panel).toContain("Not covered: the Canada Gazette, Parts I and II");
    expect(panel).toContain('<a href="https://www.canada.ca/en/transparency/terms.html">canada.ca terms and conditions</a>');
  });

  it("renders in French, with the English of an item the French feed lacks marked as such", async () => {
    const html = nbsp(await (await get("/notices?lang=fr")).text());
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain("<h1>Avis du gouvernement</h1>");
    expect(html).toContain("Certains avis listés ne touchent ces programmes qu’en passant.");
    expect(html).toContain("<h2>10 avis, du 2026-02-17 au 2026-10-16</h2>");
    const rows = items(html);
    expect(rows[0]).toContain("· Communiqué de presse</p>");
    expect(rows[0]).toContain(">Le Canada réoriente le système Entrée express vers les travailleurs qualifiés qui stimulent l’économie</a>");
    expect(rows[0]).toContain("Fil : nouvelles d’IRCC, Canada.ca (Atom). Termes : Entrée express.");
    expect(rows[0]).toContain('href="https://www.canada.ca/fr/immigration-refugies-citoyennete/nouvelles/2026/10/');
    expect(rows[2]).toContain('<abbr title="Emploi et Développement social Canada">EDSC</abbr>');
    const ukraine = rows.find((r) => r.includes("Ukrainians"));
    expect(ukraine).toBeDefined();
    expect(ukraine).toContain('<h3 class="notice-title" lang="en">');
    expect(ukraine).toContain("Titre en anglais : le fil français ne donne pas cet élément.");
    expect(ukraine).toContain("Termes : work permit.");
    // An item only the French matched shows its own terms in French.
    expect(rows[3]).toContain("Termes : permis de travail.");
    expect(html).toContain("l’un de ces termes : EIMT, étude d’impact sur le marché du travail, travailleurs étrangers temporaires");
    expect(html).toContain('<a href="https://www.canada.ca/fr/transparence/avis.html">avis de Canada.ca</a>');
    expect(html).not.toContain(EM_DASH);
  });

  it("says when a feed could not be read at the last check", async () => {
    const d = copy();
    d.feeds[3].state = "failing";
    d.feeds[3].last_ok = "2026-10-20";
    d.feeds[0].state = "failing";
    d.feeds[0].last_ok = null;
    const html = await (await get("/notices", withNotices(d))).text();
    expect(html).toContain(
      "Could not be read at the last check: the IRCC feed in English (not read yet); the ESDC feed in French (last read 2026-10-20). The items read before stay listed.",
    );
    expect(items(html)).toHaveLength(10);
  });

  it("shows an English item's French on the English page when only the French feed carried it", async () => {
    const d = copy();
    const item = d.items[0];
    item.title.en = null;
    item.url.en = null;
    item.summary.en = null;
    item.terms.en = [];
    const html = await (await get("/notices", withNotices(d))).text();
    const row = items(html)[0];
    expect(row).toContain('<h3 class="notice-title" lang="fr">');
    expect(row).toContain("Title in French: the English feed does not carry this item.");
    expect(row).toContain("Terms: Entrée express.");
  });

  it("explains itself when notices.json is missing or unreadable, in both languages", async () => {
    for (const assets of [withNotices(null), withNotices({ ...copy(), items: [{ ...notices.items[0], url: { en: "javascript:alert(1)", fr: null } }] })]) {
      const res = await get("/notices", assets);
      expect(res.status).toBe(503);
      const html = await res.text();
      expect(html).toContain("<h1>Government Notices</h1>");
      expect(html).toContain("Some listed notices may touch these programs only in passing.");
      expect(html).toContain("The notices have not been read yet. This page fills after the next nightly refresh.");
      expect(html).not.toContain("notice-list");
      expect(html).toContain('<a href="/notices" class="active" aria-current="page">Notices</a>');
    }
    const fr = nbsp(await (await get("/notices?lang=fr", withNotices(null))).text());
    expect(fr).toContain("Les avis n’ont pas encore été lus.");
    // No data at all: the site-wide page.
    expect((await get("/notices", emptyAssets)).status).toBe(503);
  });

  it("checks the file it renders", () => {
    expect(isNoticesFile(notices)).toBe(true);
    const bad = copy();
    bad.items[0].url.en = "https://example.com/en/news.html";
    expect(isNoticesFile(bad)).toBe(false);
    const noTitle = copy();
    noTitle.items[0].title = { en: null, fr: null };
    expect(isNoticesFile(noTitle)).toBe(false);
    const miscount = copy();
    miscount.count = 11;
    expect(isNoticesFile(miscount)).toBe(false);
    const empty = { ...copy(), items: [], count: 0, first: null, last: null };
    expect(isNoticesFile(empty)).toBe(true);
  });

  it("says so when the last 12 months hold no notice", async () => {
    const html = await (await get("/notices", withNotices({ ...copy(), items: [], count: 0, first: null, last: null }))).text();
    expect(html).toContain("<h2>No notices from the last 12 months</h2>");
    expect(html).not.toContain('<ol class="notice-list">');
  });

  it("has a canonical URL, language alternates, a description and a breadcrumb", async () => {
    for (const [path, canonical] of [["/notices", "https://lmiawatch.ca/notices"], ["/notices?lang=fr", "https://lmiawatch.ca/notices?lang=fr"]]) {
      const html = await (await get(path)).text();
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head).toContain(`<link rel="canonical" href="${canonical}"`);
      expect(head).toContain('hreflang="en" href="https://lmiawatch.ca/notices"');
      expect(head).toContain('hreflang="fr" href="https://lmiawatch.ca/notices?lang=fr"');
      const description = head.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
      expect(description.length).toBeGreaterThan(50);
      expect(description.length).toBeLessThanOrEqual(159);
      expect(head).toContain('"@type":"BreadcrumbList"');
    }
    const head = await (await get("/notices")).text();
    expect(head).toContain("<title>Government Notices from IRCC and ESDC | LMIA Watch</title>");
    expect(head).toContain('<nav aria-label="Breadcrumb" class="breadcrumb"><a href="/">Home</a> / Government Notices</nav>');
    expect(routeTemplate("GET", "/notices")).toEqual({ route: "/notices", kind: "page" });
  });
});

describe("the nav, the footer and the About rename", () => {
  it("puts Notices between International and Methodology, and names the data page About, in both languages", async () => {
    const nav = mainNav(await (await get("/")).text());
    const order = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(order).toEqual([
      "/search Search", "/map Map", "/occupations Occupations", "/places Places", "/releases Releases", "/trends Trends",
      "/international International", "/notices Notices", "/methodology Methodology", "/data About", "/support Donate",
    ]);
    expect(nav).not.toContain("Data &amp; About");
    const fr = mainNav(await (await get("/?lang=fr")).text());
    expect(fr).toContain('<a href="/notices">Avis</a>');
    expect(fr).toContain('<a href="/data">À propos</a>');
    expect(fr).not.toContain("Données et à propos");
    const own = mainNav(await (await get("/notices")).text());
    expect(own).toContain('<a href="/notices" class="active" aria-current="page">Notices</a>');
    // The page keeps its URL and takes the same name as its heading.
    const data = await (await get("/data")).text();
    expect(mainNav(data)).toContain('<a href="/data" class="active" aria-current="page">About</a>');
    expect(data).toContain("<h1>About</h1>");
  });

  it("links the notices from the footer, next to Cite", async () => {
    expect(footer(await (await get("/")).text())).toContain('<a href="/cite">Cite</a><a href="/notices">Government Notices</a>');
    expect(footer(await (await get("/data?lang=fr")).text())).toContain('<a href="/cite">Citer</a><a href="/notices">Avis du gouvernement</a>');
  });
});

describe("the home page's notices", () => {
  it("lists the three latest notices below the topic rows, with a link to the page", async () => {
    const html = await (await get("/")).text();
    const start = html.indexOf('<section class="topic home-notices"');
    expect(start).toBeGreaterThan(html.lastIndexOf('<section class="topic">'));
    expect(start).toBeLessThan(html.indexOf("How to Read This Site"));
    const block = html.slice(start, html.indexOf("</section>", start));
    expect(block).toContain('<h2 id="home-notices">Government Notices</h2>');
    expect(block).toContain('<a href="/notices">All notices</a>');
    const lines = block.split("<li>").slice(1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('<span class="mono">2026-10-16</span>');
    expect(lines[0]).toContain(
      '<a href="https://www.canada.ca/en/immigration-refugees-citizenship/news/2026/10/canada-refocusing-express-entry-on-top-talent-that-drives-economic-growth.html" rel="nofollow noopener">Canada refocusing Express Entry',
    );
    expect(lines[2]).toContain('<span class="mono">2026-07-09</span>');
    expect(lines[2]).toContain("ESDC");
    const fr = nbsp(await (await get("/?lang=fr")).text());
    expect(fr).toContain('<h2 id="home-notices">Avis du gouvernement</h2>');
    expect(fr).toContain('<a href="/notices">Tous les avis</a>');
    expect(fr).toContain(">Le Canada réoriente le système Entrée express");
  });

  it("leaves the block out when notices.json is missing or unreadable, and the page renders", async () => {
    for (const assets of [withNotices(null), withNotices({ items: "no" })]) {
      const res = await get("/", assets);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("home-notices");
      expect(html).toContain("How to Read This Site");
    }
  });
});

describe("the Data page", () => {
  it("lists the Canada.ca news feeds in the licence table under canada.ca's terms, in both languages", async () => {
    expect(LICENCE_ROWS.at(-1)).toEqual({ material: "data.lic.notices", terms: "data.lic.notices_terms" });
    const html = await (await get("/data")).text();
    const lic = html.slice(html.indexOf('<h2 id="licence">'), html.indexOf('<h2 id="changelog">'));
    expect(lic).toContain("Government notices (the Canada.ca news feeds of IRCC and ESDC)");
    expect(lic).toContain(
      'Crown copyright, reproduced under the <a href="https://www.canada.ca/en/transparency/terms.html">Government of Canada terms of use (canada.ca)</a>: non-commercial reproduction with attribution.',
    );
    const fr = nbsp(await (await get("/data?lang=fr")).text());
    expect(fr).toContain("Avis du gouvernement (fils de nouvelles d’IRCC et d’EDSC sur Canada.ca)");
    expect(fr).toContain("Droit d’auteur de la Couronne, reproduits selon les");
  });

  it("puts the notices entry after the entry of November 4 and the two of October 30, then the two entries of October 25 in their order", () => {
    const rows = changelog("2026Q1", "en").map((r) => r.change);
    expect(rows.slice(0, 6)).toEqual([
      "data.change_privacy_links", "data.change_directory", "data.change_audience", "data.change_notices", "data.change_intl",
      "data.change_card_links",
    ]);
  });
});

describe("the watchdog", () => {
  it("emails a government notice the run recorded as a notice, with its full title and link, never as an alert", () => {
    const { status } = readStatus({
      run_at: "2026-10-27T00:50:00Z",
      ok: true,
      stages: [{ source: "gov_notices", ok: true, detail: "11 listed, 1 new tonight" }],
      notices: [{ source: "gov_notices", detail: "Government notice: 2026-10-26 Express Entry measure https://www.canada.ca/en/x.html" }],
    });
    const inputs = {
      now: new Date("2026-10-27T06:00:00Z"), dataAsOf: "2026-10-27", backupUploaded: new Date("2026-10-27T01:00:00Z"), status,
    };
    expect(collectAlerts(inputs)).toEqual([]);
    const notices = collectNotices(inputs);
    expect(notices).toEqual(["gov_notices: Government notice: 2026-10-26 Express Entry measure https://www.canada.ca/en/x.html"]);
    const mail = buildEmail("a@b.ca", "c@d.ca", [], inputs.now, notices);
    expect(mail).toContain("Subject: LMIA Watch: 1 notice from the last run");
    expect(mail).not.toContain("need attention");
    expect(mail).toContain("- gov_notices: Government notice: 2026-10-26 Express Entry measure https://www.canada.ca/en/x.html");
  });
});
