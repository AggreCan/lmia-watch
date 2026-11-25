# Site-only deploy

`.github/workflows/deploy-site.yml` deploys a change to the site's code or
pages (a wording fix, a layout fix, a page bug) in a few minutes, without
running the nightly refresh. It ships the Worker from `main` together with
the data the site already serves, and it is built so that it cannot write,
delete or change that data. The data here means the R2 bucket
`lmia-watch-data` (backups, `static.tar.gz`, `downloads/`, `mirror/`,
`views/`, `status.json`), the two D1 databases (`lmia-watch` for the forms,
`lmia-watch-search` for search), and the data files the Worker serves as
assets (`site/public/data`).

## What it is for

Changes under `site/` that work with the data already live: page text,
layout, styles, scripts, and bugs in a page or in the API.

Anything that touches the exported data or the pipeline goes out with the
nightly run, which rebuilds the data and then deploys `main`. A site change
that needs a new data field, or a file the export does not write yet, waits
for that refresh: put it on `main` with the pipeline change and the next
night ships both. Worker secrets and the forms database's schema are set by
hand and are never part of a deploy.

The next nightly run deploys `main` anyway. This workflow only ships a site
change sooner.

## The five steps

1. The run starts by hand only, from `main` (the Actions tab or the REST
   API, see *How to start it*). There is no schedule and no push trigger.
   It shares the nightly's concurrency group, `nightly`: while a refresh
   runs, the site deploy waits, and a refresh that starts during a site
   deploy waits for it.
2. It checks out `main` and installs the pipeline (for its helper commands)
   and the site's pinned Wrangler (`npm ci` in `site/`).
3. It downloads `static.tar.gz` from R2, a read. The nightly saves that
   archive only after a deploy that passed its live check, so it should hold
   the data the site serves. `python -m lmia_pipeline.nightly
   site-bundle-check` proves it: it fetches `/data/stats.json`,
   `/data/search/facets.json` and `/data/search/first.json` from the live
   site and compares each with the archive's copy as parsed JSON. stats.json
   lists the newest runs with their times, so an archive from any other
   night fails. Only when all three match is the archive copied to
   `site/public/data`.
4. It records the Worker version serving traffic (`wrangler deployments
   status`), compares the three files once more (now from
   `site/public/data`) and keeps the live stats.json byte for byte, then
   runs `wrangler deploy` from `site/`. After the deploy it runs the
   nightly's smoke test (home, search, data and one profile) and the bundle
   check again: the three files from the live site, and the archive's
   stats.json against the copy kept before the deploy. The run rolls the
   Worker back to the recorded version when the deploy failed, when the
   smoke test found the Worker answering 500 to 599, or when any comparison
   failed.
5. It writes nothing: no R2 upload or removal, no D1 command, no commit, no
   `LAST_RUN.md`, no `status.json`. The nightly's gate and its state never
   see this run. The run's summary page lists the reason given, the commit,
   the files compared before and after the deploy, the version live before
   and after, the smoke verdict and any rollback.

## Three measures that keep it away from the data

### Primary: a token that cannot write data

Every Cloudflare call in the workflow uses its own secret,
`CLOUDFLARE_SITE_DEPLOY_TOKEN`, never the nightly's token. That token has no
R2 write and no D1 write permission (see *The deploy token*), so even a
mistaken command in the workflow is refused by Cloudflare. The first step
fails at once, before anything is installed, when the secret is empty; there
is no fallback to another token. The token is handed only to the steps that
call Wrangler, so `npm ci` and the pipeline install never see it.
`CLOUDFLARE_ACCOUNT_ID` is the secret the nightly already uses. So is
`EDGE_CHECK_KEY`, the key that lets the run's checks past the edge's
challenge (`docs/traffic-limits.md`, section 1); only the four steps that
fetch the live site receive it (the two bundle checks before the deploy, the
smoke test and the data check after it), and it grants no write anywhere.

### Secondary: no write command in the workflow

The workflow runs these Cloudflare commands and no others, all with the
site's pinned Wrangler:

| Command | What it does |
|---|---|
| `wrangler r2 object get --remote lmia-watch-data/static.tar.gz` | reads the archive |
| `wrangler deployments status --json` | reads the version serving traffic, before the deploy and at the end |
| `wrangler deploy` | uploads the Worker and its assets from `site/` |
| `wrangler rollback <recorded version> --yes` | puts the recorded version back on all traffic |

The pipeline commands are `live-version`, `smoke` and `site-bundle-check`
from `lmia_pipeline.nightly`, which read files and fetch public pages.

`pipeline/tests/test_site_deploy.py` reads the workflow file and fails when:
the trigger is anything but `workflow_dispatch`; `permissions` is anything
but `contents: read`; the concurrency group is not `nightly` in both
workflows; a line runs `r2 object put`, `r2 object delete`, `r2 bucket`, a
`d1` command, the pipeline's main command line, a nightly command that
writes state (`pack`, `status`, `attention`, `gate` and the others), `git`,
`curl`, `npx` or the Cloudflare API directly; a Wrangler call is anything but
the four forms above through the pinned binary; any secret other than the
three above is read, or the check key reaches a step that does not fetch the
live site; or `CLOUDFLARE_API_TOKEN` (the variable Wrangler reads) is
set from anything but the site deploy token. It also plants each of those
changes in a copy of the file and checks that the guard catches it. The
checks are textual: PyYAML is not a dependency of the pipeline.

