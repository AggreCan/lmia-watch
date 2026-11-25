// Search-engine metadata: the title and description a result list shows, the
// canonical URL and language alternates, the social-card tags, structured data
// (JSON-LD), and the two crawler files. layout.tsx renders a page's Seo object
// into its head; the page files build it with the helpers below. Words the
// pages already show (province names, breadcrumb words, page names) come from
// the dictionary in i18n.ts; the result-list titles and descriptions live here.

import type { Context } from "hono";
import { provincePath } from "./crosslinks";
import { assetResponse, lmiaGap, type Profile } from "./data";
import type { AppEnv } from "./env";
import { fmtInt, frTypography, provinceName, t, type Key, type Lang } from "./i18n";
import { ESDC_HISTORY_START_YEAR } from "./support";

// Canonical URLs name the apex domain whichever host served the request, so
// www and apex never compete in an index.
export const SITE_ORIGIN = "https://lmiawatch.ca";
export const SITE_NAME = "LMIA Watch";
export const X_ACCOUNT_URL = "https://x.com/LMIAwatch";
export const X_HANDLE = "@LMIAwatch";
export const BLUESKY_ACCOUNT_URL = "https://bsky.app/profile/lmiawatch.ca";
// A result list cuts a description near 160 characters; stay under it.
export const DESCRIPTION_MAX = 159;

// French sets a narrow no-break space before a colon, as the dictionary does.
const FR_COLON = `${String.fromCharCode(0x202f)}: `;

export interface SocialImage {
  path: string;
  width: number;
  height: number;
  alt: (lang: Lang) => string;
}

// Drawn by scripts/make-social-images.py from the site mark.
export const SOCIAL_CARD: SocialImage = {
  path: "/social-card.png",
  width: 1200,
  height: 630,
  alt: (lang) => `${SITE_NAME}${lang === "fr" ? FR_COLON : ": "}${t(lang, "site.tagline")}`,
};
export const SOCIAL_SQUARE: SocialImage = { path: "/social-square.png", width: 400, height: 400, alt: () => SITE_NAME };

export interface Seo {
  // The page's path with no query string. Filters, paging and the language
  // query all collapse onto it (French views add ?lang=fr, see canonicalUrl).
  path: string;
  description: string;
  // The whole <title>; without it the layout writes "<page title> | LMIA Watch".
  title?: string;
  // og:title and twitter:title; defaults to the page title.
  socialTitle?: string;
  // The large card goes on site pages (summary_large_image); profiles carry
  // the square mark (summary), so the employer's name leads the preview.
  image?: SocialImage;
  jsonLd?: object[];
  noindex?: boolean;
}

type Both = Record<Lang, string>;

export type PageKey = "home" | "search" | "map" | "methodology" | "data" | "support" | "cite" | "corrections";

