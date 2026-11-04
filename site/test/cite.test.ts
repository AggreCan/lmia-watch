import { describe, expect, it } from "vitest";
import { isoDate, styleDate, validCitation } from "../src/cite";
import { app } from "../src/index";
import { emptyAssets, fakeAssets, testEnv } from "./assets";
import stats from "./fixtures/stats.json";

const EM_DASH = String.fromCharCode(0x2014);
const CITATION = {
  title: "LMIA Watch: ESDC positive and negative LMIA employer lists, derived files",
  concept_doi: "10.5281/zenodo.1000001",
  doi: "10.5281/zenodo.1000005",
  version: "2026Q1",
  published: "2026-10-19",
};

// The fixture export with fields of stats.json replaced (a citation added),
// served the way the assets binding serves the real one.
function withStats(extra: object): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === "/data/stats.json") {
        return new Response(JSON.stringify({ ...stats, ...extra }), { headers: { "content-type": "application/json" } });
      }
      return fakeAssets.fetch(input as RequestInfo, init);
    },
  } as unknown as Fetcher;
}
const withCitation = (citation: unknown) => withStats({ citation });

const get = async (path: string, assets: Fetcher) => (await app.request(path, {}, testEnv(assets))).text();

describe("how to cite", () => {
  it("stays hidden until a DOI exists", async () => {
    for (const path of ["/data", "/methodology", "/data?lang=fr"]) {
      expect(await get(path, fakeAssets), path).not.toContain('id="cite"');
      expect(await get(path, withCitation(null)), path).not.toContain('id="cite"');
    }
    expect(await get("/data", withCitation({ ...CITATION, concept_doi: "javascript:alert(1)" }))).not.toContain('id="cite"');
  });

  it("shows the version DOI and the concept DOI on the Data and Methodology pages", async () => {
    for (const path of ["/data", "/methodology"]) {
      const html = await get(path, withCitation(CITATION));
      expect(html, path).toContain('<h2 id="cite">How to Cite</h2>');
      expect(html).toContain("LMIA Watch (2026). <cite>LMIA Watch: ESDC positive and negative LMIA employer lists, derived files</cite> (Version 2026Q1) [Data set]. Zenodo.");
      expect(html).toContain('<a href="https://doi.org/10.5281/zenodo.1000005">https://doi.org/10.5281/zenodo.1000005</a>');
      expect(html).toContain('<a href="https://doi.org/10.5281/zenodo.1000001">https://doi.org/10.5281/zenodo.1000001</a>');
      expect(html).not.toContain(EM_DASH);
    }
  });

  it("speaks French on French pages", async () => {
    const html = (await get("/data?lang=fr", withCitation(CITATION))).replace(/[  ]/g, " ");
    expect(html).toContain('<h2 id="cite">Comment citer</h2>');
    expect(html).toContain("(version 2026Q1) [Jeu de données]. Zenodo.");
    expect(html).toContain("utilisez le DOI de concept");
    expect(html).not.toContain("How to Cite");
    expect(html).not.toContain("[Data set]");
  });

  it("falls back to the concept DOI alone when the version DOI is missing", async () => {
    const html = await get("/data", withCitation({ ...CITATION, doi: null }));
    expect(html).toContain('<a href="https://doi.org/10.5281/zenodo.1000001">');
    expect(html).not.toContain("concept DOI");
  });

  it("accepts only DOI-shaped values", () => {
    expect(validCitation(CITATION)).toEqual(CITATION);
    expect(validCitation(null)).toBeNull();
    expect(validCitation(undefined)).toBeNull();
    expect(validCitation({ ...CITATION, concept_doi: "https://doi.org/10.5281/zenodo.1" })).toBeNull();
    expect(validCitation({ ...CITATION, concept_doi: '10.5281/zenodo.1"><script>' })).toBeNull();
  });
});

