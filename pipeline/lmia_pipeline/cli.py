"""Command line: `python -m lmia_pipeline run`, `post-digest`, `post-bluesky`, `deposit-zenodo`,
the search database's `search-sync`, `search-check` and `search-synced`, and the audience
record's `rollup-views`, `import-search-console` and `views-report`."""

from __future__ import annotations

import argparse
import csv
import logging
import sqlite3
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import bluesky, config, export, export_static, indicators, migrate, search_console, search_db, social, status
from . import views_report, views_rollup, zenodo
from .db import connect, hours_since, log_run
from .http import PoliteClient
from .sources import esdc, geography, ircc, jobbank, lfs, program, registry_bc, registry_federal, registry_quebec
from .sources import alberta_records, fmcsa, grants, high_wage, jobbank_intl, notices, registers, vacancies, wages

log = logging.getLogger("lmia_pipeline")
STAGES = ["esdc", "ircc", "jobbank", "highwage", "intl", "registry", "grants", "alberta", "fmcsa", "registers", "notices",
          "wages", "lfs", "vacancies", "program", "geography", "indicators", "export"]

# Job Bank is crawled once a day and no more. A re-run of a failed night, or a
# run started by hand, must not send a second pass; the guard is in the
# pipeline so no scheduler or operator mistake can bypass it without --force.
JOBBANK_MIN_HOURS = 20.0


def jobbank_allowed(conn: sqlite3.Connection, *, force: bool = False) -> tuple[bool, str]:
    if force:
        return True, "forced"
    hours = hours_since(conn, "jobbank_last_run")
    if hours is not None and hours < JOBBANK_MIN_HOURS:
        return False, f"last Job Bank pass was {hours:.1f} h ago; the daily pass has already happened"
    return True, "ok"


