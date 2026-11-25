# Performance: CPU time on the Worker

The Workers Paid plan includes 30 million CPU milliseconds a month and bills
past that. This page records what the Worker spends its CPU on, the changes
of 2026-11-14 that cut it (a cache of rendered pages, Smart Placement, a
cheaper start-up and a cheaper data load), how to read CPU time in
Cloudflare's analytics, and how to check the changes after a deploy. The
zone's edge rules (`docs/traffic-limits.md`, section 1) now turn most scraper
requests away before the Worker runs, so those cost the Worker no CPU.

## Baseline (2026-11-13)

About 165,000 requests a day at a mean of 9.6 ms of CPU each, roughly 48
million CPU milliseconds a month. Start-up was 25 to 35 percent of all CPU
time: Workers analytics showed 500,000 to 820,000 ms of start-up CPU a day,
with a per-start p90 of 27 ms and a p99 of 57 ms, which means 15,000 to
28,000 new isolates a day. Traffic reaches about 200 Cloudflare locations,
and each keeps its own isolates, so isolates are evicted and started again
all day.

Profile pages were about 186,000 of 230,000 requests on a typical day. A
scraper fleet and the AI search crawlers fetch nearly every profile three
or four times a day, through the same location.

## The page cache

`site/src/pagecache.ts` keeps rendered pages in the Cache API of the location
that runs the Worker (`caches.open("pages")`), so the second and later
fetches of a page at that location skip the render.

What is cached: a `GET` for a page whose content depends only on the URL,
the language and the deployed data, answered 200 with HTML and no
`Set-Cookie`. Never cached: the response form (`/employers/<id>/respond`),
`/corrections`, `/support` (it reads the donation notices, which arrive at
any time), `/cite` (it prints the day's date), `/search` with a query string,
anything under `/api/`, the downloads, the feeds, `robots.txt`, `llms.txt`,
the sitemaps, a request carrying `?lang=` (the language middleware answers
it with a cookie), and every status but 200. The rate limits and the refusal
of automated browsers run before the cache, so a refused request is never
answered from it.

The key is a synthetic URL:

```
https://pages.lmiawatch.invalid/<version id>.<stats.json ETag>.<forms digest>/<lang>/<path>?<query>
```

- the Worker's version id, from the `CF_VERSION_METADATA` binding, so a
  deploy of new code never serves a page the old code rendered;
- the `ETag` of `stats.json` from the assets binding, which changes with
  every data deploy;
- for a profile (`/employers/<id>`), a digest of its published responses
  and corrections in the forms database. Those rows change between deploys,
  so they are read before the lookup (the same two queries the page makes,
  handed to the page so they run once), and a response or correction that
  is published, resolved, edited or withdrawn changes the key at once. A
  profile with neither has the digest `0`.

The stored copy carries `Cache-Control: public, max-age=86400`, so the
Cache API keeps it for a day. The version in the key bounds what can be
stale: after a deploy the old keys are never asked for again and age out.
A hit is sent with the page's own headers (content type, the page's ETag,
the `Link` header on profiles, the security headers) and the page's usual
`Cache-Control: public, max-age=300`. The ETag is computed once, when the
page is stored, and a request whose `If-None-Match` names it gets a 304
without the body being hashed again.

Every page the cache could answer carries `X-Page-Cache: hit` or
`X-Page-Cache: miss`. Pages it never caches carry no such header. Each data
point in the views dataset holds the same word in `blob11` (empty for
requests the cache does not consider), so the hit rate can be followed over
time (`docs/search-engines.md`, *What one data point holds*).

Any failure falls back to rendering the page: no Cache API, no version
binding, no `ETag` on `stats.json`, the forms database unreadable, or a
Cache API call that throws.

Measured with `site/scripts/bench-render.mjs` on five real profiles
(Node, 2026-11-14): a miss, which renders, hashes and stores the page,
took 1.8 ms; a hit took 0.13 to 0.14 ms. Production runs on slower cores
and adds the work Node does not see (the asset and database subrequests),
but the ratio holds: a hit costs under a tenth of a render.

## Smart Placement

`site/wrangler.jsonc` sets `"placement": { "mode": "smart" }`. Most page
requests read D1 (the forms database on every profile, the search database
on `/search`), so Cloudflare may run the Worker near the databases instead
of in the location that received the request. What the site wants from it is
fewer locations running the Worker: each location starts its own isolates
and keeps its own page cache, so fewer locations mean fewer cold isolates and
more cache hits. The price is some tens of milliseconds of latency for
readers far from where the Worker runs. Static files under `/data/` and
`/fonts/` are still served from the location nearest the reader.

