# Traffic limits

The Worker runs on the Workers Paid plan (the hosted search needs it), so
there is no daily request cap and a flood cannot take the pages down. What a
flood can do is cost money: requests beyond the ten million a month the plan
includes are billed at 30 cents per million, and CPU time beyond the included
allowance by the millisecond. The zone itself stays on the Free website plan,
which is what the dashboard limits below refer to.

Three layers keep abusive traffic off the Worker, and a fourth is for
emergencies. The edge rules decide who gets a page at all, before the Worker
runs. The rate-limiting rule holds a single address to at most 345,600
requests a day past the edge, and the caps inside the Worker hold it well
under that. Static files under `/data/` and `/fonts/` are served before the
Worker runs, so they do not count against it. The Atom feeds under
`/data/feeds/` are the exception: the Worker runs first for them so their
polls are counted (`docs/search-engines.md`, section 6), and they have a cap
of their own inside the Worker (below), wide enough for a feed service that
polls many feeds from one address.

CPU time is the other cost: the page cache, Smart Placement and the
start-up work that keep it down, and how to read it in Cloudflare's
analytics, are in `docs/performance.md`.

## 1. Edge rules (WAF custom rules)

Four WAF custom rules on the zone decide, before the Worker runs, which
requests get a page. A request they turn away costs the site nothing.

### Baseline (2026-11-17 to 11-23)

In the week of 2026-11-17 to 11-23 the zone answered about 1.09 million
requests from real clients. About 460,000 came from crawlers Cloudflare
verified:

| Verified crawler | Requests |
|---|---|
| meta-webindexer | 264,000 |
| Amzn-SearchBot | 60,000 |
| OAI-SearchBot | 28,000 |
| Claude-SearchBot | 28,000 |
| Bingbot | 26,000 |

About 614,000 came from clients Cloudflare could not verify, 407,000 of them
for pages:

| Unverified client | Requests |
|---|---|
| A fleet with Mac Chrome agent strings | about 250,000 |
| SERankingBacklinksBot (an SEO backlink crawler) | 76,000 |
| Lightpanda (a headless browser) | 68,000 |
| ElevenlabsCrawler | 47,000 |
| TokenFoundryBot | 11,000 |

ElevenLabs documents ElevenlabsCrawler as collecting pages to train
generative models. The stylesheet was fetched about 2,600 times that week,
which is the measure of page loads by people, so about 99 percent of the page
requests Cloudflare could not verify came from scrapers. Everything they take
is in the bulk files under `/downloads/`, which stay open to any client.

### The four rules, in the order they run

The first rule that matches a request decides it. A skip lets the request
past the rules after it.

1. `check_key` (skip) matches a request carrying the header
   `x-lmiawatch-check` with the project's check key. The nightly's smoke test
   and checks and the site-only deploy's checks send it, so they read the
   live site the way a person does. Without it they would be challenged like
   any script.
2. `refused` (block). Two groups get Cloudflare's 403. First, the
   crawlers the site refuses by name, verified or not: the robots.txt group
   for AI training and large-scale scraping, on every path but
   `/robots.txt`, which they must be able to read. Second, scripting tools
   and self-declared headless browsers (curl, python-requests, Lightpanda,
   Playwright and the like, and an empty user agent) when Cloudflare has not
   verified the sender, on every path but the open paths.
3. `welcome` (skip) lets three kinds of request past the last rule:
   - crawlers Cloudflare has verified in a category the site wants (search
     engines, AI search, AI assistants, page previews, archivers, feed
     fetchers, monitoring, accessibility, security, academic research,
     webhooks);
   - the open paths: `/downloads/`, the feeds under `/data/feeds/`,
     `/fonts/`, the payment webhook under `/hooks/`, `/.well-known/`,
     `/cdn-cgi/`, and any file ending in `.txt`, `.xml`, `.css`, `.js`,
     `.webmanifest` or an image or font extension, which covers
     `robots.txt`, `llms.txt`, the IndexNow key file and the sitemaps;
   - link-preview fetchers Cloudflare has not verified, for `GET` and `HEAD`
     only. A preview of a shared link is fetched from the sharer's own phone
     or server (WhatsApp, iMessage, Mastodon), which Cloudflare cannot
     verify. The Worker answers these with the page's head only (title,
     description, card image), so the name is worth nothing to a scraper.
4. `challenge` (managed challenge) takes everyone else. A browser passes
   Cloudflare's check, usually without a click. A script, or a crawler
   nobody vouches for, does not get the page.

The data files the pages load (`/data/stats.json`, the search files, the
profile shards) and `/api/` are not open paths. A browser that passed the
check reads them with its pass; a script uses the bulk files. The Worker's
own Cache API requests (host `pages.lmiawatch.invalid`, the page cache in
`site/src/pagecache.ts`) are never refused or challenged.

### Where they are kept, and how they change

