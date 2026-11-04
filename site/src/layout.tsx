import type { Context } from "hono";
import { html } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";
import type { AppEnv } from "./env";
import { NOTICE_EE_URL, indicatorLabel, indicatorStateLabel, t, type Key, type Lang } from "./i18n";
import {
  type Seo, BLUESKY_ACCOUNT_URL, X_ACCOUNT_URL, X_HANDLE, absoluteUrl, alternates, canonicalUrl, defaultDescription, pageTitle,
} from "./seo";

// The formatting helpers live with the dictionary; pages import them from here.
export { fmtInt, fmtWage, periodLabel } from "./i18n";

// Cloudflare Web Analytics. The token is the site's public Web Analytics
// token: it is in every page's HTML and is not a secret. The snippet is
// rendered here, rather than injected by Cloudflare's automatic setup, so the
// edge never rewrites the HTML: the rewrite drops the ETag (conditional.ts).
// The Web Analytics site must stay on "Enable with JS Snippet installation";
// the nightly run checks that the edge leaves the home page's ETag and single
// beacon alone (pipeline/lmia_pipeline/resilience.py). The content security
// policy in index.tsx allows the script file and the host it reports to.
export const WEB_ANALYTICS_TOKEN = "ec72fdd415ae482690ab959217ebafe3";
export const WEB_ANALYTICS_SRC = "https://static.cloudflareinsights.com/beacon.min.js";
export const WEB_ANALYTICS_REPORT = "https://cloudflareinsights.com";

export const STATUS_LABEL: Record<string, Key> = {
  pending: "status.pending",
  approved: "status.approved",
  refused: "status.refused",
  lapsed: "status.lapsed",
  finding: "status.finding",
  none: "status.none",
};

export const Badge: FC<{ status: string; lang: Lang }> = ({ status, lang }) => {
  const key = STATUS_LABEL[status] ?? "status.none";
  return <span class={`badge badge-${status}`}>{t(lang, key)}</span>;
};

export const Chip: FC<PropsWithChildren<{ title?: string }>> = ({ children, title }) => (
  <span class="chip" title={title}>{children}</span>
);

// Titles join gendered forms with a slash ("Cuisiniers/cuisinières",
// "vineyard foreman/woman"), which gives a narrow column no place to break
// the line. A <wbr> after each slash adds one without a visible character.
export const slashBreaks = (s: string) => s.split("/").flatMap((part, i) => (i ? ["/", <wbr />, part] : [part]));

const INDICATOR_IDS = [
  "newly_incorporated",
  "repeat_applicant",
  "wage_at_floor",
  "low_wage_high_unemployment",
  "high_volume",
  "refused_then_reposted",
];
const INDICATOR_STATES = ["triggered", "not_triggered", "not_applicable", "not_evaluated"];

// English labels; indicatorLabel(lang, id) and indicatorStateLabel(lang, state)
// in i18n.ts give either language.
export const INDICATOR_LABEL: Record<string, string> = Object.fromEntries(INDICATOR_IDS.map((i) => [i, indicatorLabel("en", i)]));
export const INDICATOR_STATE_LABEL: Record<string, string> = Object.fromEntries(
  INDICATOR_STATES.map((s) => [s, indicatorStateLabel("en", s)]),
);

// Strings for a client script, as a JSON data block the script reads by id.
// A JSON block is never executed, so the script-src policy is untouched.
// Escaping < > & and the two line separators keeps the text from closing the
// element or being read as markup. The JSON-LD blocks in the head use the
// same escaper.
export function scriptJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export const ClientData: FC<{ id: string; data: unknown }> = ({ id, data }) => (
  <script type="application/json" id={id} dangerouslySetInnerHTML={{ __html: scriptJson(data) }}></script>
);

// The site mark: a two-column register with one entry cell filled. Drawn on a
// 16 px grid inside a 32-unit box so it stays crisp at 1 unit per pixel; the
// viewBox crops to the ink (24 by 20 units) and the fill is currentColor, which
// the stylesheet sets to navy (.brand-mark). Every coordinate is even, so the
// mark also stays crisp at 1.5 units per pixel. The same path is in
// public/favicon.svg and scripts/make-icons.py.
export const MARK_PATH = "M4 6h24v20H4z M6 8h6v4H6z M14 8h12v4H14z M6 14h6v4H6z M6 20h6v4H6z M14 20h12v4H14z";

// The project's X account, linked from the footer (defined in seo.ts, which
// also names it in the structured data).
export { X_ACCOUNT_URL };

