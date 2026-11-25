"""The workflow's restore decision, its checks before deploy and save, and the status file."""

import gzip
import json
import os
import re
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests

from lmia_pipeline import nightly
from lmia_pipeline import worker_metrics as wm
from lmia_pipeline.db import connect, log_run, upsert_employer

NOW = "2026-10-18T00:00:00Z"


def make_db(path, employers=3, postings=2):
    conn = connect(path)
    for i in range(employers):
        eid = upsert_employer(conn, f"Employer {i} Ltd", "BC", source="jobbank", now=NOW)
        if i < postings:
            conn.execute(
                "INSERT INTO jobbank_postings (posting_id, employer_id, employer_raw, first_seen, last_seen, flag_current, "
                "flag_first, url, updated_at) VALUES (?, ?, 'x', ?, ?, 'requested', 'requested', 'u', ?)",
                (i + 1, eid, NOW, NOW, NOW),
            )
    conn.commit()
    conn.close()


def download(folder, key, *, body=None, exit_code=0, log=""):
    folder.mkdir(parents=True, exist_ok=True)
    if body is not None:
        (folder / key).write_bytes(body)
    (folder / f"{key}.exit").write_text(str(exit_code), encoding="utf-8")
    (folder / f"{key}.log").write_text(log, encoding="utf-8")


def gz_of(path) -> bytes:
    return gzip.compress(path.read_bytes())


MISSING = 'Downloading "lmia.sqlite.gz"\n✘ [ERROR] The specified key does not exist.\n'


# -- restore ------------------------------------------------------------------


def test_first_run_starts_empty_only_when_no_backup_exists(tmp_path):
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, body=b"", exit_code=1, log=MISSING)
    download(folder, nightly.PREVIOUS, exit_code=1, log=MISSING)
    ok, source, message, counts = nightly.restore(folder, tmp_path / "lmia.sqlite")
    assert (ok, source) == (True, "none") and "first run" in message
    assert not (tmp_path / "lmia.sqlite").exists()


def test_an_outage_stops_the_run_instead_of_starting_empty(tmp_path):
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, exit_code=1, log="✘ [ERROR] A request to the Cloudflare API failed. (503)")
    download(folder, nightly.PREVIOUS, exit_code=1, log=MISSING)
    ok, source, message, _ = nightly.restore(folder, tmp_path / "lmia.sqlite")
    assert not ok and "download failed" in message and "503" in message


def test_a_good_backup_is_restored_with_its_counts(tmp_path):
    src = tmp_path / "src.sqlite"
    make_db(src)
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, body=gz_of(src))
    download(folder, nightly.PREVIOUS, exit_code=1, log=MISSING)
    ok, source, _, counts = nightly.restore(folder, tmp_path / "lmia.sqlite")
    assert (ok, source) == (True, "backup")
    assert counts["employers"] == 3 and counts["jobbank_postings"] == 2


@pytest.mark.parametrize("damage", ["truncated", "not gzip", "not sqlite"])
def test_a_damaged_backup_falls_back_to_the_previous_one(tmp_path, damage):
    src = tmp_path / "src.sqlite"
    make_db(src)
    good = gz_of(src)
    bad = {"truncated": good[: len(good) // 2], "not gzip": b"<html>oops</html>", "not sqlite": gzip.compress(b"x" * 5000)}[damage]
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, body=bad)
    download(folder, nightly.PREVIOUS, body=good)
    ok, source, _, _ = nightly.restore(folder, tmp_path / "lmia.sqlite")
    assert (ok, source) == (True, "previous")


def test_both_backups_damaged_stops_the_run(tmp_path):
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, body=b"\x1f\x8b broken")
    download(folder, nightly.PREVIOUS, body=b"\x1f\x8b broken")
    ok, _, message, _ = nightly.restore(folder, tmp_path / "lmia.sqlite")
    assert not ok and "gzip" in message
    assert not (tmp_path / "lmia.sqlite").exists()


def test_restore_command_writes_its_record_and_exit_code(tmp_path):
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, exit_code=1, log="network unreachable")
    download(folder, nightly.PREVIOUS, exit_code=1, log=MISSING)
    out = tmp_path / "restore.json"
    assert nightly.main(["restore", "--dir", str(folder), "--db", str(tmp_path / "lmia.sqlite"), "--out", str(out)]) == 1
    assert json.loads(out.read_text())["source"] == "none"