// `name` is the result-list name, either written here or, where the page's own
// heading already reads well in a result list, its dictionary key.
const PAGES: Record<PageKey, { path: string; name: Both | Key; title?: Both; description: Both }> = {
  home: {
    path: "/",
    name: "site.name",
    title: {
      en: "LMIA Watch: Who Is Applying to Hire Temporary Foreign Workers",
      fr: "LMIA Watch : qui demande des travailleurs étrangers temporaires",
    },
    description: {
      en: "Which Canadian employers are applying to hire temporary foreign workers through an LMIA, where, and which were approved or refused. Updated nightly.",
      fr: "Quels employeurs canadiens demandent une EIMT pour embaucher des travailleurs étrangers temporaires, où, et quelles demandes sont approuvées ou refusées.",
    },
  },
  search: {
    path: "/search",
    name: { en: "Search LMIA Employer Records", fr: "Rechercher les dossiers EIMT des employeurs" },
    description: {
      en: "Search ESDC's lists of approved and refused LMIAs since 2014 and Job Bank's LMIA postings by employer, city or occupation.",
      fr: "Recherchez les EIMT approuvées et refusées des listes d’EDSC depuis 2014 et les offres EIMT du Guichet-Emplois, par employeur, ville ou profession.",
    },
  },
  map: {
    path: "/map",
    name: { en: "Map of LMIA Records by Postal Area", fr: "Carte des dossiers EIMT par secteur postal" },
    description: {
      en: "LMIA records across Canada grouped by postal area: pending Job Bank postings and the approved and refused LMIAs in ESDC's latest quarterly lists.",
      fr: "Les dossiers EIMT au Canada regroupés par secteur postal : offres en attente au Guichet-Emplois et EIMT approuvées ou refusées des dernières listes d’EDSC.",
    },
  },
  methodology: {
    path: "/methodology",
    name: { en: "Methodology: Sources, Status and Indicators", fr: "Méthodologie : sources, statuts et indicateurs" },
    description: {
      en: "How LMIA Watch reads Job Bank and ESDC records, assigns pending, approved, refused and lapsed status, matches employers and defines each indicator.",
      fr: "Comment LMIA Watch lit les dossiers du Guichet-Emplois et d’EDSC, attribue les statuts, apparie les employeurs et définit chaque indicateur.",
    },
  },
  data: {
    path: "/data",
    name: { en: "LMIA Data Downloads, API and Licence", fr: "Données EIMT : téléchargements, API et licence" },
    description: {
      en: `Every ESDC LMIA employer list since ${ESDC_HISTORY_START_YEAR}, nightly Job Bank observations and merged employers as CSV, a read-only JSON API, and each file's licence.`,
      fr: `Les listes EIMT d’EDSC depuis ${ESDC_HISTORY_START_YEAR}, les relevés du Guichet-Emplois et les employeurs fusionnés en CSV, une API JSON et la licence de chaque fichier.`,
    },
  },
  support: {
    path: "/support",
    name: "support.title",
    description: {
      en: "What LMIA Watch costs to run each month, how it is funded, and where a donation goes. The site is free, carries no advertising and sells nothing.",
      fr: "Ce que coûte LMIA Watch chaque mois, comment le site est financé et où va un don. Le site est gratuit, sans publicité, et ne vend rien.",
    },
  },
  cite: {
    path: "/cite",
    name: "cite.title",
    description: {
      en: "How to cite LMIA Watch and its data in APA, MLA, Chicago, Harvard, BibTeX or RIS, with the data date that each citation should name.",
      fr: "Comment citer LMIA Watch et ses données selon APA, MLA, Chicago, Harvard, BibTeX ou RIS, avec la date des données à indiquer.",
    },
  },
  corrections: {
    path: "/corrections",
    name: "employer.correct",
    description: {
      en: "Report a wrong employer match, a stale record or a misfiring indicator. Changes appear in the profile's corrections log after review.",
      fr: "Signalez un mauvais appariement, un dossier périmé ou un indicateur erroné. Les changements figurent au journal des corrections du profil après examen.",
    },
  },
};

// French strings written here get the dictionary's typography (apostrophe,
// the narrow space before a colon); English is left as written.
function local(lang: Lang, both: Both): string {
  return lang === "fr" ? frTypography(both.fr) : both.en;
}

// Pages with no Seo of their own (errors, the thank-you page) still carry a
// description: the home page's.
export function defaultDescription(lang: Lang): string {
  return local(lang, PAGES.home.description);
}

export function pageTitle(name: string): string {
  return `${name} | ${SITE_NAME}`;
}

export function pageSeo(key: PageKey, lang: Lang, extra: Partial<Seo> = {}): Seo {
  const p = PAGES[key];
  const name = typeof p.name === "string" ? t(lang, p.name) : local(lang, p.name);
  const title = p.title ? local(lang, p.title) : pageTitle(name);
  return {
    path: p.path,
    title,
    socialTitle: p.title ? title : name,
    description: local(lang, p.description),
    image: SOCIAL_CARD,
    ...extra,
  };
}

