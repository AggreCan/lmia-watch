// The document a link preview gets in place of a page: the title, the
// description and the card image, with an empty body. Who gets it, and why,
// is in limits.ts (previewHead). Nothing here renders a page body or reads
// the forms or search databases: a page's own Seo is used when it is built
// from the dictionary alone, a profile reads only its shard (cached per
// isolate, as for the page), and every other page carries the home page's
// title and description under its own address.

import type { Context } from "hono";
import { html } from "hono/html";
import { loadProfile } from "./data";
import type { AppEnv } from "./env";
import { t, type Lang } from "./i18n";
import { feedsSeo } from "./pages/feeds";
import { internationalSeo } from "./pages/international";
import { noticesSeo } from "./pages/notices";
import { programSeo } from "./pages/program";
import { rankingSeo } from "./pages/rankings";
import { releasesIndexSeo } from "./pages/releases";
import { viewSeo } from "./pages/trends";
import { watchlistSeo } from "./pages/watchlist";
import { type Seo, SOCIAL_CARD, absoluteUrl, canonicalUrl, pageSeo, pageTitle, profileSeo } from "./seo";

// Pages whose Seo needs no data file. The pending trends view names the date
// its file starts, so it is not here.
const OWN_SEO: Record<string, (lang: Lang) => Seo> = {
  "/": (lang) => pageSeo("home", lang),
  "/search": (lang) => pageSeo("search", lang),
  "/map": (lang) => pageSeo("map", lang),
  "/methodology": (lang) => pageSeo("methodology", lang),
  "/data": (lang) => pageSeo("data", lang),
  "/support": (lang) => pageSeo("support", lang),
  "/cite": (lang) => pageSeo("cite", lang),
  "/corrections": (lang) => pageSeo("corrections", lang),
  "/feeds": feedsSeo,
  "/watchlist": watchlistSeo,
  "/international": internationalSeo,
  "/notices": noticesSeo,
  "/program": programSeo,
  "/releases": releasesIndexSeo,
  "/rankings": (lang) => rankingSeo(null, lang),
  "/trends": (lang) => viewSeo(lang, "national", null),
  "/trends/streams": (lang) => viewSeo(lang, "streams", null),
  "/trends/provinces": (lang) => viewSeo(lang, "provinces", null),
};

const PROFILE_PATH = /^\/employers\/([^/]+)$/;

// The Seo the head is built from, or null for an employer id with no
// profile, which the page itself answers (a redirect for a retired id, else
// its 404). path is the URL's own path, still percent-encoded.
export async function previewSeo(c: Context<AppEnv>, path: string, lang: Lang): Promise<Seo | null> {
  const id = PROFILE_PATH.exec(path)?.[1];
  if (id !== undefined) {
    const profile = await loadProfile(c.env, id);
    return profile ? profileSeo(profile, lang) : null;
  }
  const own = OWN_SEO[path];
  if (own) return own(lang);
  // The page's own address, so a card that links to its URL opens this page.
  return { ...pageSeo("home", lang), path };
}

export function previewDocument(seo: Seo, lang: Lang) {
  const url = canonicalUrl(seo.path, lang);
  const title = seo.title ?? pageTitle(seo.socialTitle ?? t(lang, "site.name"));
  const image = seo.image ?? SOCIAL_CARD;
  // As the layout chooses: the large card for a wide image, the small one for the square mark.
  const card = image.width > image.height ? "summary_large_image" : "summary";
  return html`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${seo.description}"><link rel="canonical" href="${url}"><meta property="og:site_name" content="${t(lang, "site.name")}"><meta property="og:type" content="website"><meta property="og:url" content="${url}"><meta property="og:title" content="${seo.socialTitle ?? title}"><meta property="og:description" content="${seo.description}"><meta property="og:image" content="${absoluteUrl(image.path)}"><meta property="og:image:width" content="${String(image.width)}"><meta property="og:image:height" content="${String(image.height)}"><meta property="og:image:alt" content="${image.alt(lang)}"><meta name="twitter:card" content="${card}"></head><body></body></html>`;
}