# -- verify -------------------------------------------------------------------


def write_export(static, employers=3, mtime=None):
    (static / "search" / "latest" / "status").mkdir(parents=True)
    (static / "profiles").mkdir()
    (static / "sitemaps").mkdir()
    (static / "stats.json").write_text(json.dumps({"data_as_of": "2026-10-18", "counts": {"employers": employers}}))
    (static / "search" / "first.json").write_text("[]")
    (static / "search" / "latest" / "status" / "pending.json").write_text("[]")
    (static / "search" / "facets.json").write_text("{}")
    (static / "profiles" / "a00.json").write_text("{}")
    (static / "sitemaps" / "index.xml").write_text("<sitemapindex/>")
    if mtime is not None:
        os.utime(static / "stats.json", (mtime, mtime))


def test_a_sound_database_and_export_pass(tmp_path):
    db = tmp_path / "lmia.sqlite"
    make_db(db)
    write_export(tmp_path / "static")
    result = nightly.verify(db, tmp_path / "static", time.time() - 60, {"employers": 3, "jobbank_postings": 2})
    assert result["db_ok"] and result["export_ok"] and result["problems"] == []


def test_a_database_that_lost_rows_is_not_saved(tmp_path):
    db = tmp_path / "lmia.sqlite"
    make_db(db, employers=3, postings=1)
    problems, _ = nightly.check_db(db, {"employers": 3, "jobbank_postings": 2})
    assert problems == ["jobbank_postings fell from 2 to 1 rows"]
    empty = tmp_path / "empty.sqlite"
    connect(empty).close()
    problems, _ = nightly.check_db(empty, {"employers": 166000, "jobbank_postings": 4000, "esdc_records": 474000})
    assert len(problems) == 3


def test_a_missing_or_corrupt_database_is_not_saved(tmp_path):
    assert nightly.check_db(tmp_path / "nope.sqlite")[0] == ["the database file is missing or empty"]
    bad = tmp_path / "bad.sqlite"
    bad.write_bytes(b"SQLite format 3\x00" + b"\x00" * 50 + b"garbage" * 500)
    problems, _ = nightly.check_db(bad)
    assert problems and ("integrity" in problems[0] or "cannot be read" in problems[0])


def test_an_export_left_from_an_earlier_run_or_empty_is_not_deployed(tmp_path):
    static = tmp_path / "static"
    write_export(static, mtime=time.time() - 86400)
    assert "left over from an earlier run" in nightly.check_export(static, time.time())[0]
    assert nightly.check_export(tmp_path / "none", None) == ["no export was written"]
    empty = tmp_path / "empty"
    write_export(empty, employers=0)
    assert "counts no employers" in " ".join(nightly.check_export(empty, None))
    shrunk = tmp_path / "shrunk"
    write_export(shrunk, employers=10)
    assert "down from 166000" in " ".join(nightly.check_export(shrunk, None, before_employers=166000))


def test_a_truncated_file_or_too_many_files_is_not_deployed(tmp_path, monkeypatch):
    static = tmp_path / "static"
    write_export(static)
    (static / "search" / "latest" / "status" / "pending.json").write_text('[{"employer":')
    assert any("pending.json cannot be read" in p for p in nightly.check_export(static, None))
    monkeypatch.setattr(nightly, "MAX_FILES", 3)
    assert any("more than the 3" in p for p in nightly.check_export(static, None))


def test_verify_command_writes_outputs_for_the_workflow(tmp_path, monkeypatch):
    db = tmp_path / "lmia.sqlite"
    make_db(db)
    write_export(tmp_path / "static")
    started = tmp_path / "run_started.txt"
    started.write_text(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    restore = tmp_path / "restore.json"
    restore.write_text(json.dumps({"source": "backup", "counts": {"employers": 3}}))
    gh = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(gh))
    out = tmp_path / "verify.json"
    assert nightly.main(["verify", "--db", str(db), "--static", str(tmp_path / "static"), "--started-file", str(started),
                         "--restore", str(restore), "--out", str(out)]) == 0
    assert gh.read_text() == "db_ok=true\nexport_ok=true\n"
    # With the export missing, the database is still saved and nothing is deployed.
    gh.unlink()
    assert nightly.main(["verify", "--db", str(db), "--static", str(tmp_path / "gone"), "--out", str(out)]) == 0
    assert gh.read_text() == "db_ok=true\nexport_ok=false\n"