The rules are code. `pipeline/scripts/edge_rules.py` builds them from the
lists in `site/src/edge_agents.json` and applies them through Cloudflare's
API. It needs a token with Zone WAF Edit on the zone. The nightly's token has
no such permission and never changes the rules. From the repository root,
with the token and the check key each in a file of its own (first line), kept
outside the repository:

```
python pipeline/scripts/edge_rules.py --token-file <token file> --key-file <key file> --dry-run
python pipeline/scripts/edge_rules.py --token-file <token file> --key-file <key file> --check
python pipeline/scripts/edge_rules.py --token-file <token file> --key-file <key file> --apply
```

- `--dry-run` prints the four rules with the key redacted and the length of
  each expression. It needs no token.
- `--check` compares the rules on the zone with the ones the script builds
  and exits 1 when they differ, naming the rule and the field (the action,
  the expression), never the expression's text.
- `--apply` replaces every custom rule on the zone with these four and then
  checks the result. A rule added by hand in the dashboard is removed by the
  next `--apply`, so a new rule goes into the script.
- `--without-challenge` leaves rule 4 out (the first stage of the rollout,
  the refusals without the challenge).

The token and the key may also come from the environment
(`CLOUDFLARE_WAF_TOKEN`, `EDGE_CHECK_KEY`). The script never prints either.
In the dashboard the rules are under Security, WAF, Custom rules; Cloudflare
allows 4,096 characters per expression, and the script refuses a longer one.

### The lists

`site/src/edge_agents.json` holds four lists. The Worker reads the same file.

| List | Holds | Used by |
|---|---|---|
| `refused` | crawlers refused by name, the same as robots.txt's last group | rule 2 |
| `tools` | scripting tools and headless browsers, refused when unverified | rule 2 |
| `preview` | link-preview fetchers, let through unverified and answered with the head only | rule 3 and the Worker |
| `verified_categories` | Cloudflare's verified bot categories the site welcomes, spelled as Cloudflare spells them | rule 3 |

Names in the first three lists are lower case, with no quotes or
backslashes, and match anywhere in the lower-cased user agent (`curl/`
matches every curl version). To add or remove a name:

1. Edit the list. For `refused`, edit the last group of
   `site/public/robots.txt` the same way: a test
   (`pipeline/tests/test_edge_rules.py`) holds the two equal, apart from
   Google-Extended and Applebot-Extended, which only robots.txt names.
2. Run the pipeline tests, then `--dry-run` to see every expression fits.
3. `--apply`, which checks the zone afterwards.
4. Commit. The Worker's copy of the lists goes live with the next deploy.

### The check key

The check key is 64 lower-case hex characters (32 random bytes). It lives in
two places: the repository secret `EDGE_CHECK_KEY` and the zone's first rule.
It is never in the repository, a log, the run status, `LAST_RUN.md` or an
artifact. The workflows give it only to the steps that read the live site
(the smoke test and the nightly checks; the site-only deploy's bundle checks
and smoke test), and the pipeline sends it only over HTTPS to the site's own
host (or `www.` of it). Redirects are followed one hop at a time, so the key
never goes on to another host. A key that is not 64 lower-case hex
characters is never sent.

To rotate it:

1. Make a new key in a file outside the repository:
   `python -c "import secrets; print(secrets.token_hex(32))" > edge-key.txt`.
2. Set the repository secret `EDGE_CHECK_KEY` to it (Settings, Secrets and
   variables, Actions).
3. Apply the rules with the same key:
   `python pipeline/scripts/edge_rules.py --token-file <token file> --key-file edge-key.txt --apply`.
4. Delete the file.

