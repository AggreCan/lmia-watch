import { describe, expect, it } from "vitest";
import { cityPath, placeKey } from "../src/crosslinks";
import { app } from "../src/index";
import { WEB_ANALYTICS_SRC, WEB_ANALYTICS_TOKEN } from "../src/layout";
import { contentEtag, emptyAssets, fakeAssets, testEnv } from "./assets";
import occIndex from "./fixtures/occupations-index.json";
import placeBc from "./fixtures/place-bc.json";
import stats from "./fixtures/stats.json";

const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, testEnv());
const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
// The home page's two topic rows, by the status tag that opens each head.
const topic = (html: string, status: "pending" | "approved") => {
  const start = html.indexOf(`<section class="topic"><div class="topic-head"><h2><span class="badge badge-${status}">`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
};

describe("pages", () => {
  it("home renders tiles and lists from stats.json", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Who Is Applying to Hire Temporary Foreign Workers");
    expect(html).toContain("5,883");
    expect(html).toContain("PinkCloud Cleaning &amp; Home Services");
    expect(html).toContain("Jealous Fruits Ltd.");
    expect(html).toContain("Data as of 2026-10-12");
    expect(html).toContain("Primary Agriculture");
    expect(html).toContain("2026 Q1");
    expect(html).toContain("Job Bank postings that gained the &quot;LMIA requested&quot; flag most recently.");
    expect(topic(html, "pending")).toContain('<h3 class="sub">By Province</h3><div class="bars">');
    expect(html).toContain('<a href="/search?status=pending&amp;province=BC">British Columbia</a>');
    // Search covers every year, so the last-quarter links carry the window.
    expect(html).toContain('<a href="/search?status=approved&amp;date=last_quarter">Approved Last Quarter</a>');
    expect(html).toContain('<a href="/search?status=refused&amp;date=last_quarter">Refused Last Quarter</a>');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml"');
    expect(html).toContain('class="brand-mark"');
    expect(html).toContain('<script src="/theme.js"></script>');
    // Off-site links open in a new tab; the script marks the rest at load.
    expect(html).toContain('<a href="https://x.com/LMIAwatch" class="footer-x" target="_blank" rel="noopener" aria-label="LMIA Watch on X"');
    expect(html).toContain('<a href="https://bsky.app/profile/lmiawatch.ca" class="footer-x" target="_blank" rel="noopener" aria-label="LMIA Watch on Bluesky"');
    expect(html).toContain('<script src="/links.js" defer=""></script>');
    expect(html).toContain('<button type="button" class="theme-toggle"><span class="when-light">Dark</span><span class="when-dark">Light</span></button>');
  });

  it("home sets out two topic rows below the tiles, pending then approved, each under a full-width head", async () => {
    const html = await (await get("/")).text();
    const pendingHead =
      '<div class="topic-head"><h2><span class="badge badge-pending">Pending</span> now on Job Bank ' +
      '<span class="topic-count">5,883 postings flagged &quot;LMIA requested&quot;</span></h2>' +
      '<a href="/search?status=pending">All Pending (5,883)</a></div>';
    const approvedHead =
      '<div class="topic-head"><h2><span class="badge badge-approved">Approved</span> in 2026 Q1 ' +
      '<span class="topic-count">8,790 employer records, 33,216 positions</span></h2>' +
      '<a href="/search?status=approved">All Approved</a></div>';
    expect(html).toContain(pendingHead);
    expect(html).toContain(approvedHead);
    // Below the tiles and above the reading notes, pending first; the old
    // headed columns and the second row of bars are gone.
    expect(html.match(/<section class="topic">/g)?.length).toBe(2);
    expect(html.indexOf('class="tiles"')).toBeLessThan(html.indexOf(pendingHead));
    expect(html.indexOf(pendingHead)).toBeLessThan(html.indexOf(approvedHead));
    expect(html.indexOf(approvedHead)).toBeLessThan(html.indexOf("How to Read This Site"));
    expect(html).not.toContain("section-head");
    expect(html).not.toContain('<section class="two-col">');
    expect(html).not.toContain("Approved Records by");

    // Each row: the records on the left, the breakdowns on the right.
    const subs = (part: string) => [...part.matchAll(/<h3 class="sub">([^<]*)<\/h3>/g)].map((m) => m[1]);
    const pending = topic(html, "pending");
    expect(subs(pending)).toEqual(["Applying This Week", "By Province", "By Occupation"]);
    expect(pending).toContain('<div class="two-col"><div><h3 class="sub">Applying This Week</h3><p class="muted small">Job Bank postings that gained');
    expect(pending).toContain('<div><h3 class="sub">By Province</h3>');
    const approved = topic(html, "approved");
    expect(subs(approved)).toEqual(["Recently Approved", "By Stream", "By Province", "Largest Approvals in 2026 Q1, by Positions"]);
    expect(approved).toContain('<div class="two-col"><div><h3 class="sub">Recently Approved</h3><p class="muted small">Postings whose flag changed');
    expect(approved).toContain('<div><h3 class="sub">By Stream</h3><div class="bars">');
    expect(approved).toContain('<h3 class="sub">Largest Approvals in 2026 Q1, by Positions</h3><div class="table-wrap">');
    expect(approved).toContain(
      '<p class="links"><a href="/releases">Every quarterly release, with its largest approvals</a>' +
        '<a href="/trends">Approvals and refusals since 2014, year over year</a></p>',
    );
    // The links row closes the left column, before the breakdowns.
    expect(approved.indexOf('<p class="links">')).toBeLessThan(approved.indexOf('<h3 class="sub">By Stream</h3>'));

    const fr = nbsp(await (await get("/?lang=fr")).text());
    expect(fr).toContain(
      '<h2><span class="badge badge-pending">En attente</span> en ce moment au Guichet-Emplois ' +
        '<span class="topic-count">5 883 offres portant la mention « EIMT demandée »</span></h2>' +
        '<a href="/search?status=pending">Toutes en attente (5 883)</a>',
    );
    expect(fr).toContain(
      '<h2><span class="badge badge-approved">Approuvée</span> au T1 2026 ' +
        '<span class="topic-count">8 790 dossiers d’employeurs, 33 216 postes</span></h2>' +
        '<a href="/search?status=approved">Toutes les approbations</a>',
    );
    expect(subs(topic(fr, "pending"))).toEqual(["Demandes de la semaine", "Par province", "Par profession"]);
    expect(subs(topic(fr, "approved"))).toEqual([
      "Approuvées récemment", "Par volet", "Par province", "Plus grandes approbations, T1 2026, selon le nombre de postes",
    ]);
  });

  it("home names the public records on profiles and counts the employers matched to a federal agreement", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("Each employer&#39;s page also carries its corporate registry record and, where the public records match,");
    expect(html).toContain('<span class="badge badge-neutral">Public money</span><span class="tile-value">2,140</span>');
    expect(html).toContain(
      '<a href="/data#public-records">employers matched to a federal grant or contribution (9,812 agreements)</a>',
    );
    expect(html).toContain('<a href="/methodology#matching">corporate registry record</a>');
    expect(html).toContain('<a href="/data#public-records">US carrier records</a>');
    expect(html).not.toContain(String.fromCharCode(0x2014));
    const fr = await (await get("/?lang=fr")).text();
    expect(fr).toContain("Fonds publics");
    expect(fr).toContain("accords)</a>");
    expect(fr).toContain('<a href="/data#public-records">dossiers de transporteurs américains</a>');
    // The anchor the tile and the list link to.
    expect(await (await get("/data")).text()).toContain('<p id="public-records">');
  });

  it("home ranks the pending table by the day the flag was seen, with the posting date under it", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("<th>Flagged</th><th>Employer</th>");
    expect(html).toContain('class="mono"><span>2026-10-12<br/><span class="muted small">posted 2026-10-10</span></span></td>');
    expect(html).toContain("gained the &quot;LMIA requested&quot; flag most recently");
    const fr = await (await get("/?lang=fr")).text();
    expect(fr).toContain("<th>Signalée</th>");
    expect(fr).toContain("publiée le 2026-10-10");
    // A stats file from before the field lists by posting date, as before.
    const older = { ...stats, recent_pending: stats.recent_pending.map(({ flagged, ...row }) => row) };
    const assets = {
      fetch: async (input: Request) =>
        new URL(input.url).pathname === "/data/stats.json" ? new Response(JSON.stringify(older)) : fakeAssets.fetch(input),
    } as unknown as Fetcher;
    const old = await (await app.request("/", {}, testEnv(assets))).text();
    expect(old).toContain("<th>Posted</th><th>Employer</th>");
    expect(old).not.toContain("Flagged");
  });

  it("home shows four tiles when stats.json has no public-record counts, or none matched yet", async () => {
    const { grant_employers, grant_agreements, ...older } = stats.counts;
    for (const counts of [older, { ...stats.counts, grant_employers: 0, grant_agreements: 0 }, { ...stats.counts, grant_employers: "2140" }]) {
      const assets = {
        fetch: async (input: Request) =>
          new URL(input.url).pathname === "/data/stats.json"
            ? new Response(JSON.stringify({ ...stats, counts }))
            : fakeAssets.fetch(input),
      } as unknown as Fetcher;
      const res = await app.request("/", {}, testEnv(assets));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("badge-neutral");
      expect(html.match(/class="tile"/g)?.length).toBe(4);
    }
  });

  it("home charts pending postings by occupation under the province bars", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain('<h3 class="sub">By Occupation</h3><p class="muted small">of 1,204 postings with a NOC 2021 code</p><div class="bars">');
    // The code in muted mono before the title, which links to the filtered search.
    expect(html).toContain('<span class="mono muted">85101</span> <a href="/search?status=pending&amp;noc=85101">Harvesting labourers</a>');
    expect(html).toContain('<a href="/search?status=pending&amp;noc=62020">Food service supervisors</a>');
    // Six rows of the eight the export writes, after the province bars.
    expect(html).not.toContain("noc=65201");
    const pending = topic(html, "pending");
    expect(pending.indexOf("By Occupation")).toBeGreaterThan(pending.indexOf("By Province"));
    const fr = await (await get("/?lang=fr")).text();
    expect(nbsp(fr)).toContain('<h3 class="sub">Par profession</h3><p class="muted small">sur 1 204 offres portant un code de la CNP 2021</p>');
    expect(fr).toContain('<a href="/search?status=pending&amp;noc=85101">Manœuvres à la récolte</a>');
    // A slash in a title is a place the line may break.
    expect(fr).toContain(">Cuisiniers/<wbr/>cuisinières</a>");
  });

  it("home leaves out the occupation bars when stats.json lacks them or they fail the check", async () => {
    const { pending_by_noc: rows, ...older } = stats;
    const { pending_with_noc, ...olderCounts } = stats.counts;
    const variants: unknown[] = [
      older,
      { ...stats, counts: olderCounts },
      { ...stats, counts: { ...stats.counts, pending_with_noc: "1204" } },
      { ...stats, pending_by_noc: [] },
      { ...stats, pending_by_noc: "x" },
      { ...stats, pending_by_noc: [{ ...rows[0], k: "8510" }] },
      { ...stats, pending_by_noc: [{ ...rows[0], title: "Harvesting labourers" }] },
      { ...stats, pending_by_noc: [{ ...rows[0], title: { en: "Harvesting labourers" } }] },
      { ...stats, pending_by_noc: [rows[0], { ...rows[1], n: "187" }] },
    ];
    for (const body of variants) {
      const assets = {
        fetch: async (input: Request) =>
          new URL(input.url).pathname === "/data/stats.json" ? new Response(JSON.stringify(body)) : fakeAssets.fetch(input),
      } as unknown as Fetcher;
      const res = await app.request("/", {}, testEnv(assets));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("By Occupation");
      expect(html).not.toContain("noc=");
      // The rest of the page stands.
      expect(topic(html, "pending")).toContain('<h3 class="sub">By Province</h3>');
      expect(html).toContain("Jealous Fruits Ltd.");
    }
  });

  // This file's search database is empty (test/search_page.test.ts fills its
  // own), so these are the fallback: the page as before hosted search.
  it("a plain search visit is rendered on the server with counts", async () => {
    const html = await (await get("/search")).text();
    expect(html).toContain('data-ssr="1"');
    expect(html).toContain("5 records");
    expect(html).toContain("PinkCloud Cleaning &amp; Home Services");
    expect(html).toContain("Haveli Restaurant Inc");
    expect(html).toContain("Job Bank 50456228");
    expect(html).toContain("Newly incorporated applicant");
    expect(html).toContain('data-count="status:pending"> 2');
    expect(html).toContain('data-count="province:BC"> 4');
    expect(html).toContain("Page 1 of 1");
    expect(html).toContain('<p class="panel bordered" id="search-unavailable" role="status">Search is unavailable for the moment, so the newest records are shown.</p>');
    const page2 = await (await get("/search?page=2")).text();
    expect(page2).toContain('data-ssr="1"');
    expect(page2).toContain("No records.");
  });

  it("a filtered search without the search database keeps the filters and shows the newest records", async () => {
    const html = await (await get("/search?status=refused&province=NL&q=haveli&date=since_2023q4")).text();
    expect(html).toContain('data-mode="static"');
    expect(html).toContain('data-ssr="1"');
    expect(html).toContain('<p class="panel bordered" id="search-unavailable" role="status">Search is unavailable for the moment, so the newest records are shown.</p>');
    expect(html).toContain('src="/search.js"');
    expect(html).toContain('value="haveli"');
    expect(html).toMatch(/name="status" value="refused" checked/);
    expect(html).toMatch(/name="province" value="NL" checked/);
    // The longer search period is gone: its old value is dropped, and every year is the default.
    expect(html).not.toContain("since_2023q4");
    expect(html).toMatch(/name="date" value="any" checked/);
    expect(html).not.toContain("data-years");
    expect(html).toContain("Haveli Restaurant Inc</a>");
    expect(html).toContain("downloads");
  });

  it("employer profile shows every section, including published site rows", async () => {
    const res = await get("/employers/emp-a000000001");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const s of [
      "PinkCloud Cleaning &amp; Home Services",
      "BC1596446",
      "Probable",
      "Newly incorporated applicant",
      "Triggered",
      "Timeline",
      "Job Bank 50456228",
      "1-866-602-9448",
      "sole proprietorship since 2018",
      "1 published",
      "Submit an Employer Response",
      'class="minimap" role="img" aria-label="Map of postal area V0N, centred on its centroid"',
      "https://tile.openstreetmap.org/11/",
      "Map: OpenStreetMap contributors",
    ]) {
      expect(html).toContain(s);
    }
    // The indicator table restacks on a phone, each cell labelled with its column.
    expect(html).toMatch(/<table class="restack"><thead><tr><th>Indicator<\/th><th>State<\/th><th>Basis<\/th>/);
    expect(html).toContain('<td data-label="Indicator">Newly incorporated applicant</td>');
    expect(html).toContain('<td data-label="State"><span class="badge state-triggered">Triggered</span></td>');
    expect(html).toMatch(/<td data-label="Basis">[^<]+<\/td>/);
    expect(html).not.toContain("Map at postal-area centroid");
    expect(html).not.toContain("still under review");
    const edsa = await (await get("/employers/emp-a000000002")).text();
    expect(edsa).toContain("405 Martin Street");
    expect(edsa).toContain("Street updated from the current posting.");
    const refused = await (await get("/employers/emp-a000000008")).text();
    expect(refused).toContain("ESDC negative 2026Q1");
    expect(refused).toContain("Refused");
    // The timeline reads newest first; the awaiting-decision line, when present, sits above the dated events.
    const timeline = html.slice(html.indexOf('<ol class="timeline">'), html.indexOf("</ol>", html.indexOf('<ol class="timeline">')));
    const dates = [...timeline.matchAll(/<li class="tl-(?!future)[a-z]+"><span class="mono">(\d{4}-\d{2}-\d{2})<\/span>/g)].map((m) => m[1]);
    expect(dates.length).toBeGreaterThan(1);
    expect([...dates].sort().reverse()).toEqual(dates);
    if (timeline.includes('class="tl-future"')) expect(timeline.indexOf('class="tl-future"')).toBeLessThan(timeline.search(/<li class="tl-(?!future)/));
  });

  it("unknown or malformed employer ids are 404s in the layout", async () => {
    const res = await get("/employers/emp-ffffffffff");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Employer Not Found");
    const bad = await get("/employers/../../etc");
    expect(bad.status).toBe(404);
  });

  it("map, methodology and data pages render", async () => {
    const map = await get("/map?fsa=v0n");
    expect(map.status).toBe(200);
    const mapHtml = await map.text();
    expect(mapHtml).toContain('id="map"');
    expect(mapHtml).toContain("leaflet");
    expect(mapHtml).toContain('data-fsa="V0N"');
    expect(mapHtml).toContain("never");

    const meth = await (await get("/methodology")).text();
    expect(meth).toContain("<h2 id=\"status\">Status Lifecycle</h2>");
    expect(meth).toContain("Known false positives");
    expect(meth).toContain("Private households and individuals are not published");
    expect(meth).toContain("(NOC 4411, 4412, 44100 or 44101) and the employer is named as a person");
    // The wage and unemployment rules as published, with their sources.
    expect(meth).toContain("Job Bank wages by occupation and economic region (ESDC, open.canada.ca)");
    expect(meth).toContain("Statistics Canada Labour Force Survey, table 14-10-0459-01");
    expect(meth).toContain("Statistics Canada 2021 Census boundary files");
    expect(meth).toContain("Posted minimum wage is within 1 percent of the Job Bank median for the posting&#39;s occupation and economic region");
    expect(meth).toContain("the provincial and then the national median");
    expect(meth).toContain("6 percent or higher in both three-month periods that could have applied");
    expect(meth).toContain("Since 2024-09-26 ESDC refuses to process low-wage applications");
    expect(meth).toContain("food manufacturing including fish processing, hospitals, nursing and residential care");
    expect(meth).not.toContain("(planned)");

    const data = await (await get("/data")).text();
    expect(data).toContain("pending_observations.csv");
    expect(data).toContain("Open Government Licence");
    expect(data).toContain("2026Q1");
    expect(data).toContain("GeoNames");
    expect(data).toContain('href="https://open.canada.ca/data/en/dataset/adad580f-76b0-4502-bd05-20c125de9116"');
    expect(data).toContain("Labour Force Survey table 14-10-0459-01");
    expect(data).toContain("Statistics Canada Open Licence");
    expect(data).toContain('<td class="mono nw">2026-10-17</td>');
    // Newest change first.
    expect(data.indexOf('<td class="mono nw">2026-10-18</td>')).toBeLessThan(data.indexOf('<td class="mono nw">2026-10-12</td>'));
    expect(data).toContain("Indicator rules v0.2.");
    expect(data).toContain("Private households left out of the ESDC lists");
    expect(data).not.toContain("planned");
    // The ESDC files, the changelog and the recent runs each scroll inside their own box.
    expect(data.split('class="table-wrap bordered scroll-y"').length - 1).toBe(3);
  });

  it("downloads fall back to a plain 404 page when nothing is published", async () => {
    const res = await get("/downloads/employers.csv");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not available yet");
  });

  it("unknown routes get the 404 page", async () => {
    const res = await get("/nothing-here");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Page Not Found");
  });

  it("explains itself when the data files are missing", async () => {
    const res = await app.request("/", {}, testEnv(emptyAssets));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Data Not Published Yet");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sets security headers on every response", async () => {
    const res = await get("/");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("cdnjs.cloudflare.com");
    // The Web Analytics beacon: its one file may run, and it may report to its host.
    const csp = Object.fromEntries(
      (res.headers.get("content-security-policy") ?? "").split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values];
      }),
    );
    expect(csp["script-src"]).toEqual(["'self'", "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/", WEB_ANALYTICS_SRC]);
    expect(csp["connect-src"]).toEqual(["'self'", "https://cloudflareinsights.com"]);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("cache-control")).toContain("max-age=300");
  });

  it("switches language by query and cookie", async () => {
    const res = await get("/?lang=fr");
    expect(res.headers.get("set-cookie")).toContain("lang=fr");
    expect(await res.text()).toContain("Recherche");
    const cookie = await (await get("/methodology", { cookie: "lang=fr" })).text();
    expect(cookie).toContain("Carte");
    const en = await (await get("/methodology")).text();
    expect(en).toContain(">Map<");
  });
});