# -- status -------------------------------------------------------------------


def test_status_lists_the_run_rows_failed_steps_and_checks(tmp_path):
    db = tmp_path / "lmia.sqlite"
    make_db(db)
    conn = connect(db)
    log_run(conn, "esdc", detail="positive=0 negative=0")
    log_run(conn, "jobbank", detail="problems=requested page 2: HTTP 410", ok=False)
    conn.close()
    status = nightly.run_status(db, "2000-01-01T00:00:00Z", {"problems": ["stats.json counts no employers"]}, "posted",
                                {"restore": "success", "pipeline": "failure", "deploy": "skipped", "save_db": "cancelled"})
    sources = [(s["source"], s["ok"]) for s in status["stages"]]
    assert ("workflow pipeline", False) in sources and ("workflow save_db", False) in sources
    assert ("esdc", True) in sources and ("jobbank", False) in sources and ("checks", False) in sources
    assert status["x_post"] == "posted" and status["ok"] is False


def test_status_is_written_even_when_nothing_ran(tmp_path):
    status = nightly.run_status(tmp_path / "missing.sqlite", None, None, None, {"restore": "failure"})
    assert status["stages"] == [{"source": "workflow restore", "ok": False, "detail": nightly.STEP_DETAIL["restore"]}]
    assert status["x_post"] == "not run" and status["ok"] is False
    out = tmp_path / "status.json"
    assert nightly.main(["status", "--db", str(tmp_path / "missing.sqlite"), "--started-file", str(tmp_path / "nope"),
                         "--verify", str(tmp_path / "nope"), "--outcome", str(tmp_path / "nope"),
                         "--step", "restore=failure", "--step", "pipeline=skipped", "--out", str(out)]) == 0
    written = json.loads(out.read_text())
    assert written["ok"] is False and written["run_at"]
    # The status writer never creates a database where there was none.
    assert not (tmp_path / "missing.sqlite").exists()


def test_status_carries_the_bluesky_post_and_zenodo_deposit_beside_the_x_post(tmp_path):
    db = tmp_path / "lmia.sqlite"
    make_db(db)
    status = nightly.run_status(db, "2000-01-01T00:00:00Z", {"problems": []}, "posted", {"deploy": "success"},
                                bluesky="failed", zenodo="deposited")
    assert (status["x_post"], status["bluesky_post"], status["zenodo_deposit"]) == ("posted", "failed", "deposited")
    # A refused post or a failed deposit is an alert of its own, never a failed refresh.
    assert status["ok"] is True
    missing = nightly.run_status(db, None, None, None, {})
    assert (missing["bluesky_post"], missing["zenodo_deposit"]) == ("not run", "not run")
    social = tmp_path / "social"
    social.mkdir()
    (social / "bluesky_outcome.txt").write_text("no credentials\n", encoding="utf-8")
    (tmp_path / "zenodo.txt").write_text("failed\n", encoding="utf-8")
    out = tmp_path / "status.json"
    assert nightly.main(["status", "--db", str(db), "--outcome", str(social / "last_outcome.txt"),
                         "--bluesky-outcome", str(social / "bluesky_outcome.txt"),
                         "--zenodo-outcome", str(tmp_path / "zenodo.txt"), "--out", str(out)]) == 0
    written = json.loads(out.read_text())
    assert (written["x_post"], written["bluesky_post"], written["zenodo_deposit"]) == ("not run", "no credentials", "failed")
    # Without the new arguments (an older workflow), the fields still appear.
    assert nightly.main(["status", "--db", str(db), "--out", str(out)]) == 0
    assert json.loads(out.read_text())["bluesky_post"] == "not run"


def test_a_clean_night_reports_ok(tmp_path):
    db = tmp_path / "lmia.sqlite"
    make_db(db)
    conn = connect(db)
    log_run(conn, "export", detail="static {}")
    conn.close()
    status = nightly.run_status(db, "2000-01-01T00:00:00Z", {"problems": []}, "no new postings",
                                {"restore": "success", "pipeline": "success", "deploy": "success"})
    assert status["ok"] is True and [s["source"] for s in status["stages"]] == ["export"]