def load_fsa_centroids(conn: sqlite3.Connection, path: Path | None = None) -> int:
    src = path or (config.PACKAGE_DATA / "fsa_centroids.csv")
    if not src.exists():
        return 0
    n = 0
    with src.open(encoding="utf-8") as fh:
        rows = [line for line in fh if not line.startswith("#")]
    for row in csv.DictReader(rows):
        try:
            conn.execute(
                "INSERT OR REPLACE INTO fsa_centroids (fsa, province, lat, lon) VALUES (?, ?, ?, ?)",
                (row["fsa"].strip().upper(), row["province"].strip().upper(), float(row["lat"]), float(row["lon"])),
            )
            n += 1
        except (KeyError, ValueError):
            continue
    conn.commit()
    return n


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lmia_pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="collect, merge, compute and export")
    for stage in STAGES:
        run.add_argument(f"--{stage}", action="store_true", help=f"run only the {stage} stage (combinable)")
    run.add_argument("--limit", type=int, default=None, help="Job Bank list pages per facet (dev runs)")
    run.add_argument("--force", action="store_true", help="crawl Job Bank even if a pass ran in the last 20 hours (dev only)")
    run.add_argument("--detail-budget", type=int, default=600, help="Job Bank posting pages per run")
    run.add_argument("--intl-detail-budget", type=int, default=jobbank_intl.DEFAULT_DETAIL_BUDGET,
                     help="posting pages per run for the postings open to international candidates")
    run.add_argument("--registry-budget", type=int, default=registry_bc.DEFAULT_BUDGET,
                     help="OrgBook lookups per run (also capped at 15 minutes)")
    run.add_argument("--db", default=None, help="SQLite path (default data/lmia.sqlite)")

    pd = sub.add_parser("post-digest", help="post the daily digest of new postings to X")
    pd.add_argument("--db", default=None, help="SQLite path (default data/lmia.sqlite)")
    pd.add_argument("--dry-run", action="store_true", help="print the post and send nothing")
    pd.add_argument("--link", action="store_true", help="include the site link (X bills a post with a link at thirteen times the rate)")
    pd.add_argument("--no-image", action="store_true", help="post the text without the card image")

    pb = sub.add_parser("post-bluesky", help="post the daily digest of new postings to Bluesky")
    pb.add_argument("--db", default=None, help="SQLite path (default data/lmia.sqlite)")
    pb.add_argument("--dry-run", action="store_true", help="print the post and send nothing")
    pb.add_argument("--no-image", action="store_true", help="post the text without the card image")

    dz = sub.add_parser("deposit-zenodo", help="deposit the OGL files on Zenodo when a new ESDC quarter is loaded")
    dz.add_argument("--db", default=None, help="SQLite path (default data/lmia.sqlite)")
    dz.add_argument("--csv-dir", default=None, help="the CSV export (default data/out/csv)")
    dz.add_argument("--dry-run", action="store_true", help="check the files and print what would be deposited")

    # The search database's nightly sync (search_db.py, docs/hosted-search.md):
    # search-sync writes the batches, the workflow applies them with Wrangler
    # and reads the row count back, search-check compares it, and only then
    # search-synced records the ledger.
    ss = sub.add_parser("search-sync", help="write the search database's changed rows as SQL batches and a manifest")
    ss.add_argument("--db", default=None, help="SQLite path (default data/lmia.sqlite)")
    ss.add_argument("--out", default=None, help="folder for the batches and manifest.json (default data/out/search)")
    ss.add_argument("--full", action="store_true", help="a full reload: drop and recreate the tables, then send every row")
    sd = sub.add_parser("search-synced", help="record the ledger entries of a manifest whose batches were all applied")
    sd.add_argument("--db", default=None, help="SQLite path (default data/lmia.sqlite)")
    sd.add_argument("--manifest", required=True)
    sc = sub.add_parser("search-check", help="compare the row count read back from D1 with the manifest's expected total")
    sc.add_argument("--manifest", required=True)
    sc.add_argument("--count", type=int, required=True, help="SELECT COUNT(*) FROM search_rows, as D1 answered it")
    sc.add_argument("--db", default=None,
                    help="SQLite path; when given, a mismatch is noted there so a coming sync reloads in full")

    # The audience counts (views_rollup.py, docs/search-engines.md section 6):
    # the days Analytics Engine still holds and summary.csv lacks, as files
    # the workflow uploads to R2. Needs CLOUDFLARE_ANALYTICS_TOKEN and
    # CLOUDFLARE_ACCOUNT_ID; without the token it does nothing.
    rv = sub.add_parser("rollup-views", help="save the audience counts of finished UTC days as CSV files")
    rv.add_argument("--out", default=None,
                    help="folder holding summary.csv; the day files go beside it (default data/out/views)")
    rv.add_argument("--day", default=None,
                    help="roll up this UTC day only (YYYY-MM-DD, within the last 90 days); default: every day due")
    rv.add_argument("--stats", default=None,
                    help="tonight's stats.json, for the employer and record counts (default data/out/static/stats.json)")

    # Search Console's figures (search_console.py, docs/search-engines.md
    # section 6): every final day after the newest in search_console.csv.
    # Needs GSC_SERVICE_ACCOUNT_JSON; without it the outcome is "no credentials".
    gs = sub.add_parser("import-search-console", help="append Search Console's daily figures to search_console.csv")
    gs.add_argument("--out", default=None,
                    help="folder holding search_console.csv; outcome.txt goes beside it (default data/out/search_console)")

    # The monthly audience report (views_report.py), from the files in R2.
    vp = sub.add_parser("views-report", help="write the audience report of a finished UTC month")
    vp.add_argument("--month", default=None, help="YYYY-MM (default: the month before today, UTC)")
    vp.add_argument("--summary", required=True, help="views/summary.csv as downloaded from R2")
    vp.add_argument("--search", default=None, help="views/search_console.csv as downloaded from R2, when it exists")
    vp.add_argument("--worker-cpu", default=None, help="metrics/worker_cpu.csv as downloaded from R2, when it exists")
    vp.add_argument("--out", required=True, help="folder for report-<month>.md, summary_line.txt and outcome.txt")
    vp.add_argument("--today", default=None, help="YYYY-MM-DD (default: today, UTC)")
    return parser