// X's logo as a single path, drawn in the current text colour.
const XMark: FC = () => (
  <svg class="x-mark" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

// Bluesky's butterfly as a single path, in the current text colour, at the
// same height as the X mark (its official artwork is 568 by 501).
const BlueskyMark: FC = () => (
  <svg class="x-mark" viewBox="0 0 568 501" width="18" height="16" aria-hidden="true">
    <path fill="currentColor" d="M123.121 33.664C188.241 82.553 258.281 181.68 284 234.873c25.719-53.192 95.759-152.32 160.879-201.21C491.866-1.611 568-28.906 568 57.947c0 17.346-9.945 145.713-15.778 166.555-20.275 72.453-94.155 90.933-159.875 79.748C507.222 323.8 536.444 388.56 473.333 453.32c-119.86 122.992-172.272-30.859-185.702-70.281-2.462-7.227-3.614-10.608-3.631-7.733-.017-2.875-1.169.506-3.631 7.733-13.43 39.422-65.842 193.273-185.702 70.281-63.111-64.76-33.89-129.52 80.986-149.071-65.72 11.185-139.6-7.295-159.875-79.748C9.945 203.659 0 75.291 0 57.946 0-28.906 76.135-1.612 123.121 33.664Z" />
  </svg>
);

export const BrandMark: FC = () => (
  <svg class="brand-mark" viewBox="4 6 24 20" width="24" height="20" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" d={MARK_PATH} />
  </svg>
);

// Search and social metadata. A page without an Seo object (errors, the
// thank-you page) gets only the site description: no canonical, no cards.
const MetaTags: FC<{ seo?: Seo; lang: Lang; title: string }> = ({ seo, lang, title }) => {
  if (!seo) return <meta name="description" content={defaultDescription(lang)} />;
  if (seo.noindex) {
    return (
      <>
        <meta name="description" content={seo.description} />
        <meta name="robots" content="noindex" />
      </>
    );
  }
  const url = canonicalUrl(seo.path, lang);
  const socialTitle = seo.socialTitle ?? title;
  const image = seo.image;
  return (
    <>
      <meta name="description" content={seo.description} />
      <link rel="canonical" href={url} />
      {alternates(seo.path).map((a) => (
        <link rel="alternate" hreflang={a.hreflang} href={a.href} />
      ))}
      <meta property="og:site_name" content={t(lang, "site.name")} />
      <meta property="og:type" content="website" />
      <meta property="og:url" content={url} />
      <meta property="og:title" content={socialTitle} />
      <meta property="og:description" content={seo.description} />
      <meta property="og:locale" content={lang === "fr" ? "fr_CA" : "en_CA"} />
      <meta property="og:locale:alternate" content={lang === "fr" ? "en_CA" : "fr_CA"} />
      {image ? (
        <>
          <meta property="og:image" content={absoluteUrl(image.path)} />
          <meta property="og:image:type" content="image/png" />
          <meta property="og:image:width" content={String(image.width)} />
          <meta property="og:image:height" content={String(image.height)} />
          <meta property="og:image:alt" content={image.alt(lang)} />
        </>
      ) : null}
      <meta name="twitter:card" content={image && image.width > image.height ? "summary_large_image" : "summary"} />
      <meta name="twitter:site" content={X_HANDLE} />
      <meta name="twitter:title" content={socialTitle} />
      <meta name="twitter:description" content={seo.description} />
      {image ? (
        <>
          <meta name="twitter:image" content={absoluteUrl(image.path)} />
          <meta name="twitter:image:alt" content={image.alt(lang)} />
        </>
      ) : null}
      {(seo.jsonLd ?? []).map((data) => (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: scriptJson(data) }}></script>
      ))}
    </>
  );
};

export const Layout: FC<
  PropsWithChildren<{ lang: Lang; title: string; dataAsOf: string | null; active?: string; head?: unknown; seo?: Seo }>