// The place and occupation files the employer page links from, served beside
// the other fixtures with content ETags as the assets binding sends them.
// BC's file lists Kelowna (linked), Oliver under the threshold and Brackendale
// flagged as not indexed; NL's lists St. John's under a spelling of its own.
const LINK_FILES: Record<string, unknown> = {
  "places/bc.json": {
    ...placeBc,
    threshold: 3,
    cities: [
      { slug: "kelowna", name: "Kelowna", records: 40 },
      { slug: "oliver", name: "Oliver", records: 2 },
      { slug: "brackendale", name: "Brackendale", records: 9, indexed: false },
    ],
  },
  "places/nl.json": { kind: "province", prov: "NL", slug: "nl", threshold: 3, cities: [{ slug: "st-johns", name: "ST JOHNS", records: 12 }] },
  "occupations/index.json": {
    ...occIndex,
    threshold: 3,
    rows: [
      { ...occIndex.rows[1], noc: "85101", records: 40, indexed: true, title: { en: "Harvesting labourers", fr: "Manœuvres à la récolte" } },
      { ...occIndex.rows[0], noc: "60020", records: 12, indexed: true, title: { en: "Retail sales supervisors", fr: "Superviseurs/superviseures des ventes au détail" } },
      { ...occIndex.rows[0], noc: "60040", records: 1, indexed: false },
      // No flag: the record count against the file's threshold decides.
      { noc: "60030", title: { en: "Restaurant and food service managers", fr: "Gestionnaires de la restauration" }, records: 5, positions: 5, latest_positions: 0, pending: 0 },
    ],
  },
};