// Google pairs language versions only between canonical URLs, and a crawler
// carries no cookie, so the plain URL is the English page and ?lang=fr the
// French one. Each version names itself as canonical; a French page that named
// the plain URL would be folded into the English one and drop out of results.
export function canonicalUrl(path: string, lang: Lang): string {
  return `${SITE_ORIGIN}${path}${lang === "fr" ? "?lang=fr" : ""}`;
}

export function alternates(path: string): { hreflang: string; href: string }[] {
  return [
    { hreflang: "en", href: canonicalUrl(path, "en") },
    { hreflang: "fr", href: canonicalUrl(path, "fr") },
    { hreflang: "x-default", href: canonicalUrl(path, "en") },
  ];
}

export function absoluteUrl(path: string): string {
  return `${SITE_ORIGIN}${path}`;
}

// The publisher is the project, never a person.
const PUBLISHER = {
  "@type": "Organization",
  name: SITE_NAME,
  url: `${SITE_ORIGIN}/`,
};

export function homeJsonLd(lang: Lang): object {
  const org = `${SITE_ORIGIN}/#organization`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        ...PUBLISHER,
        "@id": org,
        logo: {
          "@type": "ImageObject",
          url: absoluteUrl(SOCIAL_SQUARE.path),
          width: SOCIAL_SQUARE.width,
          height: SOCIAL_SQUARE.height,
        },
        sameAs: [X_ACCOUNT_URL, BLUESKY_ACCOUNT_URL],
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_ORIGIN}/#website`,
        name: SITE_NAME,
        url: `${SITE_ORIGIN}/`,
        description: local(lang, PAGES.home.description),
        inLanguage: ["en-CA", "fr-CA"],
        publisher: { "@id": org },
        potentialAction: {
          "@type": "SearchAction",
          target: { "@type": "EntryPoint", urlTemplate: `${SITE_ORIGIN}/search?q={search_term_string}` },
          "query-input": "required name=search_term_string",
        },
      },
    ],
  };
}

export const OGL_URL: Both = {
  en: "https://open.canada.ca/en/open-government-licence-canada",
  fr: "https://ouvert.canada.ca/fr/licence-du-gouvernement-ouvert-canada",
};
// Job Bank and IRCC material is under these terms, which the site cannot relicense.
export const CANADA_TERMS_URL: Both = {
  en: "https://www.canada.ca/en/transparency/terms.html",
  fr: "https://www.canada.ca/fr/transparence/avis.html",
};
// A download's licence group: the OGL, canada.ca's terms, or one that mixes
// sources column by column (the Data page's licence table says which).
export type DownloadLicence = "ogl" | "canada" | "mixed";
const LICENCE_URL: Record<Exclude<DownloadLicence, "mixed">, Both> = { ogl: OGL_URL, canada: CANADA_TERMS_URL };
const SOURCE_DATASETS = [
  "https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97",
  "https://open.canada.ca/data/en/dataset/f82f66f2-a22b-4511-bccf-e1d74db39ae5",
  "https://www.jobbank.gc.ca/",
  "https://www.canada.ca/en/immigration-refugees-citizenship/services/work-canada/employers-non-compliant.html",
];
const DATASET_NAME: Both = {
  en: "LMIA Watch: Labour Market Impact Assessment Employer Records",
  fr: "LMIA Watch : dossiers des employeurs visés par une étude d’impact sur le marché du travail",
};
const DATASET_DESCRIPTION: Both = {
  en:
    `Every ESDC quarterly positive and negative LMIA employer list since ${ESDC_HISTORY_START_YEAR}, nightly ` +
    'observations of Job Bank postings flagged "LMIA requested" or "Approved LMIA", and IRCC\'s list of ' +
    "non-compliant employers, merged by employer under a stable employer ID. Each row keeps the Job Bank posting " +
    "ID or the ESDC resource ID it came from. Regenerated nightly and after each quarterly ESDC release.",
  fr:
    `Toutes les listes trimestrielles positives et négatives d’EDSC sur les EIMT depuis ${ESDC_HISTORY_START_YEAR}, ` +
    "les relevés quotidiens des offres du Guichet-Emplois portant la mention « EIMT demandée » ou « EIMT approuvée », " +
    "et la liste des employeurs non conformes d’IRCC, fusionnés par employeur sous un identifiant stable. Chaque ligne " +
    "garde le numéro de l’offre du Guichet-Emplois ou l’identifiant de ressource d’EDSC d’où elle vient. Régénéré " +
    "chaque nuit et après chaque publication trimestrielle d’EDSC.",
};
const DATASET_KEYWORDS: Record<Lang, string[]> = {
  en: ["LMIA", "Labour Market Impact Assessment", "Temporary Foreign Worker Program", "temporary foreign workers", "Job Bank", "ESDC", "IRCC", "Canada"],
  fr: ["EIMT", "étude d’impact sur le marché du travail", "Programme des travailleurs étrangers temporaires", "travailleurs étrangers temporaires", "Guichet-Emplois", "EDSC", "IRCC", "Canada"],
};
const CREDIT: Both = {
  en: "Contains information licensed under the Open Government Licence, Canada, and Job Bank and IRCC material reproduced under the Government of Canada terms of use (canada.ca).",
  fr: "Contient des informations visées par la Licence du gouvernement ouvert, Canada, et du contenu du Guichet-Emplois et d’IRCC reproduit selon les conditions d’utilisation du gouvernement du Canada (canada.ca).",
};
// For a file that mixes sources, which has no single licence to declare.
const MIXED_NOTE: Both = {
  en: "The licence differs by column; see the licence table on the Data page.",
  fr: "La licence varie selon la colonne; voir le tableau des licences de la page Données.",
};