def _outcome_file(folder: str, name: str, outcome: str) -> None:
    out = config.OUT_DIR / folder
    out.mkdir(parents=True, exist_ok=True)
    (out / name).write_text(outcome + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = build_parser().parse_args(argv)
    # Every stage reports its own failure; this catches what is left (a
    # database that will not open, a full disk) so the workflow always gets an
    # exit code and a log line rather than a traceback from the interpreter.
    try:
        return _main(args)
    except Exception:
        log.exception("%s stopped", args.command)
        return 2


def _main(args: argparse.Namespace) -> int:
    # Needs no database unless the count disagrees.
    if args.command == "search-check":
        return _search_check(args)
    # Reads only the API and its own files.
    if args.command == "rollup-views":
        return _rollup_views(args)
    if args.command == "import-search-console":
        return _import_search_console(args)
    if args.command == "views-report":
        return _views_report(args)
    conn = connect(args.db)
    try:
        return _command(conn, args)
    finally:
        # Closing folds the write-ahead log into the database file, which is
        # the file the workflow compresses and saves.
        conn.close()


def _command(conn: sqlite3.Connection, args: argparse.Namespace) -> int:

    if args.command == "post-digest":
        outcome = social.run(conn, dry_run=args.dry_run, link=args.link, image=not args.no_image)
        log.info("post-digest: %s", outcome)
        # The outcome is written for the workflow to record, and a failure (or a
        # post X may or may not have made, "unverified") exits 1 so the step shows
        # red in the run; the workflow itself carries on, since the post is
        # optional and the data save is not.
        out = config.OUT_DIR / "social"
        out.mkdir(parents=True, exist_ok=True)
        (out / "last_outcome.txt").write_text(outcome + "\n", encoding="utf-8")
        return 1 if outcome in ("failed", "no credentials", "unverified") else 0

    # Same shape as post-digest. "failed" is written first and replaced by the
    # real outcome at the end, so a step the workflow kills part way (its time
    # limit) still reads as failed in the run status.
    if args.command == "post-bluesky":
        _outcome_file("social", "bluesky_outcome.txt", "failed")
        outcome = bluesky.run(conn, dry_run=args.dry_run, image=not args.no_image)
        log.info("post-bluesky: %s", outcome)
        _outcome_file("social", "bluesky_outcome.txt", outcome)
        return 1 if outcome in ("failed", "no credentials") else 0

    if args.command == "deposit-zenodo":
        _outcome_file("zenodo", "last_outcome.txt", "failed")
        outcome = zenodo.run(conn, Path(args.csv_dir) if args.csv_dir else None, dry_run=args.dry_run)
        log.info("deposit-zenodo: %s", outcome)
        _outcome_file("zenodo", "last_outcome.txt", outcome)
        return 1 if outcome == "failed" else 0

    # "failed" is written first and replaced only by search-synced, the last
    # command of the sync, so a night that stops anywhere in between (a
    # batch Wrangler could not apply, a count that disagrees, the step's time
    # limit) reads as failed in the run status.
    if args.command == "search-sync":
        _outcome_file("search", search_db.OUTCOME, "failed")
        manifest = search_db.sync(conn, Path(args.out) if args.out else None, full=args.full)
        kind = f"full reload ({manifest['reason']})" if manifest["full"] else "changes only"
        summary = (f"search-sync: {kind}: {manifest['upserts']} upserts, {manifest['deletes']} deletes, "
                   f"{len(manifest['batches'])} batches, {manifest['bytes']} bytes, "
                   f"{manifest['expected_total']} rows expected afterwards")
        log.info("%s", summary)
        print(summary)
        return 0

    if args.command == "search-synced":
        manifest = search_db.read_manifest(Path(args.manifest))
        counts = search_db.record_sync(conn, manifest)
        outcome = "synced" if manifest["batches"] else "nothing to send"
        log.info("search-synced: %s, ledger %s", outcome, counts)
        _outcome_file("search", search_db.OUTCOME, outcome)
        return 0

    selected = [s for s in STAGES if getattr(args, s)]
    stages = selected or STAGES
    client = PoliteClient()
    ok = True

    # Employer ids are derived from normalized names; when the normalization
    # changed since this database was built, re-derive them once before any
    # stage writes under the new rules.
    report = migrate.ensure_current(conn)
    if report is not None:
        log.info("employer ids re-derived: %s", report)

    log.info("fsa centroids loaded: %d", load_fsa_centroids(conn))

    if "esdc" in stages:
        ok &= _stage(conn, "esdc", lambda: esdc.run(conn, client))
    if "ircc" in stages:
        ok &= _stage(conn, "ircc", lambda: ircc.run(conn, client), "new findings")
    if "jobbank" in stages:
        allowed, reason = jobbank_allowed(conn, force=args.force)
        if not allowed:
            log.info("jobbank skipped: %s", reason)
            log_run(conn, "jobbank", detail=f"skipped: {reason}")
            stages = [s for s in stages if s != "jobbank"]
    if "jobbank" in stages:
        ok &= _stage(
            conn, "jobbank", lambda: jobbank.run(conn, client, limit=args.limit, detail_budget=args.detail_budget),
            failed_when=lambda stats: bool(stats.problems),
        )
    # IRCC's high-wage list: adopted when it changed and passes the checks (the
    # grades follow it from tonight); a change, or a page that cannot be read,
    # is a notice, never a failed stage. Before the international-candidates
    # pass, which grades with it.
    if "highwage" in stages:
        ok &= _stage(conn, "high_wage", lambda: high_wage.run(conn, client),
                     describe=lambda diff: high_wage.summary(diff, len(high_wage.points_by_noc(conn))))
    # Postings open to international candidates (sources/jobbank_intl.py):
    # after the LMIA crawl, whose flags it joins, through the same client so
    # the crawl delay holds across both. Its own once-a-day guard.
    if "intl" in stages:
        allowed, reason = jobbank_intl.allowed(conn, force=args.force)
        if not allowed:
            log.info("jobbank_intl skipped: %s", reason)
            log_run(conn, "jobbank_intl", detail=f"skipped: {reason}")
            _outcome_file("intl", "last_outcome.txt", f"skipped: {reason}")
        else:
            _outcome_file("intl", "last_outcome.txt", "failed")
            ok &= _stage(
                conn, "jobbank_intl",
                lambda: _with_outcome("intl", jobbank_intl.run(
                    conn, client, detail_budget=args.intl_detail_budget, limit=args.limit)),
                failed_when=lambda stats: bool(stats.problems),
            )
    if "registry" in stages:
        ok &= _stage(conn, "registry", lambda: registry_bc.run(conn, client, budget=args.registry_budget), "matches")
        # A 260 MB download can fail; the rest of the night still runs.
        ok &= _stage(conn, "registry_federal", lambda: registry_federal.run(conn, client), "matches")
        # Same for the 270 MB Quebec extract.
        ok &= _stage(conn, "registry_quebec", lambda: registry_quebec.run(conn, client), "matches")
    # Public records shown on profiles; none of them feeds the indicators.
    # Each downloads on its own cadence (grants quarterly, the Alberta
    # workbook when it changes, the carrier census monthly) and matches every
    # night, so a download that fails leaves last time's records matched.
    # The grants match reads the business numbers the federal registry stage
    # stores, so it runs after the registries.
    if "grants" in stages:
        ok &= _stage(conn, "grants", lambda: grants.run(conn, client), "matches")
    if "alberta" in stages:
        ok &= _stage(conn, "alberta_records", lambda: alberta_records.run(conn, client), "matches")
    if "fmcsa" in stages:
        ok &= _stage(conn, "fmcsa", lambda: fmcsa.run(conn, client), "matches")
    # Designated-employer lists (sources/registers.py), with a client of its
    # own: many small hosts, fewer retries, and their failures kept out of
    # the shared client's circuit breaker (the intermediate certificate one
    # host leaves out is trusted in that client only, for that host). A list
    # that fails is a notice and keeps its last rows, so this stage itself
    # fails only on an exception; a newer edition of a list loaded by hand is
    # an item needing attention through the run status. The copies loaded by
    # hand are read from the site's private R2 bucket with the run's token.
    if "registers" in stages:
        _outcome_file("registers", "last_outcome.txt", "failed")
        ok &= _stage(conn, "registers", lambda: _with_outcome(
            "registers", registers.run(conn, registers.make_client(), snapshots=registers.r2_snapshots())), "lists")
    # Government notices (sources/notices.py): the IRCC and ESDC news feeds on
    # Canada.ca, one request each, through a client of its own like the lists
    # above. A feed that cannot be read keeps its items and is a notice, and
    # each item first listed tonight is a notice; the stage fails only on an
    # exception.
    if "notices" in stages:
        _outcome_file("notices", "last_outcome.txt", "failed")
        ok &= _stage(conn, "gov_notices", lambda: _with_outcome(
            "notices", notices.run(conn, PoliteClient(max_attempts=notices.CLIENT_ATTEMPTS))), "listed")
    # The reference tables for the wage and unemployment indicators. Each is
    # cached: wages and the LFS table are revalidated at most once a month,
    # the boundary files never after the first load. A failure leaves the
    # previous table in place and the indicators say what is missing.
    if "wages" in stages:
        ok &= _stage(conn, "wages", lambda: wages.run(conn, client), "rows loaded")
    if "lfs" in stages:
        ok &= _stage(conn, "lfs", lambda: lfs.run(conn, client), "rows loaded")
    if "vacancies" in stages:
        ok &= _stage(conn, "vacancies", lambda: vacancies.run(conn, client), "rows loaded")
    # The program's own pages on canada.ca: processing times, the low-wage
    # refusal list by CMA, the wage thresholds. One stage per page, so a page
    # whose layout changed fails alone and leaves its stored editions as they
    # were; before the indicators, which read the CMA lists.
    if "program" in stages:
        ok &= _stage(conn, "program_times", lambda: program.run_times(conn, client), "editions added")
        ok &= _stage(conn, "program_cma", lambda: program.run_cma(conn, client), "editions added")
        ok &= _stage(conn, "program_thresholds", lambda: program.run_thresholds(conn, client), "editions added")
    if "geography" in stages:
        # The boundary service answers some requests with HTTP 500 and the
        # next attempt succeeds, so this client retries more before giving up.
        ok &= _stage(conn, "geography", lambda: geography.run(conn, PoliteClient(max_attempts=geography.MAX_ATTEMPTS)),
                     "areas placed")
    # A failure here leaves the previous indicator states and statuses in the
    # database, which are consistent with each other, so the export still runs
    # and the site keeps its last good figures for them.
    if "indicators" in stages or "export" in stages or not selected:
        ok &= _stage(conn, "indicators", lambda: indicators.compute(conn), "changed")
        ok &= _stage(conn, "status", lambda: status.recompute(conn), "employers updated")
    if "export" in stages:
        ok &= _stage(conn, "export_csv", lambda: export.export_csv(conn), "csv rows")
        ok &= _stage(conn, "export_mirror", lambda: export.export_mirror(conn), "mirror files")
        ok &= _stage(conn, "export", lambda: export_static.export_static(conn), "static files")
    return 0 if ok else 1


def _with_outcome(folder: str, stats: Any) -> Any:
    """Write a stage's one-line summary for the workflow's LAST_RUN.md, then pass the stats on."""
    _outcome_file(folder, "last_outcome.txt", stats.summary())
    return stats


def _rollup_views(args: argparse.Namespace) -> int:
    """Exit 1 only when the roll-up failed. The workflow writes the outcome
    for the run status itself, after the uploads, because a night counts as
    rolled up only once its files are in R2."""
    day = date.fromisoformat(args.day) if args.day else None
    outcome = views_rollup.run(Path(args.out) if args.out else None, day=day,
                               stats_path=Path(args.stats) if args.stats else None)
    log.info("rollup-views: %s", outcome)
    print(f"rollup-views: {outcome}")
    return 1 if outcome == "failed" else 0


def _import_search_console(args: argparse.Namespace) -> int:
    """Exit 1 only when the import failed. outcome.txt holds the outcome for the
    workflow, which reports it once the file is in R2."""
    folder = Path(args.out) if args.out else config.OUT_DIR / "search_console"
    outcome = search_console.run(folder)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "outcome.txt").write_text(outcome + "\n", encoding="utf-8")
    log.info("import-search-console: %s", outcome)
    print(f"import-search-console: {outcome}")
    return 1 if outcome == "failed" else 0