Cloudflare may take up to 15 minutes after a deploy to analyse the Worker
before it moves it, and it needs steady traffic from several locations to
decide. Smart Placement affects only the `fetch` handler; the daily cron
check is unaffected.

## Start-up

Every new isolate compiles the whole bundle and runs its top-level code
before the first request. Measured in Node on 2026-11-14 with the bundle
`npx wrangler deploy --dry-run --outdir <dir>` writes (median of 25 runs,
the two bundles in alternation, each in a fresh process):

| Bundle | Size | Compile | Top-level run | `import()` of the `.js` file |
|---|---|---|---|---|
| before | 938 KiB | 11.2 ms | 3.2 ms | 28.7 ms |
| after | 622 KiB | 9.5 ms | 1.9 ms | 24.4 ms |

The last column is `await import()` of the `.js` file, which includes 10 to
12 ms that Node spends deciding whether the file is a CommonJS or an ES
module; workerd never does that. Imported as `.mjs`, which skips that step,
the bundle took 17.0 ms before and 14.2 ms after. The changes:

- `"minify": true` in `wrangler.jsonc`: V8's compile time follows the size
  of the source. `"upload_source_maps": true` keeps the stack traces in the
  Worker's logs readable.
- `"keep_names": false`: esbuild otherwise wraps 769 functions in a
  `__name()` call at load, to keep `Function.name`, which nothing in the
  Worker reads. The top-level run drops by about 1.2 ms.
- The French indicator-basis patterns (`site/src/i18n.ts`) are built on the
  first French page that needs them, not at load: about 0.2 ms less per
  start (median of 31 alternating runs).

Tried and not kept: turning the string table in `i18n.ts` into
`JSON.parse` of one string literal. The compile got about 1.2 ms cheaper and
the top-level run about 1 ms dearer, so it saved nothing.

## Render cost

`site/scripts/bench-render.mjs` times the parts of an employer page on copies
of live data (`site/test/fixtures/bench/`): parsing and freezing each data
file, the render, and the ETag hash. On 2026-11-14 a profile shard of 155 to
240 KB took 0.29 to 0.47 ms to parse, and freezing every node of it took
another 0.11 to 0.14 ms. Production now freezes only the top level of each
parsed file (`site/src/data.ts`), which cut loading a shard by 0.11 to 0.19
ms; the tests still freeze every node, so a page that changes a shared row
in place fails there. The render itself took 1.0 to 3.1 ms per profile and
the ETag hash 0.03 to 0.09 ms, which was left as it is.

## Reading CPU time in Workers analytics

The GraphQL Analytics API's `workersInvocationsAdaptive` dataset, filtered on
`scriptName: "lmia-watch"`, gives per day the sums `requests`, `cpuTimeUs`
(CPU time spent on requests) and `startupCpuTimeUs` (CPU time spent starting
isolates). Divide `cpuTimeUs` by `requests` for the mean CPU per request (9.6
ms on 2026-11-13), and compare `startupCpuTimeUs` with the two sums together
for start-up's share (25 to 35 percent on 2026-11-13). The quantiles
`cpuTimeP50` and `cpuTimeP99` show the spread. The dashboard's Workers
Metrics page shows the same CPU time without the start-up split.

## Checking after a deploy

Fetch one profile twice, as a browser would (a bare `curl` does not see the
edge's HTML handling), and read the headers. The cache answers `GET` only,
so dump the headers of a `GET` rather than sending `HEAD` with `curl -I`.
The edge challenges a browser it has not checked, so send the check key
(`docs/traffic-limits.md`, section 1; `$KEY` holding it):

```
curl -s -o /dev/null -D - -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" -H "Accept: text/html" -H "x-lmiawatch-check: $KEY" https://lmiawatch.ca/employers/emp-e11aad356c
```

The first answer should carry `x-page-cache: miss` and the second, a few
seconds later, `x-page-cache: hit` with the same `etag`. A `cf-placement`
header says where the Worker ran: `remote-<location>` when Smart Placement
moved it, `local-<location>` when it ran where the request arrived.
Cloudflare notes that this header may be removed once Smart Placement leaves
beta. Within a day the views dataset should show `blob11 = 'hit'` on a large
share of profile views, and the next days' `cpuTimeUs` and
`startupCpuTimeUs` sums should fall against the baseline above.
