import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { secureHeaders } from "hono/secure-headers";
import { api } from "./api";
import { conditional } from "./conditional";
import { loadStats } from "./data";
import type { AppEnv, Env } from "./env";
import { kofiWebhook } from "./hooks";
import { refuseAutomatedBrowser, throttle } from "./limits";
import { measure } from "./views";
import { runWatchdog } from "./watchdog";
import { langFrom, t, tj } from "./i18n";
import { Layout, WEB_ANALYTICS_REPORT, WEB_ANALYTICS_SRC, page } from "./layout";
import { citePage } from "./pages/cite";
import { DOWNLOADS, dataPage } from "./pages/data";
import { employerPage } from "./pages/employer";
import { feedsPage } from "./pages/feeds";
import { directoryPage } from "./pages/directory";
import { correctionsForm, correctionsSubmit, respondPage, respondSubmit } from "./pages/forms";
import { homePage } from "./pages/home";
import { internationalPage } from "./pages/international";
import { mapPage } from "./pages/map";
import { methodologyPage } from "./pages/methodology";
import { noticesPage } from "./pages/notices";
import { rankingsPage } from "./pages/rankings";
import { releasePage, releasesIndexPage } from "./pages/releases";
import { occupationPage, occupationsIndex } from "./pages/occupations";
import { placePage, placesIndex, provincePage } from "./pages/places";
import { programPage } from "./pages/program";
import { searchPage } from "./pages/search";
import { supportPage } from "./pages/support";
import { trendsPage } from "./pages/trends";
import { watchlistPage } from "./pages/watchlist";
import { llmsTxt, robotsTxt, sitemapFile } from "./seo";

const app = new Hono<AppEnv>();

// The page loads nothing from third parties except the map library, the map
// tiles and the Web Analytics beacon (layout.tsx), and the policy says
// exactly that. The library is allowed by its folder on the CDN and the
// beacon by its own file, not the whole host, so no other script hosted
// there can run on the site. The beacon reports to cloudflareinsights.com.
const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", LEAFLET, WEB_ANALYTICS_SRC],
      styleSrc: ["'self'", "'unsafe-inline'", LEAFLET],
      imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org", "https://tile.openstreetmap.org", LEAFLET],
      connectSrc: ["'self'", WEB_ANALYTICS_REPORT],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
    xFrameOptions: "DENY",
    crossOriginResourcePolicy: false,
  }),
);

app.use("*", async (c, next) => {
  const q = c.req.query("lang");
  const lang = langFrom(q, getCookie(c, "lang"));
  if (q === "fr" || q === "en") {
    setCookie(c, "lang", lang, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "Lax" });
  }
  c.set("lang", lang);
  await next();
});

// After the language middleware so a 429 page still knows its language later.
app.use("*", throttle);
app.use("*", measure);
// Inside measure, so a refused automated browser is counted (limits.ts).
app.use("*", refuseAutomatedBrowser);
// Inside measure, so a page answered 304 is counted with that status.
app.use("*", conditional);

app.route("/api", api);

app.get("/", homePage);
app.get("/search", searchPage);
app.get("/map", mapPage);
app.get("/methodology", methodologyPage);
app.get("/data", dataPage);
app.get("/support", supportPage);
app.get("/cite", citePage);
// Feeds are static files under /data/feeds/; this page lists them. The
// watchlist lives in the visitor's browser; this page is its shell.
app.get("/feeds", feedsPage);
app.get("/watchlist", watchlistPage);
// Quarterly release pages and rankings: each page reads one small JSON file.
app.get("/releases", releasesIndexPage);
app.get("/releases/:slug", releasePage);
app.get("/rankings", rankingsPage);
app.get("/rankings/:year", rankingsPage);
// The whole series at once: one small JSON file per view, charts drawn here.
app.get("/trends", trendsPage);
app.get("/trends/:view", trendsPage);
// What the program's own pages state is in force: one small JSON file.
app.get("/program", programPage);
// Postings open to international candidates and the designated-employer lists: one small JSON file.
app.get("/international", internationalPage);
// IRCC and ESDC news items that name the programs, as the departments published them: one small JSON file.
app.get("/notices", noticesPage);
app.get("/occupations", occupationsIndex);
app.get("/occupations/:noc", occupationPage);
app.get("/places", placesIndex);
app.get("/places/:prov", provincePage);
// Every employer A to Z by province, 200 to a page; registered before the
// city route, which would read "employers" as a city's slug.
app.get("/places/:prov/employers", directoryPage);
app.get("/places/:prov/employers/:page", directoryPage);
app.get("/places/:prov/:slug", placePage);
app.get("/employers/:id", employerPage);
// A browser only: a plain HTTP client gets a 403 naming the profile (forms.tsx).
app.get("/employers/:id/respond", respondPage);
app.post("/employers/:id/respond", respondSubmit);
app.get("/corrections", (c) => correctionsForm(c));
app.post("/corrections", correctionsSubmit);
// Payment notices from the donation page; see hooks.ts for what is kept.
app.post("/hooks/kofi", kofiWebhook);
app.get("/robots.txt", robotsTxt);
app.get("/llms.txt", llmsTxt);
app.get("/:file{sitemap(?:-[0-9]+)?\\.xml}", sitemapFile);

