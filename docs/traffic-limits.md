# Traffic limits

The Worker runs on the Workers Paid plan (the hosted search needs it), so
there is no daily request cap and a flood cannot take the pages down. What a
flood can do is cost money: requests beyond the ten million a month the plan
includes are billed at 30 cents per million, and CPU time beyond the included
allowance by the millisecond. The zone itself stays on the Free website plan,
which is what the dashboard limits below refer to. The three layers keep that
cost bounded: a single address can send at most 345,600 requests a day past
the edge rule, and the caps inside the Worker hold it well under that.
Static files under `/data/` and `/fonts/` are served before the Worker runs,
so they do not count. The Atom feeds under `/data/feeds/` are
the exception: the Worker runs first for them so their polls are counted
(`docs/search-engines.md`, section 6), and they have a cap of their own
inside the Worker (below), wide enough for a feed service that polls many
feeds from one address.

Three layers keep abusive traffic off the Worker.

## 1. Edge rate-limiting rule (dashboard, once)

The Free plan includes one rate-limiting rule, enforced before the Worker
runs, so blocked requests cost nothing. The API token used by the project
cannot create it, so it is set in the dashboard:

1. Cloudflare dashboard, the lmiawatch.ca zone, Security, WAF, Rate limiting
   rules, Create rule.
2. Name: `Per-address cap on Worker paths`.
3. When incoming requests match, use the expression editor and paste:

   ```
   (http.host in {"lmiawatch.ca" "www.lmiawatch.ca"} and not starts_with(http.request.uri.path, "/data/") and not starts_with(http.request.uri.path, "/fonts/") and not cf.client.bot)
   ```

   `cf.client.bot` is true for a crawler Cloudflare has verified (Googlebot,
   Bingbot and the other search engines). Without that clause the cap counts
   them like anyone else, and a crawler rendering pages fetches the stylesheet
   and scripts with each page, so a burst from one of its addresses answers
   429 and the search engine slows its crawl (seen 2026-10-25 as Googlebot
   requests blocked at the edge).

4. Characteristics: IP (the Free plan adds the data centre itself).
5. Requests: 40 per 10 seconds. Action: Block. Duration: 10 seconds (the only
   choice on the Free plan).
6. Deploy.

A page view fetches about ten files, so a reader never reaches 40 Worker
requests in 10 seconds. A script fetching four pages a second is blocked;
a verified crawler is not.

## 2. Caps inside the Worker

`site/src/limits.ts`, keyed on the address Cloudflare saw, per minute:

| Bucket | Paths | Limit |
|---|---|---|
| Pages | everything else | 120 |
| Feeds | `/data/feeds/*` | 600 |
| API | `/api/*` | 60 |
| Downloads | `/downloads/*` | 10 |
| Forms | `POST /corrections`, `POST /employers/<id>/respond` | 5 |

Above the cap the site answers 429 with `Retry-After: 60`. These run inside
the Worker, so they count toward the daily total; their job is to protect the
database and the downloads from a single address, not to replace the edge
rule.

The Lightpanda headless browser (a user agent starting `Lightpanda/`) gets a
403 in plain text pointing at `/downloads/` and `/llms.txt` on every path
except the downloads, `/llms.txt`, `/robots.txt`, the sitemaps and the feeds
(`refuseAutomatedBrowser` in `site/src/limits.ts`, counted as a bot response
with status 403). One operator fetched about 32,000 pages a day with it
through proxy address ranges, ignoring robots.txt, and a refusal costs under
a millisecond of CPU against about seven for a rendered page. The agent
string is a launch flag, so this only slows that operator down.

### AI crawlers

A crawler that builds an AI search index asks from hundreds of addresses, so
the caps above never see it, and Cloudflare verifies most of them, so the
edge rule leaves them alone as it leaves Googlebot. In the first two weeks of
November 2026 Claude-SearchBot, Applebot, Amzn-SearchBot and meta-webindexer
asked for more than 600,000 pages between them, a quarter of the site's
requests.

They have a budget of their own (`AI_CRAWLERS` and `crawlerOf` in
`site/src/limits.ts`, the `CRAWLER_LIMIT` binding): ten requests a minute
for each crawler, counted by the crawler's name across all its addresses, at
each Cloudflare location. Past it the site answers 429 with
`Retry-After: 60` before anything is read for the request. The downloads,
`/llms.txt`, `/robots.txt`, the sitemaps and the feeds are never refused.
The search engines' own crawlers (Googlebot, Bingbot, Yandex) and an
assistant fetching one page for a person who asked (ChatGPT-User,
Claude-User, Perplexity-User) are not on the list.

`robots.txt` asks the same crawlers for ten seconds between requests in a
group of their own (`Crawl-delay: 10`). From each crawler's own
documentation: Anthropic's crawlers keep to the delay; Apple's "does not
follow crawl-delay" and "adjusts automatically when a site slows down or
returns errors", which the 429 is for; the others say nothing of it. A test
holds the Worker's list to the crawlers the file names
(`site/test/limits.test.ts`).

A 429 still runs the Worker, so the budget bounds the work and tells a
crawler to slow. A crawler that heeds neither the file nor the answer is
stopped only at the edge: in the dashboard, AI Crawl Control allows or
blocks a crawler by name on every plan, and a WAF custom rule can block a
user agent outright, before the Worker runs.

## 3. Emergency switch

Security, Settings, Under Attack Mode challenges every visitor at the edge
for the time it is on. Turn it on during a flood, off afterwards. Bot Fight
Mode is left off: it would also block legitimate scripted use of the API and
the downloads.