function linkAssets(files: Record<string, unknown> = LINK_FILES): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname.replace(/^\/data\//, "");
      if (!(path in files)) return fakeAssets.fetch(input);
      const file = files[path];
      const body = typeof file === "string" ? file : JSON.stringify(file);
      return new Response(body, { headers: { "content-type": "application/json", etag: await contentEtag(body) } });
    },
  } as unknown as Fetcher;
}

const profilePage = async (id: string, assets: Fetcher = linkAssets(), headers: Record<string, string> = {}) => {
  const res = await app.request(`/employers/${id}`, { headers }, testEnv(assets));
  expect(res.status, id).toBe(200);
  return res.text();
};
// The location card's City row.
const cityRow = (html: string) => html.match(/<dt>(?:City|Ville)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1].trim();

describe("employer page links to place and occupation pages", () => {
  it("links the province crumb to the province page", async () => {
    const html = await profilePage("emp-a000000005");
    expect(html).toContain('<a href="/">Home</a> / <a href="/places/bc">British Columbia</a> / Employer');
    const fr = await profilePage("emp-a000000008", linkAssets(), { cookie: "lang=fr" });
    expect(fr).toContain('<a href="/">Accueil</a> / <a href="/places/nl">Terre-Neuve-et-Labrador</a> / Employeur');
  });

  it("links the city when its province's file lists an indexed page for it", async () => {
    expect(cityRow(await profilePage("emp-a000000005"))).toBe('<a href="/places/bc/kelowna">Kelowna</a>, BC');
    // "St. John's" on the record, "ST JOHNS" in the file, "st-johns" as the slug.
    expect(cityRow(await profilePage("emp-a000000008"))).toBe('<a href="/places/nl/st-johns">St. John&#39;s</a>, NL');
    // Under the threshold, flagged not indexed, or not listed: plain text.
    expect(cityRow(await profilePage("emp-a000000009"))).toBe("Oliver, BC");
    expect(cityRow(await profilePage("emp-a000000001"))).toBe("Brackendale, BC");
    expect(cityRow(await profilePage("emp-a000000002"))).toBe("Penticton, BC");
  });

  it("folds city names the way the pipeline folds them into slugs", () => {
    expect(placeKey("St. John's")).toBe("st johns");
    expect(placeKey("st-johns")).toBe("st johns");
    expect(placeKey("Saint-Jean-sur-Richelieu")).toBe("st jean sur richelieu");
    expect(placeKey("Sainte-Thérèse")).toBe("ste therese");
    expect(placeKey("  MONTRÉAL ")).toBe("montreal");
    expect(placeKey("L’Assomption")).toBe("lassomption");
    expect(placeKey("Cœur--d'Alène")).toBe("coeur dalene");
    expect(placeKey("--")).toBe("");
  });

  it("links a NOC code only when its occupation page is indexed", async () => {
    // ESDC rows: the code links, the title stays beside it as text.
    const fruits = await profilePage("emp-a000000005");
    expect(fruits).toContain('<td><a href="/occupations/85101">85101</a> Harvesting labourers</td>');
    // A four-digit NOC 2011 code has no page.
    const orchard = await profilePage("emp-a000000009");
    expect(orchard).toContain('<a href="/occupations/85101">85101</a> Harvesting labourers');
    expect(orchard).toContain("<td>8611 Harvesting labourers</td>");
    // Postings show the code alone, so the title goes in the link's title attribute, in the page's language.
    const edsa = await profilePage("emp-a000000002");
    expect(edsa).toContain('<td>NOC <a href="/occupations/60020" title="Retail sales supervisors">60020</a></td>');
    const edsaFr = await profilePage("emp-a000000002", linkAssets(), { cookie: "lang=fr" });
    expect(edsaFr).toContain('<td>CNP <a href="/occupations/60020" title="Superviseurs/superviseures des ventes au détail">60020</a></td>');
    // Listed but not indexed: plain text.
    const pink = await profilePage("emp-a000000001");
    expect(pink).toContain("<td>NOC 60040</td>");
    expect(pink).not.toContain('href="/occupations/');
    // No flag in the row: its record count meets the file's threshold.
    expect(await profilePage("emp-a000000008")).toContain('<a href="/occupations/60030">60030</a> Restaurant and food service managers');
  });

  it("renders plain text when the index files are missing or do not parse", async () => {
    const broken = linkAssets({ "places/bc.json": '{"cities": [', "occupations/index.json": "not json" });
    for (const assets of [fakeAssets, broken]) {
      const html = await profilePage("emp-a000000005", assets);
      expect(cityRow(html)).toBe("Kelowna, BC");
      expect(html).toContain("<td>85101 Harvesting labourers</td>");
      expect(html).not.toContain('href="/occupations/');
      expect(html).not.toContain('href="/places/bc/');
      // The province page exists whatever the files say.
      expect(html).toContain('<a href="/places/bc">British Columbia</a>');
    }
    // A file of the wrong shape reads as no pages.
    const odd = linkAssets({ "places/bc.json": { cities: "Kelowna" }, "occupations/index.json": { rows: { noc: "85101" } } });
    const html = await profilePage("emp-a000000005", odd);
    expect(cityRow(html)).toBe("Kelowna, BC");
    expect(html).not.toContain('href="/occupations/');
  });

  it("follows a changed file at once, never a lookup built from the old one", async () => {
    const env = testEnv(linkAssets());
    expect(await cityPath(env, "BC", "KELOWNA")).toBe("/places/bc/kelowna");
    const changed = { ...LINK_FILES, "places/bc.json": { threshold: 3, cities: [{ slug: "penticton", name: "Penticton", records: 30 }] } };
    const after = testEnv(linkAssets(changed));
    expect(await cityPath(after, "BC", "Kelowna")).toBeNull();
    expect(await cityPath(after, "BC", "Penticton")).toBe("/places/bc/penticton");
    // No page for a head office outside Canada, an unknown code, or no city.
    expect(await cityPath(after, "XX", "Penticton")).toBeNull();
    expect(await cityPath(after, "ZZ", "Penticton")).toBeNull();
    expect(await cityPath(after, "BC", null)).toBeNull();
  });
});