// `contents` is each file's description in the page's language. The files do
// not share one licence, so the dataset-wide `license` (a property Google's
// Dataset guidance asks for) is the page's own licence table, which states
// the terms file by file; each distribution carries its own licence too.
export function datasetJsonLd(
  downloads: { file: string; contents: string; licence: DownloadLicence }[], dataAsOf: string | null, lang: Lang,
): object {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${SITE_ORIGIN}/data#dataset`,
    name: local(lang, DATASET_NAME),
    description: local(lang, DATASET_DESCRIPTION),
    url: absoluteUrl("/data"),
    keywords: DATASET_KEYWORDS[lang],
    license: `${absoluteUrl("/data")}#licence`,
    usageInfo: `${absoluteUrl("/data")}#licence`,
    isAccessibleForFree: true,
    creditText: local(lang, CREDIT),
    creator: PUBLISHER,
    publisher: PUBLISHER,
    inLanguage: lang,
    spatialCoverage: { "@type": "Place", name: "Canada" },
    temporalCoverage: `${ESDC_HISTORY_START_YEAR}/..`,
    ...(dataAsOf ? { dateModified: dataAsOf } : {}),
    isBasedOn: SOURCE_DATASETS,
    distribution: downloads.map((d) => ({
      "@type": "DataDownload",
      name: d.file,
      description: d.licence === "mixed" ? `${d.contents}. ${local(lang, MIXED_NOTE)}` : d.contents,
      encodingFormat: "text/csv",
      contentUrl: absoluteUrl(`/downloads/${d.file}`),
      ...(d.licence === "mixed" ? {} : { license: LICENCE_URL[d.licence][lang] }),
    })),
  };
}

// Mirrors the visible trail on the profile (Home / province / Employer), in the
// dictionary's words. The province crumb links to the province's place page.
// Without one (no province, or a head office outside Canada) the page shows
// that crumb as plain text and the list leaves it out, since every crumb but
// the last needs a URL. The last crumb is the word "Employer", as on the page.
export function profileBreadcrumbJsonLd(province: string | null, lang: Lang): object {
  const provPath = provincePath(province);
  const crumbs: { name: string; item?: string }[] = [
    { name: t(lang, "common.home"), item: `${SITE_ORIGIN}/` },
    ...(province && provPath ? [{ name: provinceName(lang, province), item: absoluteUrl(provPath) }] : []),
    { name: t(lang, "employer.title") },
  ];
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, ...c })),
  };
}

