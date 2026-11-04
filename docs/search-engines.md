# Search engines and traffic counts

Three things tell the operator how people find and use the site, and none of
them adds a cookie or a script to the pages:

1. Google Search Console and Bing Webmaster Tools: which searches show the
   site, how often people click, and which pages the engines have indexed.
   Each needs one DNS record to prove the domain is ours.
2. IndexNow, which tells the engines that take it (Bing and others, not
   Google) which pages changed. The nightly run submits them itself after
   each deploy (section 5); Cloudflare's Crawler Hints can stay on beside it.
3. The Worker's own counts in Workers Analytics Engine (`site/src/views.ts`):
   one data point per response, holding the route template, the page
   language, the country code Cloudflare's edge attaches, the referring
   site's host name, the status code, whether the request came from a bot
   or a person, and for a person the device class and a daily visitor code
   (a hash that changes every UTC day), plus, for an Atom feed, the file and
   the subscriber count a feed reader states. No IP address, user agent,
   cookie, full referrer or raw path is written. The Data page says so in
   both languages. The nightly run keeps a daily roll-up, Search Console's
   daily figures and a monthly report in R2 (section 6).

The pages do load one measuring script, Cloudflare Web Analytics, placed in
the page template with the site's public token (section 7, *ETag and 304*).
Cloudflare states that it sets no cookie, stores nothing in the browser and
does not fingerprint visitors. The Data page says so in both languages.

Before any of that, two fixes in the zone, both missing on 2026-10-18: plain
HTTP is served without a redirect, and `www.lmiawatch.ca` serves a full copy
of the site instead of redirecting to `lmiawatch.ca`. Search engines treat
the copies as duplicates, and the canonical tags (which always name
`https://lmiawatch.ca`) only partly make up for it.

Everything below is done in the Cloudflare dashboard, signed in as the
project's Cloudflare account, or in accounts made for the project. The
workflow's API token cannot edit DNS or zone settings, by design, so none of
this can be scripted from the repository.

## 1. Always Use HTTPS

1. Cloudflare dashboard, the `lmiawatch.ca` zone, SSL/TLS, Edge
   Certificates.
2. Turn on Always Use HTTPS. Every `http://` request now gets a 301 to the
   same `https://` address at the edge, before the Worker runs, so the
   redirect costs no Worker request.
3. Leave HSTS off for now. Once the redirect has run for a few weeks without
   trouble, HSTS can be turned on from the same page; it is hard to undo,
   because browsers remember it for its full max-age.

Check: `curl -sI http://lmiawatch.ca/` from a terminal answers `301` with
`Location: https://lmiawatch.ca/`.

## 2. Redirect www to the apex

`www.lmiawatch.ca` is a Worker custom domain (`site/wrangler.jsonc`), so it
has a DNS record and a certificate. Keep both, and send its traffic to the
apex with a redirect rule, which runs at the edge before the Worker.

1. The `lmiawatch.ca` zone, Rules, Overview, Create rule, Redirect Rule. The
   template "Redirect from WWW to root" fills in most of it.
2. Rule name: `www to apex`.
3. When incoming requests match: custom filter expression, field Hostname,
   operator equals, value `www.lmiawatch.ca`.
4. Then: URL redirect, type Dynamic, expression
   `concat("https://lmiawatch.ca", http.request.uri.path)`, status code 301,
   Preserve query string on.
5. Deploy. The Free plan allows ten redirect rules; this uses one.

Check: `curl -sI "https://www.lmiawatch.ca/search?lang=fr"` answers `301`
with `Location: https://lmiawatch.ca/search?lang=fr`.

## 3. Google Search Console

Google needs a Google account. Make one for the project, in the project's
browser profile, never signed in alongside a personal Google account. At the
sign-up page choose "Use your existing email" and give the project's
plus-alias address, so no Gmail mailbox is created. Google may ask for a
phone number. The account name can be `LMIA Watch`; it is not shown on the
site or in search results.

1. Open `search.google.com/search-console`, Add property, choose Domain (not
   URL prefix), enter `lmiawatch.ca`. A domain property covers `http`,
   `https` and `www` at once.
2. Google shows a TXT record that starts `google-site-verification=`. Copy
   the whole value.
3. If Google offers to configure the record for you through Cloudflare,
   decline: that sign-in would grant Google access to the Cloudflare
   account. Add it by hand instead.
4. Cloudflare dashboard, the zone, DNS, Records, Add record: type TXT, name
   `@`, content the copied value, TTL Auto. Save.
5. Back in Search Console, Verify. DNS changes on Cloudflare usually show
   within minutes; if the check fails, wait an hour and try again.
6. Leave the TXT record in place for good. Removing it unverifies the
   property.
7. Sitemaps, in the left menu: enter `sitemap.xml` and Submit. The file is
   the index of the per-part sitemaps the nightly run writes;
   `robots.txt` names it too.

Search Console keeps 16 months of search data. The Worker's own counts last
three months in Analytics Engine and are kept after that by the nightly
roll-up (section 6).

## 4. Bing Webmaster Tools

Bing's index also serves DuckDuckGo, Ecosia and Yahoo.

1. Open `bing.com/webmasters` and sign in with the project's Google account
   from step 3 (Bing accepts Google, Microsoft and Facebook sign-ins), so no
   further account is needed.