# -- pack ---------------------------------------------------------------------


def seed_for_pack(path, employers=300):
    """A database built from the schema, with rows in the tables the indexes cover."""
    make_db(path, employers=employers, postings=employers // 3)
    conn = connect(path)
    ids = [r[0] for r in conn.execute("SELECT id FROM employers ORDER BY id")]
    conn.executemany(
        "INSERT INTO esdc_records (list, period, employer_id, employer_raw, province, noc_code, positions, resource_id, row_hash) "
        "VALUES ('positive', '2026Q1', ?, 'x', 'BC', '85100', 3, 'res', ?)",
        [(eid, f"h{i}") for i, eid in enumerate(ids)],
    )
    conn.commit()
    conn.close()


def counts_of(path) -> dict[str, int]:
    conn = sqlite3.connect(str(path))
    try:
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
        return {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
    finally:
        conn.close()


def indexes_of(path) -> tuple[set[str], set[str]]:
    """(secondary indexes, automatic indexes of keys and UNIQUE constraints)."""
    conn = sqlite3.connect(str(path))
    try:
        rows = conn.execute("SELECT name, sql FROM sqlite_master WHERE type = 'index'").fetchall()
    finally:
        conn.close()
    return {n for n, sql in rows if sql}, {n for n, sql in rows if not sql}


def gunzip_to(src, dest):
    dest.write_bytes(gzip.decompress(src.read_bytes()))
    return dest


def test_the_schema_names_twenty_secondary_indexes_and_no_unique_one():
    names = nightly.schema_indexes()
    assert len(names) == len(set(names)) == 20
    assert "idx_employers_norm" in names and "idx_donations_received" in names
    assert "idx_intl_employer" in names and "idx_intl_facet_date" in names


def test_pack_drops_the_secondary_indexes_and_a_restored_copy_gets_them_back(tmp_path):
    db = tmp_path / "lmia.sqlite"
    seed_for_pack(db)
    # A write the job's time limit cut off before a checkpoint: committed, but
    # only in the write-ahead log beside the file.
    writer = connect(db)
    writer.execute("PRAGMA wal_autocheckpoint = 0")
    upsert_employer(writer, "Late Writer Ltd", "AB", source="jobbank", now=NOW)
    writer.commit()
    try:
        before = counts_of(db)
        secondary, automatic = indexes_of(db)
        assert len(secondary) == 20 and automatic
        # A gzip of the file alone would lose the late row.
        (tmp_path / "alone.gz").write_bytes(gz_of(db))
        alone = counts_of(gunzip_to(tmp_path / "alone.gz", tmp_path / "alone.sqlite"))
        assert alone["employers"] == before["employers"] - 1

        out = tmp_path / "out" / "lmia.sqlite.gz"
        ok, message, sizes = nightly.pack(db, out)
    finally:
        writer.close()
    assert ok, message
    assert "20 secondary indexes" in message and "lmia.sqlite.gz" in message
    assert sizes["copy"] < sizes["db"] + sizes["wal"] and 0 < sizes["gz"] < sizes["copy"]
    # Only the gzip is left behind; the working copy is gone.
    assert sorted(p.name for p in out.parent.iterdir()) == ["lmia.sqlite.gz"]

    restored = gunzip_to(out, tmp_path / "restored.sqlite")
    packed_secondary, packed_automatic = indexes_of(restored)
    assert packed_secondary == set() and packed_automatic == automatic
    conn = sqlite3.connect(str(restored))
    assert [r[0] for r in conn.execute("PRAGMA quick_check")] == ["ok"]
    conn.close()
    assert counts_of(restored) == before
    # The pipeline's first open re-applies schema.sql, which builds every index again.
    connect(restored).close()
    assert indexes_of(restored) == (secondary, automatic)
    assert counts_of(restored) == before


def test_pack_refuses_a_file_above_the_upload_cap(tmp_path):
    db = tmp_path / "lmia.sqlite"
    seed_for_pack(db, employers=30)
    out = tmp_path / "lmia.sqlite.gz"
    out.write_bytes(b"last night's file")
    ok, message, sizes = nightly.pack(db, out, max_mib=0.001)
    assert not ok and "above the 0.001 MiB" in message and "R2 keeps the previous backup" in message
    # Nothing is left for the upload to send.
    assert not out.exists() and list(tmp_path.glob("lmia.sqlite.gz*")) == []
    assert nightly.main(["pack", "--db", str(db), "--out", str(out), "--max-mib", "0.001"]) == 1
    assert nightly.main(["pack", "--db", str(db), "--out", str(out)]) == 0 and out.exists()


def test_pack_stops_on_a_missing_damaged_or_failing_database(tmp_path, monkeypatch):
    out = tmp_path / "out" / "lmia.sqlite.gz"
    ok, message, _ = nightly.pack(tmp_path / "nope.sqlite", out)
    assert not ok and "missing or empty" in message
    # The pack never creates a database where there was none.
    assert not (tmp_path / "nope.sqlite").exists() and not out.exists()

    bad = tmp_path / "bad.sqlite"
    bad.write_bytes(b"SQLite format 3\x00" + b"\x00" * 50 + b"garbage" * 500)
    ok, message, _ = nightly.pack(bad, out)
    assert not ok and "could not be packed" in message and not out.exists()
    assert nightly.main(["pack", "--db", str(bad), "--out", str(out)]) == 1

    # Anything but "ok" from the copy's check stops the pack.
    db = tmp_path / "lmia.sqlite"
    seed_for_pack(db, employers=10)
    real = sqlite3.connect

    class Checked:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, *args):
            if sql.startswith("PRAGMA quick_check"):
                return iter([("*** in database main *** Page 7: btreeInitPage() returns error code 11",)])
            return self.conn.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self.conn, name)

    monkeypatch.setattr(nightly.sqlite3, "connect", lambda *a, **k: Checked(real(*a, **k)))
    ok, message, _ = nightly.pack(db, out)
    assert not ok and "failed its integrity check" in message and "btreeInitPage" in message
    assert list(out.parent.iterdir()) == []