describe("statements on the Data and Support pages", () => {
  it("says the site counts pages in aggregate, in both languages", async () => {
    const en = await get("/data", fakeAssets);
    expect(en).toContain("The site counts the pages it serves in aggregate");
    expect(en).toContain("keeps no IP address.");
    // The visitor code in plain words: what is hashed, that it rotates daily, that no address is kept.
    expect(en).toContain("a visitor code: the IP address and the browser&#39;s identification are hashed (SHA-256) with a key that changes every day (UTC)");
    expect(en).toContain("The address and the browser&#39;s identification are then dropped.");
    expect(en).toContain("The same browser gets a different code the next day");
    const fr = (await get("/data?lang=fr", fakeAssets)).replace(/[  ]/g, " ");
    expect(fr).toContain("Le site compte de façon agrégée les pages qu’il sert");
    expect(fr).toContain("l’adresse IP et l’identification du navigateur sont hachées (SHA-256) avec une clé qui change chaque jour (UTC)");
    expect(fr).toContain("L’adresse et l’identification du navigateur sont ensuite écartées.");
    expect(fr).toContain("Le même navigateur reçoit un code différent le lendemain");
    expect(fr).toContain("ne conserve aucune adresse IP.");
  });

  it("names Cloudflare Web Analytics as the one measuring script, in both languages", async () => {
    const en = await get("/data", fakeAssets);
    expect(en).toContain("The site sets no cookie for these counts and keeps no IP address.");
    expect(en).toContain("The one measuring script the pages load in the browser is Cloudflare Web Analytics, which records each page view");
    expect(en).toContain("Cloudflare states that it sets no cookie, stores nothing in the browser and does not fingerprint visitors by their IP address");
    expect(en).not.toContain("runs no tracking script");
    const fr = (await get("/data?lang=fr", fakeAssets)).replace(/[  ]/g, " ");
    expect(fr).toContain("Le site ne dépose aucun témoin pour ces comptes et ne conserve aucune adresse IP.");
    expect(fr).toContain("Le seul script de mesure que les pages chargent dans le navigateur est Cloudflare Web Analytics, qui enregistre chaque page vue");
    expect(fr).toContain("Selon Cloudflare, ce script ne dépose aucun témoin, ne conserve rien dans le navigateur et n’établit aucune empreinte numérique des visiteurs");
    expect(fr).not.toContain("aucun script de suivi");
  });

  it("notes that the Bluesky post is free", async () => {
    expect(await get("/support", fakeAssets)).toContain("The same daily post on Bluesky is free to send");
    expect(await get("/support?lang=fr", fakeAssets)).toContain("La même publication quotidienne sur Bluesky est gratuite");
  });
});

// The citation blocks as a reader copies them: markup dropped, entities read,
// French no-break spaces compared as plain ones.
const decode = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const blocks = (html: string) =>
  [...html.matchAll(/<pre class="cite-block">([\s\S]*?)<\/pre>/g)].map((m) => decode(m[1]).replace(/[  ]/g, " "));
// The fixture's data date is 2026-10-12; the date of access is today's (UTC).
const today = () => new Date().toISOString().slice(0, 10);