def _views_report(args: argparse.Namespace) -> int:
    """Exit 1 only when the report failed; "waiting" and "no data" are not failures."""
    today = date.fromisoformat(args.today) if args.today else datetime.now(timezone.utc).date()
    month = args.month or views_report.report_month(today)
    out = Path(args.out)
    outcome = views_report.run(out, month, today, Path(args.summary), Path(args.search) if args.search else None,
                               Path(args.worker_cpu) if args.worker_cpu else None)
    out.mkdir(parents=True, exist_ok=True)
    (out / "outcome.txt").write_text(outcome + "\n", encoding="utf-8")
    log.info("views-report %s: %s", month, outcome)
    print(f"views-report {month}: {outcome}")
    return 1 if outcome == "failed" else 0


def _search_check(args: argparse.Namespace) -> int:
    """Exit 1 when D1's row count differs from the manifest's expected total.

    The workflow then leaves the ledger unrecorded, so the next night sends
    the same changes again; with --db the mismatch is also noted, so a coming
    sync reloads in full, which removes rows a resend cannot (search_db).
    """
    manifest = search_db.read_manifest(Path(args.manifest))
    problem = search_db.count_check(int(manifest["expected_total"]), args.count)
    if problem is None:
        log.info("search-check: %d rows, as the manifest expects", args.count)
        return 0
    log.error("search-check: %s", problem)
    if args.db:
        conn = connect(args.db)
        try:
            search_db.request_reload(conn)
        finally:
            conn.close()
    return 1