// Cloudflare Web Analytics, rendered in the layout so the edge never rewrites
// the HTML. The attribute is read back the way a browser reads it: entities
// decoded, then the JSON parsed.
describe("the Web Analytics beacon", () => {
  const IP = { "cf-connecting-ip": "198.51.100.160" };
  const BEACON = /<script type="module" src="([^"]*)" data-cf-beacon="([^"]*)"><\/script>/g;
  const decodeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  it("is in the head of every HTML page once, with the site's token", async () => {
    const pages: [string, number][] = [
      ["/", 200],
      ["/?lang=fr", 200],
      ["/employers/emp-a000000001", 200],
      ["/corrections", 200],
      ["/methodology", 200],
      ["/nothing-here", 404],
      ["/employers/emp-ffffffffff", 404],
    ];
    for (const [path, status] of pages) {
      const res = await get(path, IP);
      expect(res.status, path).toBe(status);
      const html = await res.text();
      const tags = [...html.matchAll(BEACON)];
      expect(tags, path).toHaveLength(1);
      expect(html.split("cloudflareinsights").length - 1, path).toBe(1);
      const [tag, src, beacon] = tags[0];
      expect(src, path).toBe(WEB_ANALYTICS_SRC);
      expect(JSON.parse(decodeAttr(beacon)), path).toEqual({ token: WEB_ANALYTICS_TOKEN });
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head.indexOf(tag), path).toBeGreaterThan(head.indexOf('<script src="/links.js" defer=""></script>'));
    }
    const missing = await (await app.request("/", { headers: IP }, testEnv(emptyAssets))).text();
    expect([...missing.matchAll(BEACON)]).toHaveLength(1);
    expect(WEB_ANALYTICS_TOKEN).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is not in the JSON API, the sitemaps or the feeds", async () => {
    for (const path of ["/api/stats", "/api/employers/emp-a000000001", "/sitemap.xml"]) {
      const res = await get(path, IP);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain("cloudflareinsights");
    }
    const FEED = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Pending</title></feed>';
    const feedAssets = {
      fetch: async () => new Response(FEED, { headers: { "content-type": "application/atom+xml" } }),
    } as unknown as Fetcher;
    const feed = await app.request("/data/feeds/canada/pending.xml", { headers: IP }, testEnv(feedAssets));
    expect(feed.status).toBe(200);
    expect(await feed.text()).toBe(FEED);
  });
});

describe("the correction link on a profile", () => {
  it("names the employer in the fragment, so every profile links one URL", async () => {
    const html = await (await get("/employers/emp-a000000001", { "cf-connecting-ip": "198.51.100.161" })).text();
    expect(html.split('href="/corrections#emp-a000000001"').length - 1).toBe(2);
    expect(html).not.toContain("/corrections?employer=");
    expect(html).not.toContain("/corrections?");
  });
});