Between steps 2 and 3 the secret and the rule differ. A run in that window
is refused at the edge, and its edge check reports it ("The edge refused the
run's check key", `docs/alerts.md`).

### What a reader sees

On the first page, Cloudflare's check: usually a moment's wait without a
click, sometimes a box to tick. A browser that passes gets a cookie named
`cf_clearance` and is not checked again while it lasts. Challenge Passage
(Security, Settings in the dashboard) sets how long that is. The default is
30 minutes; a longer value such as a week means returning readers are not
checked again. The site reads nothing from the cookie, and its privacy notes
name it.

### When a crawler the site wants is refused

An unverified client gets the browser check whatever robots.txt says. An AI
search crawler named in robots.txt's AI search group must also be one
Cloudflare has verified, or it is challenged like any script. To let a
crawler through:

- Find it in the dashboard's traffic view, filtered on its user agent, which
  shows whether Cloudflare verified it and in which category. The security
  events show which rule acted on its requests.
- Verified in a category the site does not list: add the category to
  `verified_categories`, spelled as the dashboard shows it, and `--apply`.
- Refused by name: take the name off `refused` or `tools`.
- A link-preview fetcher that runs on people's devices: add its name to
  `preview`.
- Unverified and wanted as a crawler: its operator can apply to Cloudflare's
  verified bots program. Until then it gets the challenge.

### Checking from outside

With curl, from any machine (`$KEY` holding the check key):

```
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
curl -s -o /dev/null -D - -A "$UA" https://lmiawatch.ca/ | grep -i -E "^HTTP|^cf-mitigated"
curl -s -o /dev/null -w "%{http_code}\n" -A "$UA" -H "x-lmiawatch-check: $KEY" https://lmiawatch.ca/
for p in /downloads/employers.csv /llms.txt /data/feeds/canada/pending.xml /robots.txt; do
  curl -s -I -o /dev/null -w "%{http_code} $p\n" "https://lmiawatch.ca$p"
done
curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" https://lmiawatch.ca/
```

Expected, in order: a 403 with `cf-mitigated: challenge` (a browser without
the key); 200 (the same with the key); 200 for each open path with plain
curl (a `HEAD` request, so the CSV is not downloaded); 403 for a refused
name. Plain curl on a page gets 403 from rule 2. The nightly run makes the
first two requests itself every night (the edge check, `docs/alerts.md`).

## 2. Edge rate-limiting rule (dashboard, once)

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

## 3. Caps inside the Worker

`site/src/limits.ts`, keyed on the address Cloudflare saw, per minute:

| Bucket | Paths | Limit |
|---|---|---|
| Pages | everything else | 120 |
| Feeds | `/data/feeds/*` | 600 |
| API | `/api/*` | 60 |
| Downloads | `/downloads/*` | 10 |
| Forms | `POST /corrections`, `POST /employers/<id>/respond` | 5 |

Above the cap the site answers 429 with `Retry-After: 60`. These run inside
the Worker, so every request they refuse is still billed. They protect the
database and the downloads from a single address that got past the edge.

The edge blocks the Lightpanda headless browser on pages (rule 2, the `tools`
list) before the Worker runs. The Worker's own refusal stays behind it, for
a request that reaches the Worker anyway: a user agent starting
`Lightpanda/` gets a 403 in plain text pointing at `/downloads/` and
`/llms.txt` on every path except the downloads, `/llms.txt`, `/robots.txt`,
the sitemaps and the feeds (`refuseAutomatedBrowser` in `site/src/limits.ts`,
counted as a bot response with status 403). One operator fetched about 32,000
pages a day with it through proxy address ranges, ignoring robots.txt, and a
refusal costs under a millisecond of CPU against about seven for a rendered
page. The agent string is a launch flag, so the name alone only slows that
operator down; the challenge in rule 4 is what stops a renamed copy.

### Search engines

Googlebot and Bingbot index the site for people's searches, and the site
wants every page they will take, at any pace. Google reads no `Crawl-delay`
and slows its crawl of a whole host when it meets 429s; Bing's group in
`robots.txt` carries no delay. So a request that Cloudflare's edge has
verified as a search engine's crawler (`request.cf.verifiedBotCategory` is
"Search Engine Crawler"), and whose user agent names Googlebot, Bingbot or
Google's inspection tool, is never counted against the pages cap
(`searchEngine` in `site/src/limits.ts`). Both tests are needed: anyone can
write the name, and the edge gives the same category to some crawlers of AI
indexes (ExaSearchBot, OAI-SearchBot and KeenableBot on 2026-11-14), which
keep the budget below. The API, download and form caps hold for everyone.
At the edge, rule 3 lets verified search engines past the challenge, and the
rate-limiting rule (section 2) leaves them alone (`not cf.client.bot`).

### AI crawlers

A crawler that builds an AI search index asks from hundreds of addresses, so
the caps above never see it, and Cloudflare verifies most of them, so the
rate-limiting rule leaves them alone as it leaves Googlebot, and rule 3 lets
them past the challenge. In the first two weeks of November 2026
Claude-SearchBot, Applebot, Amzn-SearchBot and meta-webindexer asked for more
than 600,000 pages between them, a quarter of the site's requests.

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
(`site/test/limits.test.ts`). A crawler in that group that Cloudflare has not
verified gets the browser check at the edge whatever the file allows it
(section 1, "When a crawler the site wants is refused").

A 429 still runs the Worker, so the budget bounds the work and tells a
crawler to slow. A crawler that heeds neither the file nor the answer is
stopped at the edge: its name goes on the `refused` list and in robots.txt's
last group (section 1), and rule 2 blocks it before the Worker runs. AI
Crawl Control in the dashboard can also allow or block a crawler by name on
every plan.

## 4. Emergency switch

Security, Settings, Under Attack Mode challenges every visitor at the edge
for the time it is on, the open paths included. The edge rules already
challenge every page request they cannot vouch for, so this is for a flood
they let through (from browsers that pass the check, or on the open paths).
Turn it on during a flood, off afterwards; while it is on, the nightly's
checks of the live site may be challenged too, and the smoke test then reads
`unverifiable`, which never rolls a deploy back. Bot Fight Mode is left off:
on the Free plan no rule can exempt a path or the check key from it, so it
would also stop scripted use of the downloads and the feeds, and the run's
own checks.