describe("the /cite page", () => {
  it("answers in both languages, linked from the footer between Corrections and Support", async () => {
    for (const [path, word] of [["/cite", "Cite"], ["/cite?lang=fr", "Citer"], ["/", "Cite"], ["/data?lang=fr", "Citer"]]) {
      const res = await app.request(path, {}, testEnv(fakeAssets));
      expect(res.status, path).toBe(200);
      const html = await res.text();
      const footer = html.slice(html.indexOf('<footer class="site-footer">'));
      const at = (href: string) => footer.indexOf(`<a href="${href}">`);
      expect(at("/corrections"), path).toBeGreaterThan(-1);
      expect(at("/corrections"), path).toBeLessThan(at("/cite"));
      expect(at("/cite"), path).toBeLessThan(at("/support"));
      expect(footer, path).toContain(`<a href="/cite">${word}</a>`);
      expect(html, path).not.toContain(EM_DASH);
    }
  });

  it("gives the website in six styles, each naming the data date", async () => {
    const html = await get("/cite", fakeAssets);
    expect(html).toContain("<h1>How to Cite</h1>");
    expect(html).toContain("2026-10-12 in the citations below");
    expect(html).toContain('<h3 id="cite-apa">APA (7th edition)</h3>');
    expect(html).toContain(
      "LMIA Watch. (2026). <i>LMIA Watch: Public records of Labour Market Impact Assessments</i> (Data as of October 12, 2026). Retrieved ",
    );
    expect(html).toContain('<script src="/cite.js" defer=""></script>');
    const [apa, mla, chicago, harvard, bib, ris, ...rest] = blocks(html);
    expect(rest).toEqual([]);
    expect(apa).toMatch(/Retrieved [A-Z][a-z]+ \d{1,2}, \d{4}, from https:\/\/lmiawatch\.ca$/);
    expect(mla).toMatch(/^LMIA Watch: Public Records of Labour Market Impact Assessments\. Data as of 12 Oct\. 2026, lmiawatch\.ca\. Accessed \d{1,2} [A-Z][a-z]+\.? \d{4}\.$/);
    expect(chicago).toMatch(/^LMIA Watch\. 2026\. LMIA Watch: Public Records of Labour Market Impact Assessments\. Data as of October 12, 2026\. Accessed .+\. https:\/\/lmiawatch\.ca\.$/);
    expect(harvard).toMatch(/^LMIA Watch \(2026\) LMIA Watch: public records of Labour Market Impact Assessments\. Data as of 12 October 2026\. Available at: https:\/\/lmiawatch\.ca \(Accessed: .+\)\.$/);
    expect(bib).toBe([
      "@misc{lmiawatch2026,",
      "  author       = {{LMIA Watch}},",
      "  title        = {{LMIA Watch: public records of Labour Market Impact Assessments}},",
      "  year         = {2026},",
      "  howpublished = {\\url{https://lmiawatch.ca}},",
      "  note         = {Data as of 2026-10-12},",
      `  urldate      = {${today()}},`,
      "}",
    ].join("\n"));
    expect(ris.startsWith("TY  - ELEC\n")).toBe(true);
    expect(ris).toBe([
      "TY  - ELEC",
      "TI  - LMIA Watch: public records of Labour Market Impact Assessments",
      "AU  - LMIA Watch",
      "PY  - 2026",
      "DA  - 2026/10/12",
      "UR  - https://lmiawatch.ca",
      `Y2  - ${today().replace(/-/g, "/")}`,
      "N1  - Data as of 2026-10-12",
      "ER  - ",
    ].join("\n"));
    // No deposit in the fixture, so no data section.
    expect(html).not.toContain('<h2 id="data">');
    expect(html).not.toContain("@dataset");
  });

  it("speaks French on the French page", async () => {
    const html = (await get("/cite?lang=fr", fakeAssets)).replace(/[  ]/g, " ");
    expect(html).toContain("<h1>Comment citer</h1>");
    expect(html).toContain('<h2 id="website">Le site Web</h2>');
    expect(html).toContain("(Données au 12 octobre 2026). Consulté le ");
    expect(html).toContain("<i>LMIA Watch : dossiers publics des études d’impact sur le marché du travail</i>");
    const [apa, mla, , harvard, bib, ris] = blocks(html);
    expect(apa).toMatch(/Consulté le .+ à https:\/\/lmiawatch\.ca$/);
    expect(mla).toContain("Données au 12 oct. 2026, lmiawatch.ca. Consulté le ");
    expect(harvard).toContain("Disponible à l’adresse : https://lmiawatch.ca (consulté le ");
    // The machine formats carry plain spaces and straight apostrophes.
    expect(bib).toContain("title        = {{LMIA Watch : dossiers publics des études d'impact sur le marché du travail}},");
    expect(bib).toContain("note         = {Données au 2026-10-12},");
    expect(ris).toContain("N1  - Données au 2026-10-12");
    expect(html).not.toContain("Retrieved");
    expect(html).not.toContain("Data as of");
  });

  it("adds the Zenodo deposit in BibTeX and RIS when stats.json carries one", async () => {
    const html = await get("/cite", withCitation(CITATION));
    expect(html).toContain('<h2 id="data">The Data</h2>');
    // The deposit's APA reference comes from the shared block, under the page's own heading.
    expect(html).toContain("(Version 2026Q1) [Data set]. Zenodo.");
    expect(html).not.toContain('<h2 id="cite">');
    const found = blocks(html);
    expect(found).toHaveLength(8);
    expect(found[6]).toBe([
      "@dataset{lmiawatch2026data,",
      "  author    = {{LMIA Watch}},",
      "  title     = {{LMIA Watch: ESDC positive and negative LMIA employer lists, derived files}},",
      "  year      = {2026},",
      "  version   = {2026Q1},",
      "  publisher = {Zenodo},",
      "  doi       = {10.5281/zenodo.1000005},",
      "  url       = {https://doi.org/10.5281/zenodo.1000005},",
      "}",
    ].join("\n"));
    expect(found[7]).toBe([
      "TY  - DATA",
      "TI  - LMIA Watch: ESDC positive and negative LMIA employer lists, derived files",
      "AU  - LMIA Watch",
      "PY  - 2026",
      "ET  - 2026Q1",
      "PB  - Zenodo",
      "DO  - 10.5281/zenodo.1000005",
      "UR  - https://doi.org/10.5281/zenodo.1000005",
      "ER  - ",
    ].join("\n"));
    expect(html).not.toContain(EM_DASH);
    expect(await get("/cite?lang=fr", withCitation(CITATION))).toContain('<h2 id="data">Les données</h2>');
    // Without a well-formed DOI, only the website section.
    for (const bad of [null, { ...CITATION, concept_doi: "javascript:alert(1)" }]) {
      const page = await get("/cite", withCitation(bad));
      expect(page).not.toContain("@dataset");
      expect(page).not.toContain('<h2 id="data">');
      expect(blocks(page)).toHaveLength(6);
    }
  });

  it("answers 503 without a usable data date", async () => {
    expect((await app.request("/cite", {}, testEnv(emptyAssets))).status).toBe(503);
    for (const data_as_of of [null, "2026-13-45", "2026-02-30", 20261012]) {
      expect((await app.request("/cite", {}, testEnv(withStats({ data_as_of })))).status, String(data_as_of)).toBe(503);
    }
  });

  it("writes dates the way each style does", () => {
    expect(styleDate("2026-10-12", "en", "apa")).toBe("October 12, 2026");
    expect(styleDate("2026-10-12", "en", "chicago")).toBe("October 12, 2026");
    expect(styleDate("2026-10-12", "en", "harvard")).toBe("12 October 2026");
    expect(styleDate("2026-10-12", "en", "mla")).toBe("12 Oct. 2026");
    expect(styleDate("2026-09-01", "en", "mla")).toBe("1 Sept. 2026");
    expect(styleDate("2026-06-05", "en", "mla")).toBe("5 June 2026");
    expect(styleDate("2026-07-01", "fr", "apa")).toBe("1er juillet 2026");
    expect(styleDate("2026-10-12", "fr", "harvard")).toBe("12 octobre 2026");
    expect(styleDate("2026-10-12", "fr", "mla")).toBe("12 oct. 2026");
    expect(isoDate("2026-10-12")).toBe("2026-10-12");
    for (const bad of ["2026-13-45", "2026-02-30", "2026-1x-40", "", 7, null, undefined]) expect(isoDate(bad), String(bad)).toBeNull();
  });
});