def test_restore_accepts_a_packed_backup(tmp_path):
    src = tmp_path / "src.sqlite"
    make_db(src, employers=5, postings=4)
    packed = tmp_path / "packed.gz"
    assert nightly.pack(src, packed)[0]
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, body=packed.read_bytes())
    download(folder, nightly.PREVIOUS, exit_code=1, log=MISSING)
    db = tmp_path / "lmia.sqlite"
    ok, source, _, counts = nightly.restore(folder, db)
    assert (ok, source) == (True, "backup")
    assert counts["employers"] == 5 and counts["jobbank_postings"] == 4
    assert indexes_of(db)[0] == set()
    connect(db).close()
    assert len(indexes_of(db)[0]) == 20


# -- the Worker's CPU time ----------------------------------------------------

CPU_ACCOUNT = "0123456789abcdef0123456789abcdef"
CPU_TOKEN = "analytics-token-never-printed"
CPU_SUMMARY = {
    "state": "ok", "detail": "1 day fetched", "days_fetched": ["2026-11-13"], "day": "2026-11-13",
    "yesterday": {"date": "2026-11-13", "requests": 238_037, "cpu_ms": 2_305_908, "mean_cpu_ms": 9.687,
                  "startup_share": 0.32},
    "month": "2026-11", "month_to_date_cpu_ms": 26_100_000, "month_projection_cpu_ms": 48_200_000,
    "included_cpu_ms": 30_000_000,
}
WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "nightly.yml"


class CpuResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


class CpuHttp:
    """Answers the GraphQL query with one group per day in the window asked, or with status."""

    def __init__(self, status=200):
        self.status = status
        self.posts = []
        self.closed = False

    def post(self, url, json=None, headers=None, timeout=None):
        self.posts.append({"url": url, "json": json, "headers": headers})
        if self.status != 200:
            return CpuResponse(self.status, {"errors": [{"message": "server error"}]})
        day, until = date.fromisoformat(json["variables"]["since"][:10]), json["variables"]["until"][:10]
        groups = []
        while day.isoformat() < until:
            groups.append({"dimensions": {"date": day.isoformat()},
                           "sum": {"requests": 1000, "errors": 0, "subrequests": 5, "cpuTimeUs": 9_000_000,
                                   "startupCpuTimeUs": 3_000_000, "responseBodySize": 100},
                           "quantiles": {"cpuTimeP50": 4000, "cpuTimeP90": 9000, "cpuTimeP99": 30000,
                                         "startupCpuTimeUsP50": 2000, "memoryUsageBytesP50": 2_097_152}})
            day += timedelta(days=1)
        return CpuResponse(200, {"data": {"viewer": {"accounts": [{"inv": groups}]}}, "errors": None})

    def close(self):
        self.closed = True