2. Once the Google property is verified, choose Import from Google Search
   Console. Bing reads the verified property and its sitemap and needs no
   DNS record of its own. This is the quickest path.
3. Without the import: Add a site, `https://lmiawatch.ca/`, and choose the
   DNS method. Bing shows a CNAME record (a name made of letters and digits,
   pointing to `verify.bing.com`). Add it in the Cloudflare zone with proxy
   status DNS only (the grey cloud): a proxied record answers with
   Cloudflare's addresses and the check fails. Verify, then leave the record
   in place.
4. Sitemaps: Submit sitemap, `https://lmiawatch.ca/sitemap.xml`.

## 5. IndexNow

Bing reads the sitemap, but with about 160,000 employer pages its crawl takes
weeks to come back to a page that changed. IndexNow lets the site name the
changed pages itself, and Bing and the other engines that share the protocol
take that as a cue to crawl them. Google does not take IndexNow and is
unaffected.

### What the nightly run sends

After a deploy that worked and that the smoke test did not find broken, the
workflow step "Tell IndexNow which pages changed" runs

```
python -m lmia_pipeline.nightly indexnow --db data/lmia.sqlite --since <run start> \
  --site-url https://lmiawatch.ca
```

(`pipeline/lmia_pipeline/indexnow.py`). It selects:

- the home, search, trends, occupations, places, releases and program pages,
  which follow the nightly data;
- every employer page whose row changed during the run. `--since` is the
  time in `data/out/run_started.txt`, written as the pipeline step starts.
  The status stage rewrites `employers.updated_at` only when something in an
  employer's summary changed, and a new employer row carries the time it was
  first written.

At most 20,000 URLs a night, the most recently changed first. A night with
more (a new ESDC quarter changes tens of thousands of profiles) leaves the
rest to the sitemap, which lists every profile with its `lastmod`. The list
goes to the shared endpoint, which passes it to every participating engine,
in batches of at most 10,000 URLs:

```
POST https://api.indexnow.org/indexnow
Content-Type: application/json; charset=utf-8
User-Agent: LMIAWatch/<version> (+https://lmiawatch.ca; https://lmiawatch.ca/corrections)

{"host": "lmiawatch.ca", "key": "<key>", "keyLocation": "https://lmiawatch.ca/<key>.txt",
 "urlList": ["https://lmiawatch.ca/", "https://lmiawatch.ca/search", ...]}
```

The step's log gives the counts. On the runner the list sent is in
`data/out/indexnow/urls.txt`, and `--dry-run` writes that list without
sending anything.

### The key

The key is the 32-character text in `INDEXNOW_KEY`
(`pipeline/lmia_pipeline/indexnow.py`). The site serves it at
`https://lmiawatch.ca/<key>.txt` from `site/public/<key>.txt`, a file whose
entire content is the key, with no newline. An engine fetches that file to
check that a submission comes from the site. The key is public by design, so
there is no secret to set, and a pipeline test fails when the code and the
file disagree.

To change the key: 32 new lowercase hex characters, the file renamed and its
content replaced, and `INDEXNOW_KEY` changed, all in one commit. The new key
is in use from the next nightly run, whose deploy publishes the new file.

### Outcomes

The outcome goes to the run status as `indexnow` and to `LAST_RUN.md` as
"IndexNow: <outcome>".

| Outcome | Meaning |
|---|---|
| `submitted <n> URLs` | every batch answered 200 (submitted) or 202 (received, the key check still pending) |
| `not verified (403)`, `not verified (422)` | the endpoint refused the key while the site serves the key file correctly (the run fetches it to check). Seen on the first night of a new key, before the endpoint had fetched and verified it; the same request was accepted a few hours later. Nothing to fix; the next night tries again |
| `rejected (400)`, `rejected (403)`, `rejected (422)` | 400: the request was malformed. 403 or 422 with a key file that does not answer 200 with the key as its content: the file is missing or wrong. Nothing more is sent that night, and the step exits 1 so it shows red |
| `rate limited` | 429, too many requests. Nothing more is sent that night |
| `failed` | no answer, or a 500 to 599, on the first try and on the retry 10 seconds later; or the step could not run (no start time, no database) |
| `off` | the repository variable `INDEXNOW_ENABLED` is `false` |
| `not run` | the step did not run: the deploy failed or the smoke test found it broken |