> = (props) => {
  const { lang, active } = props;
  const nav = [
    ["/search", "nav.search"],
    ["/map", "nav.map"],
    ["/occupations", "nav.occupations"],
    ["/places", "nav.places"],
    ["/releases", "nav.releases"],
    ["/trends", "nav.trends"],
    ["/international", "nav.international"],
    ["/notices", "nav.notices"],
    ["/methodology", "nav.methodology"],
    ["/data", "nav.data"],
    ["/support", "nav.support"],
  ] as const;
  const title = props.seo?.title ?? pageTitle(props.title);
  return (
    <html lang={lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/styles.css?v=23" />
        <script src="/theme.js"></script>
        <script src="/links.js" defer></script>
        <script type="module" src={WEB_ANALYTICS_SRC} data-cf-beacon={JSON.stringify({ token: WEB_ANALYTICS_TOKEN })}></script>
        <link rel="preload" href="/fonts/public-sans-latin-var.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <MetaTags seo={props.seo} lang={lang} title={props.title} />
        {props.head as any}
      </head>
      <body>
        <header class="site-header">
          <div class="header-top">
            <div class="container header-row">
              <a href="/" class="brand">
                <BrandMark />
                <span class="brand-name">{t(lang, "site.name")}</span>
              </a>
              <span class="tagline">{t(lang, "site.tagline")}</span>
              <div class="header-meta">
                <span class="mono">
                  {t(lang, "nav.data_as_of")} {props.dataAsOf ?? t(lang, "common.na")}
                </span>
                <button type="button" class="theme-toggle">
                  <span class="when-light">{t(lang, "nav.dark")}</span>
                  <span class="when-dark">{t(lang, "nav.light")}</span>
                </button>
                <a href={`?lang=${lang === "fr" ? "en" : "fr"}`} class="lang-toggle" rel="nofollow">
                  {t(lang, "nav.lang")}
                </a>
              </div>
            </div>
          </div>
          <nav aria-label={t(lang, "nav.main_label")} class="main-nav">
            <div class="container">
              <ul>
                {nav.map(([href, key]) => (
                  <li>
                    <a href={href} class={active === href ? "active" : undefined} aria-current={active === href ? "page" : undefined}>
                      {t(lang, key)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </header>
        {/* TEMPORARY Express Entry notice: remove this block with NOTICE_EE_URL in i18n.ts. */}
        <div class="notice-ee">
          <p class="container">
            {t(lang, "notice_ee.text")}{" "}
            <a href="/methodology#express-entry">{t(lang, "notice_ee.track")}</a>{" "}
            <a href={NOTICE_EE_URL[lang]} rel="noopener">
              {t(lang, "notice_ee.link")}
            </a>
          </p>
        </div>
        <main class="container">{props.children}</main>
        <footer class="site-footer">
          <div class="container footer-row">
            <span>{t(lang, "footer.sources")}</span>
            <a href="/data#downloads">{t(lang, "footer.download")}</a>
            <a href="/watchlist">{t(lang, "footer.watchlist")}</a>
            <a href="/feeds">{t(lang, "footer.feeds")}</a>
            <a href="/corrections">{t(lang, "footer.corrections")}</a>
            <a href="/cite">{t(lang, "footer.cite")}</a>
            <a href="/notices">{t(lang, "footer.notices")}</a>
            <a href="/support">{t(lang, "footer.support")}</a>
            <span class="footer-copyright">
              {/* The maple leaf of the flag, the same path the marketing site uses. */}
              <svg class="leaf" viewBox="2900 380 3800 3960" width="13" height="14" aria-hidden="true">
                <path fill="currentColor" d="m 4800,595 -299,551 c -34,61 -95,55 -156,22 l -216,-112 161,855 c 34,156 -75,156 -128,88 l -378,-423 -61,214 c -7,28 -38,57 -82,51 l -475,-100 125,454 c 27,101 48,143 -27,170 l -170,60 820,666 c 32,25 48,70 37,110 l -72,235 802,-92 c 68,-8 91,29 92,86 l -37,845 h 136 l -36,-845 c 1,-57 24,-94 92,-86 l 802,92 -72,-235 c -11,-40 5,-85 37,-110 l 820,-666 -170,-60 c -75,-27 -54,-69 -27,-170 l 125,-454 -475,100 c -44,6 -75,-23 -82,-51 l -61,-214 -378,423 c -53,68 -162,68 -128,-88 l 161,-855 -216,112 c -61,33 -122,39 -156,-22 z" />
              </svg>
              {t(lang, "footer.copyright")}
            </span>
            <a href={X_ACCOUNT_URL} class="footer-x" target="_blank" rel="noopener" aria-label={t(lang, "footer.x")} title={t(lang, "footer.x")}>
              <XMark />
            </a>
            <a href={BLUESKY_ACCOUNT_URL} class="footer-x" target="_blank" rel="noopener" aria-label={t(lang, "footer.bluesky")} title={t(lang, "footer.bluesky")}>
              <BlueskyMark />
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
};

export function page(c: Context<AppEnv>, body: unknown, status = 200): Response | Promise<Response> {
  c.header("Cache-Control", status === 200 ? "public, max-age=300" : "no-store");
  return c.html(html`<!doctype html>${body as any}`, status as any);
}

// Shown while the data files have not been published yet (before the first
// nightly run, or on a dev checkout without `npm run data:local`).
export function noDataPage(c: Context<AppEnv>, title: Key): Response | Promise<Response> {
  const lang = c.get("lang") ?? "en";
  return page(
    c,
    <Layout lang={lang} title={t(lang, title)} dataAsOf={null}>
      <h1>{t(lang, "error.no_data")}</h1>
      <p>{t(lang, "error.no_data_text")}</p>
    </Layout>,
    503,
  );
}