def test_worker_metrics_command_writes_the_summary_and_prints_no_token(tmp_path, monkeypatch, capsys, caplog):
    caplog.set_level("DEBUG")
    monkeypatch.setenv(wm.TOKEN_ENV, CPU_TOKEN)
    monkeypatch.setattr(wm, "previous_day", lambda now=None: date(2026, 11, 13))
    fake = CpuHttp()
    monkeypatch.setattr(requests, "Session", lambda: fake)
    csv_path, out = tmp_path / "worker_cpu.csv", tmp_path / "out" / "summary.json"
    args = ["worker-metrics", "--account", CPU_ACCOUNT, "--csv", str(csv_path), "--out", str(out)]
    assert nightly.main(args) == 0
    summary = json.loads(out.read_text(encoding="utf-8"))
    assert summary["state"] == "ok" and len(summary["days_fetched"]) == 13  # 2026-11-01 to 2026-11-13
    assert summary["yesterday"] == {"date": "2026-11-13", "requests": 1000, "cpu_ms": 9000, "mean_cpu_ms": 9.0,
                                    "startup_share": 0.333}
    assert len(fake.posts) == 2 and fake.closed  # a week per query
    assert fake.posts[0]["json"]["variables"]["script"] == "lmia-watch"
    printed = capsys.readouterr().out
    assert printed == "worker-metrics: ok (13 days fetched)\n"
    assert CPU_TOKEN not in printed + caplog.text + out.read_text(encoding="utf-8") + csv_path.read_text(encoding="utf-8")

    # Failed: exit 1, and the summary is still written for the run status.
    monkeypatch.setattr(requests, "Session", lambda: CpuHttp(status=500))
    assert nightly.main(["worker-metrics", "--account", CPU_ACCOUNT, "--csv", str(tmp_path / "other.csv"),
                         "--out", str(out)]) == 1
    failed = json.loads(out.read_text(encoding="utf-8"))
    assert failed["state"] == "failed" and "HTTP 500" in failed["detail"]
    assert CPU_TOKEN not in capsys.readouterr().out + caplog.text

    # No token: no credentials, exit 0, nothing asked.
    monkeypatch.delenv(wm.TOKEN_ENV)
    idle = CpuHttp()
    monkeypatch.setattr(requests, "Session", lambda: idle)
    assert nightly.main(args) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["state"] == "no credentials" and idle.posts == []


def test_status_carries_the_worker_metrics_and_last_run_gets_its_line(tmp_path, capsys):
    db = tmp_path / "none.sqlite"
    assert nightly.run_status(db, None, None, None, {})["worker_metrics"] == {"state": "not run"}
    # Never a stage: a failure alerts without marking the data refresh failed.
    failed = nightly.run_status(db, None, None, None, {}, worker_metrics={"state": "failed", "detail": "HTTP 500"})
    assert failed["worker_metrics"]["state"] == "failed"
    assert "worker" not in json.dumps(failed["stages"]).lower()

    (tmp_path / "summary.json").write_text(json.dumps(CPU_SUMMARY), encoding="utf-8")
    out = tmp_path / "status.json"
    assert nightly.main(["status", "--db", str(db), "--worker-metrics", str(tmp_path / "summary.json"),
                         "--out", str(out)]) == 0
    status = json.loads(out.read_text(encoding="utf-8"))
    assert status["worker_metrics"]["state"] == "ok"
    assert status["worker_metrics"]["month_projection_cpu_ms"] == 48_200_000
    capsys.readouterr()
    assert nightly.main(["worker-cpu-line", "--status", str(out)]) == 0
    assert capsys.readouterr().out == (
        "Worker CPU: 2026-11-13: 2,305,908 ms over 238,037 requests (9.7 ms mean, start-up 32%); "
        "month to date 26.1M of 30M included, projection 48.2M\n")

    # The step did not run, or the status is missing: nothing for LAST_RUN.md.
    assert nightly.main(["status", "--db", str(db), "--out", str(out)]) == 0
    capsys.readouterr()
    assert nightly.main(["worker-cpu-line", "--status", str(out)]) == 0
    assert nightly.main(["worker-cpu-line", "--status", str(tmp_path / "absent.json")]) == 0
    assert capsys.readouterr().out == ""