Only a rejection is an item needing attention ("IndexNow: rejected; check
the key file"). A rate limit or a failure clears by itself, and the pages
stay in the sitemap meanwhile. No outcome stops the run. Pages a night did
not get through are not queued for the next; the sitemap carries them.

### When it reads rejected

The engines could not match the request with the key file, so the key file
is the first thing to check:

1. Open `https://lmiawatch.ca/<key>.txt`, with the key from `INDEXNOW_KEY`.
   It must answer 200 with the key as its entire content.
2. A 404: the file is missing from `site/public` or the last deploy did not
   carry it. Check that it is committed and that the deploy step succeeded.
3. A 403 or a challenge page: a rule in the zone refuses the request. The
   file must be open to crawlers like any page.
4. Another text: the file and `INDEXNOW_KEY` disagree. The pipeline test
   catches this before a push; fix whichever one changed.
5. A 422 with a good key file: the URLs name a host other than the one
   serving the file, usually the repository variable `SITE_URL` (the step
   falls back to `https://lmiawatch.ca` only when the variable is empty).

The next nightly run submits again once the cause is fixed.

### Turning it off

GitHub, the repository, Settings, Secrets and variables, Actions, Variables:
set `INDEXNOW_ENABLED` to `false`. Any other value, or no variable, leaves it
on. While it is off the step writes `off` and sends nothing.

### Cloudflare's Crawler Hints (optional)

1. The zone, Caching, Configuration, Crawler Hints: On.
2. Cloudflare then sends IndexNow notices of its own when content it serves
   changes, handling its side of the protocol itself. It costs nothing.

The operator can leave it on beside the nightly submission; neither depends
on the other.

## 6. Reading the counts

The counts are read day to day and kept as a lasting record of the site's
audience. Cloudflare's dashboards show a window and keep nothing, so the
nightly run keeps three files in R2: the daily roll-up of the Worker's own
counts, Search Console's daily figures, and a report per month. Since
2026-10-30 every count separates people from crawlers.

### What one data point holds

| Column | Holds | Example |
|---|---|---|
| `index1` | the route template (the sampling key) | `/employers/:id` |
| `blob1` | the route template | `/employers/:id` |
| `blob2` | the kind: `page`, `api`, `download`, `form`, `feed`, `hook`, `file` or `other` | `page` |
| `blob3` | the page language | `fr` |
| `blob4` | the country code from Cloudflare's edge, empty when absent (`T1` is Tor) | `CA` |
| `blob5` | the referring site's host name, empty when none | `news.google.com` |
| `blob6` | the request method | `GET` |
| `blob7` | feeds only: the feed file, empty when no file was served (empty on every other point) | `feeds/canada/pending.xml` |
| `blob8` | `bot` or `human` (from 2026-10-30) | `human` |
| `blob9` | people only: `desktop`, `mobile` or `tablet`, read from the user agent; empty for a bot | `mobile` |
| `blob10` | people only: the daily visitor code, 16 hex characters; empty for a bot and while `VIEWS_SALT_KEY` is not set | `79b509108f501ba3` |
| `double1` | the status code | `200` |
| `double2` | feeds only: the subscriber count the feed reader stated, 0 when none | `12` |

The positions never move: the roll-up reads older days with the same
columns, and a point written before 2026-10-30 reads back with empty strings
in `blob7` to `blob10`.

A path that matches no route is stored as `other`, never as written, since a
mistyped or pasted address could hold anything. Downloads keep their file
name (the list is fixed). The dataset is `lmia_watch_views`.

**Bot or human** (`site/src/views.ts`, `agentClass`). A request is a bot when
Cloudflare's edge gives it a verified-bot category (`request.cf.verifiedBotCategory`,
any value: search engines, monitors, feed fetchers), when the user agent is
missing or not shaped like a browser's (every browser starts `Mozilla/` or,
for old Opera, `Opera/`), when the user agent holds one of the crawler words
(bot, crawl, spider, slurp, fetch, python-requests, curl, wget, headless,
the site's own `LMIAWatch`, and a few more listed in the code), when a
browser-shaped user agent comes with none of the Fetch Metadata headers
(`Sec-Fetch-Mode`, `Sec-Fetch-Dest`, `Sec-Fetch-Site`) that every current
browser sends, and always for a feed poll or the payment hook. Browsers
older than Chrome 76, Firefox 90 and Safari 16.4 send none of those headers,
so the few still in use count as bots. Everything else is human: a person's
browser, or a crawler that copies a browser's headers as well, which no
header can tell apart. "bot" is not matched inside "Cubot", a phone maker
whose model names appear in ordinary Android user agents.

**Device** (`deviceClass`): tablet for iPad, Kindle, Silk, PlayBook,
"Tablet", or Android without "Mobile"; mobile for "Mobi", iPhone, iPod,
Windows Phone, BlackBerry, Opera Mini, or the client hint
`Sec-CH-UA-Mobile: ?1`; desktop otherwise. iPadOS asks for desktop pages and
says "Macintosh", so most iPads count as desktop.

**The visitor code** (`visitorHash`): SHA-256 of the day's salt, the client
address (`cf-connecting-ip`) and the user agent, separated by newlines, cut
to 16 hex characters. The day's salt is HMAC-SHA-256 of the UTC date
(`YYYY-MM-DD`) under the Worker secret `VIEWS_SALT_KEY`. The address and the
user agent are hashed and dropped; the code changes at midnight UTC; without
the secret no one can compute a code from an address. Whoever holds the
secret could recompute a past day's salt and test a known address against
the codes still in Analytics Engine (three months), so the secret lives only
in the Worker. The roll-up only ever asks for how many distinct codes there
are (`count(DISTINCT blob10)`), so no code reaches R2. The Data page says
all this in both languages.

The Atom feeds are the one static file counted. `site/wrangler.jsonc` runs
the Worker first for `/data/feeds/*` (`run_worker_first`), and the Worker
serves the file from the assets binding with the same headers, a five-minute
cache and the reader's conditional request passed on (a reader that has the
file gets a 304). Every feed poll is one point under the template
`/data/feeds/:file` with kind `feed`. Readers that poll for many people say
how many in their user agent, for example
`Feedly/1.0 (+https://feedly.com/poller.html; 12 subscribers; like FeedFetcher-Google)`
or `inoreader.com; 9 subscribers`. The Worker keeps only that number, in
`double2`; the user agent itself is never written. The file name goes in
`blob7` only when the file was served (200 or 304), so a typed path that
found nothing is never stored. Other static files under `/data/` and
`/fonts/` never reach the Worker and are not counted, and neither is a request
the per-address limits answer with 429. Feed polls have their own cap in the
Worker (`FEED_LIMIT`, 600 a minute per address, `site/src/limits.ts`), so a
feed service polling many feeds from one address is not refused.