def _stage(
    conn: sqlite3.Connection,
    source: str,
    fn: Callable[[], Any],
    label: str = "",
    *,
    failed_when: Callable[[Any], bool] | None = None,
    describe: Callable[[Any], str] | None = None,
) -> bool:
    """Run one stage. Any exception is logged, recorded in sources_log (which
    is what the run status reports) and returned as False, so the stages after
    it still run and nothing propagates out of main. Work the stage left
    uncommitted is rolled back rather than committed by the log row. describe,
    where given, writes the log line from the result in place of the repr."""
    try:
        result = fn()
    except Exception as exc:
        log.exception("%s failed", source)
        try:
            conn.rollback()
            log_run(conn, source, detail=f"{type(exc).__name__}: {exc}"[:900], ok=False)
        except sqlite3.Error as db_exc:
            log.error("%s: the failure could not be recorded: %s", source, db_exc)
        return False
    line = None
    if describe:
        try:
            line = describe(result)
        except Exception as exc:  # a log line never fails a stage that ran
            log.warning("%s: the log line could not be written: %s", source, exc)
    if line:
        log.info("%s", line)
    else:
        log.info("%s%s: %s", source, f" {label}" if label else "", result)
    return not (failed_when and failed_when(result))


if __name__ == "__main__":
    sys.exit(main())