def test_the_workflow_records_the_worker_cpu_after_the_roll_up_and_saves_the_file():
    text = WORKFLOW.read_text(encoding="utf-8")
    names = re.findall(r"^      - name: (.+)$", text, re.MULTILINE)
    step = names.index("Record the Worker's CPU time (only when CLOUDFLARE_ANALYTICS_TOKEN is set)")
    assert names.index("Roll up the audience counts (only when CLOUDFLARE_ANALYTICS_TOKEN is set)") < step
    assert step < names.index("Write the monthly audience report (the first run of a month)")
    block = text.split("- name: Record the Worker's CPU time", 1)[1].split("\n      - ", 1)[0]
    assert "if: ${{ !cancelled() }}" in block and "continue-on-error: true" in block
    assert "CLOUDFLARE_ANALYTICS_TOKEN: ${{ secrets.CLOUDFLARE_ANALYTICS_TOKEN }}" in block
    assert 'failed "the step stopped before it finished"' in block  # before anything else can stop it
    assert 'r2 object get --remote "$BUCKET/metrics/worker_cpu.csv"' in block
    assert 'put "$BUCKET/metrics/worker_cpu.csv" "$out/worker_cpu.csv"' in block
    assert ('python -m lmia_pipeline.nightly worker-metrics --account "$CLOUDFLARE_ACCOUNT_ID" --script lmia-watch \\\n'
            '            --csv "$out/worker_cpu.csv" --out "$out/result.json"') in block
    for line in block.splitlines():
        if "r2 object" in line:
            assert "--remote" in line, line
    assert "--worker-metrics data/out/worker_metrics/summary.json" in text
    assert "--step \"worker_metrics=" not in text  # never a step outcome, so never a retry
    report = text.split("- name: Write the monthly audience report", 1)[1].split("\n      - ", 1)[0]
    assert 'fetch metrics/worker_cpu.csv "$out/worker_cpu.csv"' in report
    assert '--worker-cpu "$out/worker_cpu.csv"' in report
    record = text.split("- name: Record the run so the schedule stays enabled", 1)[1].split("\n      - ", 1)[0]
    assert ("python -m lmia_pipeline.nightly worker-cpu-line --status data/out/status.json "
            "> data/out/worker_cpu_line.txt 2>/dev/null || true") in record
    assert "cat data/out/worker_cpu_line.txt >> LAST_RUN.md" in record


def code_only(text):
    return "\n".join(line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#"))


def test_the_check_key_reaches_only_the_steps_that_read_the_live_site():
    """The smoke test and the nightly checks send EDGE_CHECK_KEY to the site;
    no other step, and no job's environment, gets the secret. IndexNow's key
    file check stays without it, as the engines fetch that file."""
    text = WORKFLOW.read_text(encoding="utf-8")
    key_line = "EDGE_CHECK_KEY: ${{ secrets.EDGE_CHECK_KEY }}"
    readers = []
    for step in re.split(r"\n      - ", text)[1:]:
        code = code_only(step)
        name = step.splitlines()[0]
        reads_site = re.search(r"lmia_pipeline\.nightly (smoke|checks|site-bundle-check)\s", code) is not None
        assert (key_line in code) == reads_site, name
        if reads_site:
            readers.append(name)
    assert readers == ["name: Check the live site", "name: Nightly HTML and edge checks and monthly expiry checks"]
    assert [line.strip() for line in code_only(text).splitlines() if "EDGE_CHECK_KEY" in line] == [key_line] * 2
    # The header lists the secret with the others.
    header = text.split("\nname: nightly\n", 1)[0]
    assert "EDGE_CHECK_KEY (64 lower-case hex characters" in header