// The Atom feeds (feeds.py) are static files, but wrangler.jsonc runs the
// Worker first for /data/feeds/* so the measure middleware counts each poll
// and the subscriber count a reader states (views.ts). The file comes from
// the assets binding as it would have been served, the reader's conditional
// headers included so a reader that has the file still gets a 304, with a
// short cache added. A path with no file gets the site's 404 page, as it did
// when such a request fell through to the Worker.
const FEED_CACHE = "public, max-age=300";
app.get("/data/feeds/*", async (c) => {
  if (!c.env.ASSETS) return c.notFound();
  let res: Response;
  try {
    res = await c.env.ASSETS.fetch(c.req.raw);
  } catch (e) {
    console.error(`feed ${c.req.path}: ${String(e).slice(0, 200)}`);
    c.header("Retry-After", "300");
    c.header("Cache-Control", "no-store");
    return c.body(null, 503);
  }
  if (res.status === 404) return c.notFound();
  // The binding's headers cannot be changed in place, and the middleware
  // above adds its own after this returns.
  const headers = new Headers(res.headers);
  if (res.status === 200 || res.status === 304) headers.set("Cache-Control", FEED_CACHE);
  return new Response(res.body, { status: res.status, headers });
});

app.get("/downloads/:file{.+}", async (c) => {
  const file = c.req.param("file");
  const allowed = DOWNLOADS.some((d) => d.file === file) || /^mirror\/[A-Za-z0-9._-]+$/.test(file);
  let object: R2ObjectBody | null = null;
  let unavailable = false;
  if (allowed && c.env.DATA) {
    try {
      object = await c.env.DATA.get(file.startsWith("mirror/") ? file : `downloads/${file}`);
    } catch (e) {
      // Storage outage: the same page as a missing file, with a status that says try later.
      console.error(`download ${file}: ${String(e).slice(0, 200)}`);
      unavailable = true;
    }
  }
  if (!object) {
    const stats = await loadStats(c.env);
    const lang = c.get("lang");
    return page(
      c,
      <Layout lang={lang} title={t(lang, "error.file")} dataAsOf={stats?.data_as_of ?? null}>
        <h1>{t(lang, "error.file")}</h1>
        <p>{tj(lang, "error.file_text", { file: <span class="mono">{file}</span> })}</p>
        <p>
          <a href="/data">{t(lang, "error.file_back")}</a>
        </p>
      </Layout>,
      unavailable ? 503 : 404,
    );
  }
  const headers = new Headers();
  headers.set("Content-Type", file.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${file.split("/").pop()}"`);
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(object.body, { headers });
});

app.notFound(async (c) => {
  // Sub-app not-found handlers are not consulted, so the API's JSON 404 lives here.
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: "not found" }, 404);
  }
  const stats = await loadStats(c.env).catch(() => null);
  const lang = c.get("lang") ?? "en";
  return page(
    c,
    <Layout lang={lang} title={t(lang, "error.not_found")} dataAsOf={stats?.data_as_of ?? null}>
      <h1>{t(lang, "error.not_found")}</h1>
      <p>
        {tj(lang, "error.not_found_text", {
          home: <a href="/">{t(lang, "error.not_found_home")}</a>,
          search: <a href="/search">{t(lang, "error.not_found_search")}</a>,
        })}
      </p>
    </Layout>,
    404,
  );
});

app.onError((err, c) => {
  console.error(err);
  c.header("Cache-Control", "no-store");
  const lang = c.get("lang") ?? "en";
  return c.html(
    html`<!doctype html>${(
      <Layout lang={lang} title={t(lang, "error.server")} dataAsOf={null}>
        <h1>{t(lang, "error.server")}</h1>
        <p>{t(lang, "error.server_text")}</p>
      </Layout>
    ) as any}`,
    500,
  );
});

export { app };

export default {
  fetch: app.fetch,
  // The cron trigger from wrangler.jsonc: the daily check.
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runWatchdog(env));
  },
};