function count(n: number, lang: Lang): string {
  return fmtInt(n, lang);
}

function plural(n: number, one: string, many: string, lang: Lang): string {
  // English takes the singular for 1 only; French for 0 and 1, as tn() does.
  const singular = lang === "fr" ? Math.abs(n) < 2 : n === 1;
  return `${count(n, lang)} ${singular ? one : many}`;
}

function joinList(parts: string[], lang: Lang): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${lang === "fr" ? "et" : "and"} ${parts[parts.length - 1]}`;
}

function place(city: string | null, province: string | null, lang: Lang): string {
  // Mid-sentence, the dictionary's "Head office outside Canada" takes a small letter.
  const outside = provinceName(lang, "XX");
  const prov = province === "XX" ? outside.charAt(0).toLowerCase() + outside.slice(1) : province;
  return [city, prov].filter(Boolean).join(", ");
}

// Cuts at a word boundary and marks the cut with an ellipsis.
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

// One fact per count on the profile's summary card, with and without the
// positions, which are the first detail to go when space runs short.
function profileFacts(profile: Profile, lang: Lang): { full: string; short: string }[] {
  const e = profile.employer;
  const fr = lang === "fr";
  const facts: { full: string; short: string }[] = [];
  const add = (full: string, short = full) => facts.push({ full, short });
  const positions = (n: number) => (fr ? plural(n, "poste", "postes", lang) : plural(n, "position", "positions", lang));
  if (e.pending_count > 0) {
    add(fr
      ? plural(e.pending_count, "offre en attente au Guichet-Emplois", "offres en attente au Guichet-Emplois", lang)
      : plural(e.pending_count, "pending Job Bank posting", "pending Job Bank postings", lang));
  }
  // The LMIA counts read as the page's summary card does: rows from files
  // without an LMIA count add one each, and the figure is then a floor.
  const gapApproved = lmiaGap(profile.esdc, "positive");
  const gapRefused = lmiaGap(profile.esdc, "negative");
  const atLeast = (gap: number, text: string) => (gap > 0 ? `${fr ? "au moins" : "at least"} ${text}` : text);
  const approved = e.approved_lmias + gapApproved;
  if (approved > 0) {
    const n = atLeast(gapApproved, fr
      ? plural(approved, "EIMT approuvée", "EIMT approuvées", lang)
      : plural(approved, "approved LMIA", "approved LMIAs", lang));
    add(`${n} (${positions(e.approved_positions)})`, n);
  }
  const refused = e.refused_lmias + gapRefused;
  if (refused > 0) {
    const n = atLeast(gapRefused, fr
      ? plural(refused, "EIMT refusée", "EIMT refusées", lang)
      : plural(refused, "refused LMIA", "refused LMIAs", lang));
    add(`${n} (${positions(e.refused_positions)})`, n);
  }
  if (e.finding_count > 0) {
    add(fr
      ? plural(e.finding_count, "constat de non-conformité d’IRCC", "constats de non-conformité d’IRCC", lang)
      : plural(e.finding_count, "IRCC non-compliance finding", "IRCC non-compliance findings", lang));
  }
  if (facts.length === 0) {
    const records = profile.postings.length + profile.esdc.length;
    add(fr
      ? plural(records, "dossier EIMT public", "dossiers EIMT publics", lang)
      : plural(records, "public LMIA record", "public LMIA records", lang));
  }
  return facts;
}

// "Jealous Fruits Ltd., Kelowna, BC: 19 approved LMIAs (760 positions). LMIA
// records from Job Bank and ESDC, each linked to its source." The counts are
// the profile's own summary, so the snippet and the page agree. When space
// runs short the closing sentence goes first, then the position counts, then
// the place, and only then is the name clipped. The employer's name is used
// exactly as recorded, never retouched by the French typography.
export function profileDescription(profile: Profile, lang: Lang): string {
  const e = profile.employer;
  const facts = profileFacts(profile, lang);
  const sep = lang === "fr" ? FR_COLON : ": ";
  const full = `${sep}${joinList(facts.map((f) => f.full), lang)}.`;
  const short = `${sep}${joinList(facts.map((f) => f.short), lang)}.`;
  const tail = lang === "fr"
    ? " Dossiers du Guichet-Emplois et d’EDSC, chacun lié à sa source."
    : " LMIA records from Job Bank and ESDC, each linked to its source.";
  const where = place(e.city, e.province, lang);
  const head = where ? `${e.display_name}, ${where}` : e.display_name;
  const candidates = [head + full + tail, head + full, head + short + tail, head + short, e.display_name + short];
  const fit = candidates.find((s) => s.length <= DESCRIPTION_MAX);
  if (fit) return fit;
  const room = DESCRIPTION_MAX - short.length;
  return room >= 20 ? clip(e.display_name, room) + short : clip(e.display_name + short, DESCRIPTION_MAX);
}

// The title is the one the layout would write from the page's heading, set
// here so the head given to a link preview (preview.ts) reads the same.
export function profileSeo(profile: Profile, lang: Lang): Seo {
  const e = profile.employer;
  return {
    path: `/employers/${e.id}`,
    title: pageTitle(e.display_name),
    description: profileDescription(profile, lang),
    socialTitle: e.display_name,
    image: SOCIAL_SQUARE,
    jsonLd: [profileBreadcrumbJsonLd(e.province, lang)],
  };
}

// The response form exists once per employer and repeats the same copy, so it
// stays out of the index; the profile it belongs to is the page to find.
export function respondFormSeo(profile: Profile, lang: Lang): Seo {
  const name = profile.employer.display_name;
  return {
    path: `/employers/${profile.employer.id}/respond`,
    description: clip(
      lang === "fr"
        ? `Publier la réponse de l’employeur sur le profil de ${name}, avec la date de réception.`
        : `Post the employer's statement on the profile of ${name}, unedited and dated.`,
      DESCRIPTION_MAX,
    ),
    noindex: true,
  };
}