Limits: data points written match the Worker's requests; 10,000 read queries
a day; data kept for three months.

### The visitor code's secret

Without `VIEWS_SALT_KEY` the Worker writes an empty code and the roll-up
leaves the visitor columns blank; everything else is counted. To set it,
from `site/` on the project account's machine:

```
openssl rand -hex 32
npx wrangler secret put VIEWS_SALT_KEY
```

Paste the 64 hex characters when Wrangler asks. The secret survives every
deploy. Keep no copy: nothing ever needs it outside the Worker, and a lost
secret only means a new one (that day's visitors are then counted under two
salts, so set or change it close to midnight UTC; the roll-up blanks the
visitor columns of any day on which a person's request carried no code).

### The token

The workflow's `CLOUDFLARE_API_TOKEN` cannot read analytics and is not given
that permission. The nightly roll-up reads with a second token that can do
nothing else:

1. Cloudflare dashboard, signed in as the project account: My Profile, API
   Tokens, Create Token, Custom token.
2. Name `analytics read`. Permissions: Account, Account Analytics, Read.
   Account resources: the project account only. No zone permissions, no
   other account permissions. No IP filtering (the GitHub runners' addresses
   change).
3. GitHub, the repository, Settings, Secrets and variables, Actions, New
   repository secret: name `CLOUDFLARE_ANALYTICS_TOKEN`, the token as the
   value.

Until the secret exists, the step logs "no analytics token; nothing rolled
up" and the run status reads `views_rollup: no token`. The first night with
the secret rolls up every day Analytics Engine still holds.

### What the nightly run keeps in R2

The workflow step "Roll up the audience counts" runs
`python -m lmia_pipeline rollup-views` (`pipeline/lmia_pipeline/views_rollup.py`).
It asks the SQL API for every finished UTC day after the newest one in the
summary (normally only yesterday; on the first night, the last 90 days), so
a night that fails is caught up by the next. A day with no data points at all
is not written and is asked again the next night. Each day costs one query,
and six more when it has data points (counts, feeds, page views by bot flag,
people's page views by route, distinct visitor codes, distinct codes with a
page view). Files in the `lmia-watch-data` bucket:

| Key | What it is |
|---|---|
| `views/YYYY-MM-DD.csv` | one file per day, written once and replaced only if that day is rolled up again |
| `views/summary.csv` | one row per day, every day kept so far |
| `views/search_console.csv` | one row per day of Search Console figures (below) |
| `views/report-YYYY-MM.md` | the monthly report (below) |

The summary is downloaded, extended and uploaded again each night. A download
that fails for any reason other than "does not exist" stops the step, and a
summary that cannot be read (empty, an unknown column, a row without a date)
fails the roll-up, so a shorter file never replaces it. It can always be
rebuilt from the day files. A summary written before a column existed reads
with that column blank.

A day file, header
`date,section,route,kind,lang,country,referrer,status,feed,responses,subscribers,agent,device`
(files written before 2026-10-30 lack the last two), has five kinds of row,
named by `section`:

| `section` | Columns filled | Meaning |
|---|---|---|
| `total` | `responses` | every response the Worker counted that day |
| `kind` | `kind`, `responses` | the day's responses of one kind |
| `count` | `route` to `status`, `responses` | responses for one combination of route template, kind, language, country, referring host and status |
| `feed` | `feed`, `responses`, `subscribers` | one feed file: the day's polls, and the largest subscriber count any reader stated (0 when none did); `feed` is empty for polls of a feed path with no file |
| `audience` | `agent`, `country`, `device`, `lang`, `responses` | page views below status 400 for one combination of bot flag, country, device and language; `agent` is empty for points written before the flag |

`status` is the HTTP status code; `country` and `referrer` are empty when the
request carried none. Counts come from `SUM(_sample_interval)`, so they are
exact while Analytics Engine does not sample and estimates when it does; the
distinct counts of visitor codes would undercount if it ever sampled (this
site's volume is far below where it starts).

The summary, header
`date,responses,pages,api,downloads,forms,feeds,other,feed_subscribers,bluesky_followers,top_routes,human_pages,bot_pages,unique_visitors,human_visits,human_by_country,human_by_device,human_by_lang,human_by_route,x_followers,employers,records`:

| Column | Meaning |
|---|---|
| `date` | the UTC day |
| `responses` | every response counted, people and bots |
| `pages`, `api`, `downloads`, `forms`, `feeds` | responses of kind `page`, `api`, `download`, `form`, `feed` |
| `other` | everything else: the payment hook, `robots.txt`, the sitemaps, the feed index, paths that match no route |
| `feed_subscribers` | the sum over feed files of each file's largest stated subscriber count; a person who follows two feeds counts twice, and a feed read through two services counts only the larger figure |
| `bluesky_followers` | the Bluesky account's follower count when the roll-up ran, on the row for the day before; empty for days caught up later and when the profile could not be read |
| `top_routes` | the five route templates with the most responses below status 400, people and bots together, as `route count` pairs separated by semicolons |
| `human_pages` | page views (kind `page`, status below 400) marked human |
| `bot_pages` | page views marked bot |
| `unique_visitors` | distinct visitor codes among people's requests of any kind |
| `human_visits` | distinct visitor codes with at least one page view (any status); approximate, since a code lasts the whole day |
| `human_by_country` | people's page views by country as compact JSON, largest first: the top ten, then `other` for the rest; `unknown` when the edge gave none |
| `human_by_device` | people's page views by `desktop`, `mobile`, `tablet` |
| `human_by_lang` | people's page views by `en`, `fr` |
| `human_by_route` | people's page views by route template, every route |
| `x_followers` | the X account's follower count, read once a month on the night that rolls up the month's last day, only when X posting is enabled (`X_POST_ENABLED` and the four X secrets); one read, billed per use |
| `employers`, `records` | the site's counts from tonight's `stats.json` (employers; rows on ESDC's positive and negative lists), on the row for the day before |

Blanks are deliberate and never mean zero. The eight people and bot columns
are blank on any day on which a page view carries no bot flag (every day
before 2026-10-30, and the day itself, which mixes points from before and
after the deploy). `unique_visitors` and `human_visits` are also blank on any
day on which a person's request carried no visitor code (no `VIEWS_SALT_KEY`,
or the secret set part way through the day). The follower, employer and
record readings are taken on the night, so a day rolled up again keeps the
reading it had.

Nothing in either file identifies a visitor: the queries can read only what
the Worker writes, never ask for a visitor code itself, and the roll-up
blanks any value that does not have the shape the Worker writes before it
is stored.

Bluesky's follower count comes from its public profile endpoint
(`public.api.bsky.app`, `app.bsky.actor.getProfile`), which needs no token;
the handle is the `BSKY_HANDLE` secret, or the site's domain when that is not
set. X's comes from `GET /2/users/me?user.fields=public_metrics` with the
posting credentials, once a month.

Outcomes in the run status, as `views_rollup`: `rolled up`, `no data` (no
day had a data point), `no token`, or `failed` (the SQL API failed, the
summary could not be downloaded or read, or an upload failed). Only `failed`
is an attention item. The step never stops the run.

To read the files: Cloudflare dashboard, R2, `lmia-watch-data`, folder
`views`, or from `site/` on the project account's machine,
`npx wrangler r2 object get --remote lmia-watch-data/views/summary.csv --file summary.csv`
(without `--remote`, Wrangler reads a local simulated bucket). The weekly
backup pull on the operator's PC keeps `views/summary.csv`; add
`views/search_console.csv` and the reports to it if a copy off the account is
wanted.

Nothing needs doing by hand. To look at one day from a machine anyway (within
the 90 days, with `CLOUDFLARE_ANALYTICS_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
set in the shell), `python -m lmia_pipeline rollup-views --day YYYY-MM-DD`
writes its file to `data/out/views/`.

### Search Console's figures

Search Console keeps 16 months. The workflow step "Import the Search Console
figures" runs `python -m lmia_pipeline import-search-console`
(`pipeline/lmia_pipeline/search_console.py`) and appends to
`views/search_console.csv` one row per day after the newest one it holds
(on the first night, everything Search Console still has), header
`date,clicks,impressions,ctr,position,top_queries`:

| Column | Meaning |
|---|---|
| `date` | the day (Search Console's days are Pacific time, as in its own reports) |
| `clicks`, `impressions` | web search totals for the property |
| `ctr` | clicks over impressions, as Search Console gives it |
| `position` | the average position, weighted by impressions |
| `top_queries` | the day's 50 queries with the most clicks, as JSON: `[[query, clicks, impressions, position], ...]` |

Only final data is asked for (`dataState: final`), so a stored day never
changes; the newest two or three days arrive on later nights. A day with no
impressions has no row. At most 120 days are fetched a night, and the next
night goes on. Google leaves out queries made by very few people, and the
file is not published.

Signing in: Google exchanges a JWT signed with the service account's RSA key
for a read-only access token (scope `webmasters.readonly`). The key is loaded
and the JWT signed with the `cryptography` package (a pipeline dependency,
installed by the workflow's `pip install -e ./pipeline`): PKCS #1 v1.5
padding over SHA-256. The key is read from the secret and never written or
logged.

Outcomes, as `search_console` in the run status and "Search Console:" in
LAST_RUN.md: `imported <n> days`, `up to date`, `no credentials` (the secret
is not set; nothing is asked), or `failed` (an attention item and a watchdog
email; the next night catches up, and the file is never replaced by a shorter
one).

#### Setting up the service account

Use the project's Google account (section 3), in the project's browser
profile.

1. Open `console.cloud.google.com` and create a project, for example
   `lmia-watch-audience`. No billing account is needed.
2. APIs & Services, Library: find "Google Search Console API" and Enable it.
3. IAM & Admin, Service Accounts, Create service account: name
   `search-console-reader`. Skip the optional role and user steps; the
   account needs no Cloud permissions.
4. Open the new account, Keys, Add key, Create new key, JSON. A file
   downloads.
5. Search Console, the `lmiawatch.ca` property, Settings, Users and
   permissions, Add user: the service account's address (it ends in
   `.iam.gserviceaccount.com`), permission Restricted. Restricted can read
   every report and change nothing.
6. GitHub, the repository, Settings, Secrets and variables, Actions, New
   repository secret: name `GSC_SERVICE_ACCOUNT_JSON`, the whole content of
   the downloaded file as the value. Then delete the file.
7. Only if the property is a URL-prefix property rather than the domain
   property: a repository variable `GSC_SITE` with its address, for example
   `https://lmiawatch.ca/`. The default is `sc-domain:lmiawatch.ca`.

The next run imports the 16 months Search Console holds. A key does not
expire; to replace one, add a new key, update the secret, and delete the old
key in the Cloud console. An answer of 403 means the account is not a user
of the property (step 5).

### The monthly report

The workflow step "Write the monthly audience report" runs
`python -m lmia_pipeline views-report` (`pipeline/lmia_pipeline/views_report.py`)
on the first run of each UTC month: every night it asks R2 whether
`views/report-<last month>.md` exists, and writes it when it does not, from
the summary and the Search Console file as R2 holds them. It waits up to a
week for the month's last day to be rolled up (outcome `waiting`), then
writes with the days there are.

The report is plain markdown: a table of the month and the three before it
(days counted, page views by people, unique visitors summed by day, visits,
Canada's share, the device split, search clicks, impressions and position,
feed subscribers, Bluesky and X followers, employers and records), the
month's top ten pages by people, and the definitions of each figure. A
figure that was not counted reads `n/a`. Unique visitors are summed over the
month's days ("visitor-days"), since the code changes daily: a person who
came on three days counts three times.

Its one line goes to LAST_RUN.md as "Audience report: ..." on the run that
wrote it. Outcomes, as `views_report`: `written`, `not due` (the report
exists), `waiting`, `no data` (the summary holds no day of the month), or
`failed` (an attention item and a watchdog email; the next run tries again).
To write one by hand from downloaded files:
`python -m lmia_pipeline views-report --month 2026-11 --summary summary.csv --search search_console.csv --out .`

### The dashboard

Workers & Pages, `lmia-watch`, Metrics shows requests, errors and CPU time
for the Worker with no setup. The per-route, per-language and per-referrer
counts are only in Analytics Engine, read through the SQL API below or from
the files above.

### The SQL API

Every query goes to one address, with the account id (Workers & Pages,
right-hand column) and the token from above:

```
curl "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql" \
  --header "Authorization: Bearer <ANALYTICS_TOKEN>" \
  --data "<SQL>"
```

Analytics Engine samples at high volume, so count with
`SUM(_sample_interval)`, never `COUNT()`.

Page views a day, last 30 days:

```
SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, SUM(_sample_interval) AS views
FROM lmia_watch_views
WHERE blob2 = 'page' AND double1 < 400 AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day
```

People and bots a day, with distinct visitors, last 7 days (from 2026-10-30):

```
SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob8 AS agent,
  SUM(_sample_interval) AS views, count(DISTINCT blob10) AS codes
FROM lmia_watch_views
WHERE blob2 = 'page' AND double1 < 400 AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY day, agent ORDER BY day, agent
```

(A row of bots shows `codes` 1: every bot point carries the same empty
code.)

Most viewed routes and the language split, last 7 days:

```
SELECT blob1 AS route, blob3 AS lang, SUM(_sample_interval) AS views
FROM lmia_watch_views
WHERE (blob2 = 'page' OR blob2 = 'download') AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY route, lang ORDER BY views DESC LIMIT 30
```

Other sites that send visitors, last 30 days:

```
SELECT blob5 AS referrer, SUM(_sample_interval) AS views
FROM lmia_watch_views
WHERE blob5 != '' AND blob5 != 'lmiawatch.ca' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY referrer ORDER BY views DESC LIMIT 25
```

Countries, last 30 days:

```
SELECT blob4 AS country, SUM(_sample_interval) AS views
FROM lmia_watch_views
WHERE blob2 = 'page' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY country ORDER BY views DESC LIMIT 25
```

Feed polls and the largest stated subscriber count per feed, last 7 days:

```
SELECT blob7 AS feed, SUM(_sample_interval) AS polls, MAX(double2) AS subscribers
FROM lmia_watch_views
WHERE blob2 = 'feed' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY feed ORDER BY polls DESC
```

Server errors, last 7 days (should be empty):

```
SELECT blob1 AS route, double1 AS status, SUM(_sample_interval) AS n
FROM lmia_watch_views
WHERE double1 >= 500 AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY route, status ORDER BY n DESC
```

The answer is JSON (`data` holds the rows). Add `FORMAT TabSeparated` at the
end of a query for plain text.

A later option: the newer Analytics SQL binding would let the Worker run the
same queries with no token at all. It needs Wrangler 4.145 or later; the site
pins 4.105 for its test pool.

## 7. Crawl budget

About 160,000 employer pages share each engine's crawl allowance. The site
keeps crawlers off URLs that repeat another page, links every profile to the
place and occupation pages that cover it, links every profile from an A to Z
directory of its province and from the related lists of other profiles, and
lets a crawler that already has a page skip it when nothing changed.

### robots.txt

`site/public/robots.txt` gives every crawler the `User-agent: *` group (with
`Crawl-delay: 5`) and Bingbot a group of its own with the same rules and no
delay. Both groups carry three pairs of rules for pages whose query forms
name the plain page as their canonical URL:

| Rules | Kept off | Open |
|---|---|---|
| `Disallow: /search?`, `Allow: /search?lang=fr$` | filtered searches and page cursors | `/search`, `/search?lang=fr` |
| `Disallow: /corrections?`, `Allow: /corrections?lang=fr$` | the correction form with `?employer=<id>` (how profiles linked it before 2026-11-04) | `/corrections`, `/corrections?lang=fr` |
| `Disallow: /map?`, `Allow: /map?lang=fr$` | the map opened on a postal area (`?fsa=<FSA>`, each profile's "nearby" link) | `/map`, `/map?lang=fr` |

Google and Bing apply the longest matching rule, so the `Allow` line, anchored
at the end by `$`, opens the French page and nothing else under the same
`Disallow`. The `/corrections?` and `/map?` pairs followed a week in which
Claude-SearchBot fetched `/corrections?employer=` 2,599 times, Googlebot
1,110 times, and crawlers fetched about 1,600 `/map?fsa=` variants. The
robots test in `site/test/seo.test.ts` checks both groups against these
paths.

Since 2026-11-04 a profile links `/corrections#<id>`. A fragment never
reaches the server, so all 168,000 profiles link one URL instead of one
each, and `site/public/corrections.js` copies the id into the form's hidden
`employer` field. `?employer=<id>` still fills the field for older links
and bookmarks, so the rule pair stays. Without JavaScript the form still
works: the server matches the record reference the reader types.

### Links from employer pages

Each profile links (`site/src/crosslinks.ts`):

- the breadcrumb's province to `/places/<pp>`, for the thirteen provinces and
  territories. With no province, or a head office outside Canada, the crumb
  is plain text and the breadcrumb JSON-LD leaves it out. The crumb linked
  `/search?province=XX` before, which robots.txt blocks.
- the city in the City row to `/places/<pp>/<slug>`, when the province's
  file `places/<pp>.json` lists a page for that city (`places/index.json`
  lists only the 25 largest per province). The city as written on the record
  is folded as the pipeline folds names into slugs (accents dropped, lower
  case, apostrophes dropped, other punctuation a space, Saint and Sainte read
  as St and Ste) and compared with each listed city's slug and name.
- each NOC code in the records table to `/occupations/<noc>`, when
  `occupations/index.json` marks the code as indexed. The four-digit NOC 2011
  codes of the older lists have no page.

A missing or unreadable file leaves the text unlinked. Both files go through
the Worker's parsed-file cache, so an isolate parses each once per deploy.

### Links to employer pages

Until 2026-10-30 a profile's only inbound links were its sitemap entry and,
for a few hundred employers, a place page's list of the 20 with the newest
records, and Google had crawled a few thousand of the profiles. Two kinds of
link, both written by the nightly export (`pipeline/lmia_pipeline/directory.py`),
now reach every profile:

- The directory. Each of the thirteen provinces and territories has an A to Z
  list of every employer with a profile there, 200 to a page, at
  `/places/<pp>/employers` (page 1) and `/places/<pp>/employers/<n>`.
  Employers with a head office outside Canada (province `XX`) or no province
  share `/places/other/employers`. Rows sort by the normalized name, which is
  part of the employer id and does not change, so a page's rows move only
  when an employer is added or leaves. Each page links the previous and next
  page (in the pager and as `<link rel="prev">` and `<link rel="next">` in the
  head), every page of the directory, and the page on which each initial
  starts, so any page is one click from any other. The province page, the
  `/places` index and every profile link the directory. The pages are
  indexable, carry their own canonical URL and language alternates, and are
  in the sitemap; robots.txt does not touch them (the robots test lists
  them among the open paths). A directory with no employer answers with a
  short noindex page and has no sitemap entry. On the data of 2026-10-17:
  849 pages, from 1 (Yukon, Nunavut, the Northwest Territories) to 244
  (Ontario), 15 MB in all.
- Related employers. Each profile lists up to five other employers: first
  those in the same city (folded as the place pages fold it), then those in
  the same province whose most common NOC code is the same. Within each group
  the list takes the employers nearest in record count, one with more and one
  with fewer in turn. Ranking the busiest employers of a city instead would
  send every profile's links to the same few: on the data of 2026-10-17 that
  linked 21,370 of 168,440 profiles (one profile received 10,892 links),
  against 165,593 (at most 14 each) for the nearest. The list adds about
  50 MB to the profile shards in all, about 12 KB a shard.

The sitemap dates each directory page by the night its rows last changed:
the database's `directory_pages` table keeps each page's hash and that date,
so a night that leaves a page as it was keeps its lastmod.

### ETag and 304

Every HTML page answered 200 to a GET or HEAD carries a weak ETag,
`W/"<SHA-1 of the body>"` (`site/src/conditional.ts`). A request whose
`If-None-Match` names that tag (compared weakly; lists and `*` are read) gets
a 304 with no body, carrying the ETag, Cache-Control, Vary and any Set-Cookie
of the full answer, plus the security headers every response gets. The tag
comes from the rendered body because one URL renders in English or in French
depending on the `lang` cookie, and a page reads several files and the forms
database. The Worker still renders the page to compute the tag, so a 304
saves the transfer and the crawler's time; the CPU cost is the same.

Other statuses, POSTs, the JSON API, downloads, sitemaps, robots.txt and the
Atom feeds (which pass the assets layer's own ETag through) are left as they
are. A 304 is counted in Analytics Engine with status 304, so the day files'
`status` column shows how often pages are revalidated.

Check after the first deploy: `curl -sI https://lmiawatch.ca/methodology`
shows `etag: W/"..."`, and the same request with
`-H 'If-None-Match: W/"..."'` (the tag just shown) answers `304`. Cloudflare
removes weak ETags when the zone runs Email Obfuscation, Automatic HTTPS
Rewrites or Replace insecure JavaScript libraries, so if the tag is missing
at the edge while the site's tests pass, turn those off in the zone (the
pages carry no email address to hide).

Found 2026-11-04: Cloudflare Web Analytics ran on its automatic setup, which
injects the beacon into every HTML response sent to a browser-like request
(an `Accept` header naming `text/html`, as crawlers send). The rewrite
dropped the ETag, so search engines received no 304s, while a plain `curl`
still showed the tag. Add `-H 'Accept: text/html'` to the checks above for
that reason. The beacon is now in the page template (`site/src/layout.tsx`,
with the site's public token), and the content security policy in
`site/src/index.tsx` allows its file and `cloudflareinsights.com`, where it
reports. The Web Analytics site in the dashboard (Web Analytics,
lmiawatch.ca, Manage site) must stay on "Enable with JS Snippet
installation", never the automatic setup. Every night the run fetches the
home page as a browser would and expects its ETag and exactly one beacon
(`check_html_rewrite` in `pipeline/lmia_pipeline/resilience.py`); a missing
ETag or a second beacon is an attention item saying that Cloudflare is
rewriting the HTML again (`docs/alerts.md`).

## Sources (read 2026-10-18)

- Cloudflare and ETags (weak ETags kept unless Email Obfuscation, Automatic
  HTTPS Rewrites or Replace insecure JavaScript libraries is on), read
  2026-10-25: `developers.cloudflare.com/cache/reference/etag-headers/`
- Web Analytics (the automatic setup injects the beacon into proxied HTML;
  the manual snippet needs
  `https://static.cloudflareinsights.com/beacon.min.js` in `script-src` and
  reports to `cloudflareinsights.com`, which `connect-src` must allow), read
  2026-11-04: `developers.cloudflare.com/web-analytics/faq/`

- IndexNow protocol (the endpoint, the request body, 10,000 URLs a request,
  the key file at the root, the answers 200, 202, 400, 403, 422 and 429),
  read 2026-10-24: `indexnow.org/documentation`; no published daily limit,
  and only changed URLs to be sent: `indexnow.org/faq`

- Analytics Engine binding, SQL API and the Account Analytics Read
  permission: `developers.cloudflare.com/analytics/analytics-engine/get-started/`
- Limits (20 blobs, one index of 96 bytes, 250 points per invocation, three
  months' retention): `developers.cloudflare.com/analytics/analytics-engine/limits/`
- Free plan allowance (100,000 points written and 10,000 queries a day):
  `developers.cloudflare.com/analytics/analytics-engine/pricing/`
- SQL functions used by the roll-up (`toDateTime` with a unix timestamp,
  `max`, `sum`, `FORMAT JSON`), read 2026-10-22:
  `developers.cloudflare.com/analytics/analytics-engine/sql-reference/`
- `run_worker_first` with a list of patterns (`*` matches deeply, `!`
  excludes), read 2026-10-22:
  `developers.cloudflare.com/workers/static-assets/binding/`

## 8. Pointing crawlers at the bulk files

Nothing obliges a crawler to read the nightly CSVs instead of 160,000 profile
pages, so the site makes the files easy to find for the ones that look:
`/llms.txt` (the convention AI crawlers and agents read first) names every
download, the Data page and the Zenodo deposit; every profile answers with a
`Link` header naming `employers.csv` as an alternate representation and
`/llms.txt` as help; robots.txt says the same in its opening comment, carries
Cloudflare's `Content-Signal` line (search yes, AI input yes, AI training no),
and no longer disallows `/downloads/` for search engines and Bing, which the
Worker's ten-a-minute cap still protects. The AI-training group stays
disallowed from everything.

The response form (`/employers/<id>/respond`) is disallowed in robots.txt,
and a GET that carries neither `Sec-Fetch-Mode` nor a Referer from the site
gets a 403 with one line naming the employer's profile
(`respondPage` in `site/src/pages/forms.tsx`): a browser sends one or the
other whenever a person follows a link to the form, from the site or from an
emailed message, and a scraper that ignores robots.txt usually sends neither.
The corrections page stays open to any client, since other sites link to it.
