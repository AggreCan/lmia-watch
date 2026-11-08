# Alerts for maintenance items

The site tells its operator when it needs a hand, through three channels that
need no new account. Most faults of the nightly run heal by themselves first
(see *What the run fixes by itself*); the alerts are for what is left.

## 1. The Worker's daily check

Every day at 06:00 UTC (after the nightly run's window) a cron trigger runs
`site/src/watchdog.ts`. It reads what the nightly run leaves behind:

- `stats.json` (the data date on every page),
- the upload time of `lmia.sqlite.gz` in R2 (the backup),
- `status.json` in R2 (when the run finished, which stages succeeded, and
  the outcomes of the X post, the Bluesky post, the Zenodo deposit, the
  search database sync, the audience roll-up, the Search Console import, the
  monthly audience report and any rollback).

It emails when the data is more than two and a half days old, the backup or
the status is missing or older than 36 hours, a stage or a workflow step
(restore, deploy, save) failed, the checks held back the night's data, the
status file cannot be read, X or Bluesky refused the post, the Zenodo
deposit, the search database sync, the audience roll-up, the Search Console
import or the monthly audience report failed, or the run rolled back a
deploy. One email a day at most, repeated while an item
remains. Nothing is sent on a healthy day.

Notices are not alerts. A government notice first listed that night, IRCC's
high-wage list adopted or unreadable, or a designated-employer list or news
feed that stopped being read or is read again is a notice: `status.json`
lists it under `notices`, LAST_RUN.md carries it, and the email gives it a
section of its own, one notice a line with its full text. A morning with
notices and no alert still sends an email, with the subject "LMIA Watch: n
notices from the last run". Notices never fail the workflow's last step or
open the run-attention issue, and they come only from a status written in
the last 36 hours.

An open-data portal that cannot be read is a notice for up to two nights in
a row and an item from the third. When open.canada.ca times out, answers
with a server error, or serves a maintenance page where an ESDC listing
should be (or a file download fails the same way), the quarters already
loaded stand and the next run reads the listing again. When so many requests
fail in a row that the run's circuit breaker trips, the run sends the portal
nothing more that night and counts it the same way; a list it did not reach
keeps its count. ESDC publishes a new quarter a few times a year, so one
night without the listing changes nothing. The nights are counted for each
list (positive and negative), once per UTC date, and the first night the
list is read in full sets the count back to zero. A notice leaves the run
ok, so the retry triggers do not run the refresh again for it and the
listing is read once a night; a retry that runs for another reason reads it
again without counting a second night. A refusal (404 or 403), a listing
with no English files or a file that does not parse is an item from the
first night.

The check runs at the same time as the first retry (below), so on a morning
after a failed midnight run the email can name a fault that the retry then
fixes. The next day's check is quiet if it did.

### One-time setup (dashboard, since the project token cannot do it)

1. Cloudflare dashboard, the lmiawatch.ca zone, Email, Email Routing, enable
   it (this adds the MX records the zone needs to send).
2. Destination addresses, Add, enter the operator's address, then click the
   verification link in the email Cloudflare sends.
3. From `site/`, with `CLOUDFLARE_API_TOKEN` in the environment:

   ```
   npx wrangler secret put ALERT_EMAIL
   ```

   and paste the same address. The sender is the `ALERT_FROM` variable
   (`alerts@lmiawatch.ca`), which needs no mailbox.

Until steps 1 and 2 are done, the check runs and logs, and sending fails
quietly.

## 2. GitHub's failed-workflow email

The nightly workflow's last step fails the run when any item below needs
attention, after everything else has been saved and recorded. GitHub then
emails the account that owns the repository, provided its notification
settings keep "Actions: failed workflows" on (the default).

The site-only deploy (`deploy-site.yml`, `docs/site-deploy.md`) writes no
run status, so the Worker's daily check never sees it: a site deploy that
did not pass its checks reaches the operator through this email only.

## 3. The run-attention issue

The same last step keeps one open issue titled "Nightly run needs attention",
labelled `run-attention`:

- the first run with items opens it, listing them with a link to the run;
- each later run that still has items replaces the list and adds a comment
  with its own items and link;
- the first run with none closes it with a comment naming that run.

The label is created by the workflow, so there is nothing to set up. The
repository is public, so the issue is too; it holds only what the run's log
already shows. A fault talking to GitHub leaves the issue as it was and is
noted in the step's log; the run still fails, so the email still goes out.

## What the run fixes by itself

**Same-day retry.** Besides midnight UTC, the workflow is scheduled at 06:00
and 12:00 UTC. A first job (`gate`) reads `status.json` from R2: when it shows
a run that finished today with `ok: true` and a deploy that succeeded, the
retry stops there (the run shows the refresh job as skipped). Otherwise the
whole refresh runs again. Job Bank is crawled again only when the earlier
pass did not complete: the pipeline refuses a second pass within 20 hours of
a complete one. A manual run always goes ahead.

**Rollback after a broken deploy.** Before each deploy the run records the
Worker version serving traffic. After the deploy it fetches the home,
search and data pages and one employer profile, and fetches again 30 seconds
later any page that failed. When a page answers 500 to 599 both times, the
run rolls the Worker back to the recorded version (`wrangler rollback`),
which puts the previous data back with it. The run status then reads
`smoke: broken` and `deploy_rolled_back: true`, the posts and the public files
are held back, the database is still saved, and the next retry deploys again.
When the edge answers 403 or a challenge page (the dashboard's rules can
refuse a cloud address), or the pages answer in some other unexpected way,
the status reads `smoke: unverifiable` and nothing else happens.

**Restore from the weekly snapshot.** When both nightly backups are missing
or damaged, the run lists `backups/weekly/` in R2 and starts from the newest
`db-slot-<n>.sqlite.gz`. `restore.json` and the run status record source
`weekly` and the snapshot's upload time. This is an attention item: the Job
Bank observations made after that snapshot are lost. When a nightly backup
could not be downloaded at all, or the listing fails, the run stops instead,
since a good backup may still be there; the next run tries again. A first run
(nothing in R2 anywhere) still starts from an empty database.

**Expiry checks.** On the first of each month (UTC) the run asks Cloudflare for
the status and expiry date of the deploy token and of the analytics token, and
for the domain's expiry date and auto-renew setting. They are recorded under
`checks` in the run status. A token or the domain inside 30 days of expiry,
or a token that is not active, is an attention item. A check the token is not
allowed to make reads `unknown` and raises nothing: the deploy token has no
registrar permission, so the domain check reads `unknown` until that token is
also given read access to the account's registrar domains.

**HTML check.** Every night the same step fetches the home page as a browser
would (an `Accept` header naming `text/html`, a browser's user agent) and
expects a 200 with the page's ETag and exactly one Web Analytics beacon. A
missing ETag or a second beacon means Cloudflare is rewriting the site's HTML
again, which costs the 304s crawlers rely on (`docs/search-engines.md`,
section 7), and is an attention item. Any other answer (another status, a
challenge, no answer) reads `unknown` and raises nothing; the smoke test
reports a site that does not answer. The result is under `checks.html_rewrite`
in the run status, with `etag`, `beacons` and `content_encoding`.

## What each item means

| Item | Likely cause | What to do |
|---|---|---|
| Data stale | The scheduled run has not completed for days | Open the Actions page; the log of the failed run says which stage |
| Backup missing or old | The R2 save step failed, or the run did not get that far | Same. If the save step's log says the packed database is above the 300 MiB a single upload accepts, nothing was uploaded and R2 keeps the last backup that fit; saving resumes once the backup is split or sent another way (a multipart upload) |
| Stage `jobbank` failed | Job Bank changed its pages or blocked the crawler | Check the run log; the page structure may need a parser update |
| Stage `esdc` failed | The open-data portal changed a file layout | Same |
| Stage `esdc` failed: "the portal has not been readable for N nights" | open.canada.ca timed out, answered with server errors or served a maintenance page in place of an ESDC listing or file, three or more nights in a row | Check open.canada.ca and the two ESDC datasets. If it is their outage there is nothing to fix here: the quarters already loaded stand, and the first night the list is read clears the item |
| X post refused | Credits exhausted, keys revoked, or X down | X developer console: credits and app keys |
| X post unverified | X answered the post with a server error or not at all, and the account's posts could not be read to see whether it went out | Look at the account once. The date is recorded, so no run posts that digest again; a missing post means that pass goes unposted (`docs/x-account.md`) |
| Bluesky post refused | App password revoked, the handle changed without the `BSKY_HANDLE` secret, or Bluesky down | `docs/bluesky-account.md`: make a new app password, update the secrets |
| Zenodo deposit failed | Token revoked or expired, Zenodo down, or a field refused | The run log quotes Zenodo's answer; the next night tries again (`docs/zenodo.md`) |
| Search database sync failed | Wrangler could not apply a batch, or the count read back disagreed | Nothing, usually: the next run sends the changes again (`docs/hosted-search.md`) |
| Audience roll-up failed | The analytics token was revoked, or the SQL API or R2 failed | Check the `CLOUDFLARE_ANALYTICS_TOKEN` secret; the next run catches up |
| Search Console import failed | The service account key was deleted, the account was removed from the property (HTTP 403), or Google or R2 failed | Check the `GSC_SERVICE_ACCOUNT_JSON` secret and the property's users (`docs/search-engines.md`, section 6); the next run catches up |
| Monthly audience report failed | R2 could not be read or written, or the summary could not be read | The run log says which; the next run writes the report |
| IndexNow: rejected; check the key file | The key file at the site's root is missing, refused at the edge, or holds another key than `INDEXNOW_KEY`; or the URLs name another host | Open `https://lmiawatch.ca/<key>.txt`: it must answer 200 with the key as its entire content (`docs/search-engines.md`, section 5). The issue and GitHub's email carry this item; the Worker's daily check does not read it |
| Deploy rolled back | The new Worker answered with server errors | The step "Check the live site" names the pages and codes; the Worker's logs (Workers & Pages, `lmia-watch`, Logs) say why. A code fault needs a fix on `main`; a passing fault clears at the next retry |
| Deploy broken, not rolled back | As above, and no version was recorded before the deploy or the rollback failed | Roll back from the dashboard (Workers & Pages, `lmia-watch`, Deployments) or with `npx wrangler rollback` from `site/` |
| Restored from the weekly snapshot | Both nightly backups were missing or damaged | Find out what removed or damaged them; nothing to restore by hand |
| Expiry check: a token expires or is not active | The token was made with an end date, or was disabled | Make a new token with the same permissions and replace the repository secret |
| Expiry check: the domain expires | The registration is close to its end | Check auto-renew and the payment method in the dashboard's Registrar section |
| Cloudflare is rewriting the site's HTML again | The Web Analytics site was switched to its automatic setup, or Email Obfuscation, Automatic HTTPS Rewrites or Replace insecure JavaScript was turned on | Web Analytics, lmiawatch.ca, Manage site: "Enable with JS Snippet installation"; turn the three zone features off. Check with `curl -sI -H 'Accept: text/html' https://lmiawatch.ca/`, which must show an `etag` |