// --- Crawler files ---------------------------------------------------------

const XML_HEADERS = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" };

// The pipeline writes the sitemap index and its parts under data/sitemaps/.
// They are served from the site root (/sitemap.xml, /sitemap-<n>.xml) because a
// sitemap may only list URLs at or below its own directory, and the profiles
// live at /employers/. The Worker streams the file without parsing it.
export async function sitemapFile(c: Context<AppEnv>): Promise<Response> {
  const m = /^sitemap(?:-([0-9]{1,4}))?\.xml$/.exec(c.req.param("file") ?? "");
  const res = m ? await assetResponse(c.env, `sitemaps/${m[1] ? `sitemap-${m[1]}` : "index"}.xml`) : null;
  if (!res) return c.notFound();
  return new Response(res.body, { headers: XML_HEADERS });
}

// public/robots.txt is served by the assets layer before the Worker runs. This
// route answers when a request reaches the Worker anyway (a run-worker-first
// configuration, the test runtime), from the same file.
// public/llms.txt tells AI crawlers and agents where the bulk files are, so
// they need not walk the profiles; served the same way as robots.txt.
export async function llmsTxt(c: Context<AppEnv>): Promise<Response> {
  const res = c.env.ASSETS ? await c.env.ASSETS.fetch(new Request("https://assets.invalid/llms.txt")) : null;
  if (!res || !res.ok) return c.notFound();
  return new Response(res.body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

export async function robotsTxt(c: Context<AppEnv>): Promise<Response> {
  const res = c.env.ASSETS ? await c.env.ASSETS.fetch(new Request("https://assets.invalid/robots.txt")) : null;
  if (!res || !res.ok) return c.notFound();
  return new Response(res.body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