The bundle check (`resilience.bundle_check`) exits non-zero on any
difference, a file missing from the archive, an answer other than 200 or a
body that is not JSON, naming the file. Before the deploy that stops the
run; after it, it triggers the rollback.

### Tertiary: checks after the deploy and an automatic rollback

After the deploy the run checks the live site twice over (the smoke test and
the bundle check) and rolls back on a failed deploy, server errors or any
difference. The version recorded before the deploy carries the same data,
so a rollback costs nothing but the change itself, and it never touches D1
or R2. A version that cannot be recorded stops the run before the deploy,
so there is always a way back. The run fails, and GitHub sends its
failed-workflow email, whenever anything was not confirmed, including a
smoke verdict of `unverifiable`, which (as in the nightly) is not a reason
to roll back.

## The deploy token

1. Cloudflare dashboard, signed in as the project account: My Profile, API
   Tokens, Create Token, Custom token.
2. Name `site deploy`. Permissions:

   | Type | Permission | Access | Needed for |
   |---|---|---|---|
   | Account | Workers Scripts | Edit | the deploy, the version reads and the rollback |
   | Account | Workers R2 Storage | Read | reading `static.tar.gz`; the Worker's R2 binding |
   | Account | D1 | Read | the Worker's two D1 bindings |
   | Account | Account Settings | Read | Wrangler's account lookups |
   | User | User Details | Read | Wrangler's user lookups |
   | Zone | Workers Routes | Edit | the two custom domains in `site/wrangler.jsonc`, sent with every deploy |

   Account resources: the project account only. Zone resources: the
   `lmiawatch.ca` zone only. No IP filtering (the GitHub runners' addresses
   change). No end date: the monthly expiry checks of the nightly run do not
   read this token, so nothing would warn before it lapsed.
3. GitHub, the repository, Settings, Secrets and variables, Actions, New
   repository secret: name `CLOUDFLARE_SITE_DEPLOY_TOKEN`, the token as the
   value.

The list is the best reading of what Wrangler needs for a deploy with
assets, R2 and D1 bindings and custom domains, plus an R2 object read. The
first run proves it. If a step stops on a permission or authentication
error, add the read permission Cloudflare names. Never add a write
permission beyond the two in the table, and never Workers R2 Storage Edit or
D1 Edit: without them the token cannot change the data. The token's summary page
in the dashboard lists every permission it holds.

## How to start it

From the Actions tab: Actions, deploy-site, Run workflow, branch `main`,
an optional reason, Run workflow.

Through the GitHub REST API, with a token that has Actions read and write
on the repository:

```
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/actions/workflows/deploy-site.yml/dispatches \
  -d '{"ref": "main", "inputs": {"reason": "fix the Trends heading"}}'
```

GitHub answers 204 and the run appears on the Actions tab. A run started
from any branch but `main` stops at its first step.

GitHub keeps one waiting run per concurrency group: a run queued while
another is waiting replaces the waiting one. So start one site deploy at a
time, and avoid the minutes around 00:00, 06:00 and 12:00 UTC, when the
nightly's schedules fire. A site deploy replaced this way changed nothing;
start it again. A nightly run replaced this way is made up by the next
schedule (the 06:00 and 12:00 retries run whenever the day's run did not
finish clean).

## What a failed run means

A failed site deploy never leaves the data changed, and a rollback leaves
the previous version, with the same data, live. The nightly is unaffected:
it reads nothing this run writes. Remember that the change is still on
`main`, and the next nightly deploys it; fix or revert it there first.

| Where it stopped | What it means | What to do |
|---|---|---|
| Check the deploy token and the branch | The secret is missing, or the run was started from another branch | Add the secret (above), or start it from `main` |
| Download the static bundle from R2 | `static.tar.gz` is not in R2, or R2 refused the token | A permission error: add Workers R2 Storage Read. A missing archive: wait for a nightly run |
| Unpack the bundle and check it | The archive is not what the site serves: the last nightly deployed but its save to R2 failed, or something was deployed since. Every file "answered 403" means the edge refused the check key instead | Nothing was deployed. Wait for the next nightly run, which deploys `main` with fresh data. For a 403, make the secret `EDGE_CHECK_KEY` and the WAF rule agree (`docs/traffic-limits.md`, section 1) and start it again |
| Record the live Worker version | Wrangler could not read the deployments | Nothing was deployed. Check the token's Workers Scripts permission |
| Check again and keep the live stats.json | The site's data changed between the two checks | Nothing was deployed. Start it again |
| Deploy the Worker | Wrangler failed three times. The run rolls back in case a try went part of the way | Read the deploy log; a permission error names the permission to add |
| Check the live site (broken) or the data check after the deploy | The new version answered with server errors or served other data. It was rolled back | Fix the change on `main`, then start a new run |
| Check the live site (unverifiable) | The pages answered, but not as expected (an edge refusal, a page without the data date). No rollback | Open the pages the step names. If the site is wrong, roll back by hand |
| Roll the Worker back | The rollback failed, so the new version may still be live | Roll back by hand to the version in the summary |

To roll back by hand: the dashboard (Workers & Pages, `lmia-watch`,
Deployments, the version listed as live before, Rollback), or
`npx wrangler rollback <version id>` from `site/` with the token in the
environment.
