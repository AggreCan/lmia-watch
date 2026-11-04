"""The resilience layer: the retry gate, the smoke test and rollback record,
the weekly snapshot restore, the nightly HTML check and the monthly expiry
checks, and the attention items and issue texts. Every network call goes to a
fake session."""

import gzip
from pathlib import Path
import json
import logging
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

from lmia_pipeline import nightly, resilience
from lmia_pipeline.db import connect, log_run, upsert_employer

TODAY = date(2026, 10, 22)
NOW = datetime(2026, 10, 22, 0, 50, tzinfo=timezone.utc)
VERSION_A = "0a1b2c3d-1111-4222-8333-444455556666"
VERSION_B = "9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff"
DEPLOY_TOKEN = "tok-deploy-secret-value"
ANALYTICS_TOKEN = "tok-analytics-secret-value"
ACCOUNT = "abc123abc123abc123abc123abc123ab"


class Resp:
    def __init__(self, status, text="", headers=None, json_data=None, chunks=None):
        self.status_code = status
        self.text = text
        self.headers = headers or {}
        self._json = json_data
        self._chunks = chunks or []
        self.closed = False

    def json(self):
        if self._json is None:
            raise ValueError("not JSON")
        return self._json

    def iter_content(self, size):
        yield from self._chunks

    def close(self):
        self.closed = True


class FakeHttp:
    """Answers by exact URL from a queue (the last answer repeats); an
    exception in the queue is raised. Records every call."""

    def __init__(self, routes):
        self.routes = {url: list(v) if isinstance(v, list) else [v] for url, v in routes.items()}
        self.calls = []

    def get(self, url, headers=None, timeout=None, stream=False, **kwargs):
        self.calls.append((url, dict(headers or {})))
        queue = self.routes.get(url)
        if queue is None:
            return Resp(404)
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def close(self):
        pass


# -- gate ---------------------------------------------------------------------


def clean_status(**extra):
    status = {"run_at": "2026-10-22T00:48:10+00:00", "ok": True, "stages": [],
              "steps": {"restore": "success", "pipeline": "success", "deploy": "success"}}
    status.update(extra)
    return status


def test_the_gate_skips_only_after_a_clean_deployed_run_today():
    skip, reason = resilience.gate(clean_status(), TODAY)
    assert skip and "finished clean" in reason
    assert resilience.gate(clean_status(), TODAY + timedelta(days=1))[0] is False
    assert resilience.gate(clean_status(ok=False), TODAY)[0] is False
    assert resilience.gate(clean_status(steps={"deploy": "failure"}), TODAY)[0] is False
    assert resilience.gate(clean_status(steps={"deploy": "skipped"}), TODAY)[0] is False
    # A status from before the steps were recorded cannot show a deploy.
    old = clean_status()
    del old["steps"]
    assert resilience.gate(old, TODAY)[0] is False
    # A run that ended just before midnight is yesterday's.
    assert resilience.gate(clean_status(run_at="2026-10-21T23:59:59Z"), TODAY)[0] is False
    # The run time is read in UTC whatever offset it was written with.
    assert resilience.gate(clean_status(run_at="2026-10-21T20:30:00-07:00"), TODAY)[0] is True


@pytest.mark.parametrize("raw", [None, [], "text", {"ok": True}, {"run_at": "soon", "ok": True}, {"run_at": 5}])
def test_the_gate_runs_the_refresh_on_anything_unreadable(raw):
    assert resilience.gate(raw, TODAY)[0] is False


def test_gate_command_writes_its_output_and_never_fails(tmp_path, monkeypatch):
    gh = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(gh))
    status = tmp_path / "status.json"
    status.write_text(json.dumps(clean_status()))
    assert nightly.main(["gate", "--status", str(status), "--today", "2026-10-22"]) == 0
    assert gh.read_text() == "skip=true\n"
    gh.unlink()
    # The download found nothing, or left a broken file: the refresh runs.
    assert nightly.main(["gate", "--status", str(tmp_path / "missing.json"), "--today", "2026-10-22"]) == 0
    status.write_text("{not json")
    assert nightly.main(["gate", "--status", str(status), "--today", "2026-10-22"]) == 0
    assert nightly.main(["gate", "--status", str(status), "--today", "not a date"]) == 0
    assert gh.read_text() == "skip=false\nskip=false\nskip=false\n"


def test_a_status_written_by_a_clean_run_lets_the_gate_skip(tmp_path):
    db = tmp_path / "lmia.sqlite"
    connect(db).close()
    status = nightly.run_status(db, "2000-01-01T00:00:00Z", {"problems": []}, "posted",
                                {"restore": "success", "pipeline": "success", "deploy": "success"}, now=NOW,
                                smoke={"verdict": "ok", "detail": "4 pages answered 200"})
    assert resilience.gate(status, TODAY)[0] is True
    rolled = nightly.run_status(db, "2000-01-01T00:00:00Z", {"problems": []}, "posted", {"deploy": "success"}, now=NOW,
                                smoke={"verdict": "broken", "detail": "/ answered 500 and 500"}, rollback="rolled back")
    assert resilience.gate(rolled, TODAY)[0] is False


# -- the live version ---------------------------------------------------------


def test_the_live_version_is_the_one_carrying_the_traffic():
    status = {"id": "dep", "created_on": "2026-10-21T00:40:00Z",
              "versions": [{"version_id": VERSION_A, "percentage": 100}]}
    assert resilience.live_version(json.dumps(status)) == VERSION_A
    split = dict(status, versions=[{"version_id": VERSION_A, "percentage": 10}, {"version_id": VERSION_B, "percentage": 90}])
    assert resilience.live_version(json.dumps(split)) == VERSION_B
    # A notice printed before the JSON does not hide it.
    assert resilience.live_version("Proxy environment variables detected.\n" + json.dumps(status, indent=2)) == VERSION_A


def test_the_live_version_reads_the_list_shapes_too():
    versions = [
        {"id": VERSION_A, "number": 7, "metadata": {"created_on": "2026-10-21T00:40:00.123Z"}},
        {"id": VERSION_B, "number": 8, "metadata": {"created_on": "2026-10-22T00:41:00.456Z"}},
    ]
    assert resilience.live_version(json.dumps(versions)) == VERSION_B
    deployments = [
        {"created_on": "2026-10-22T00:41:00Z", "versions": [{"version_id": VERSION_B, "percentage": 100}]},
        {"created_on": "2026-10-21T00:40:00Z", "versions": [{"version_id": VERSION_A, "percentage": 100}]},
    ]
    assert resilience.live_version(json.dumps(deployments)) == VERSION_B


@pytest.mark.parametrize("text", ["", "not json", "[]", "{}", '{"versions": [{"version_id": "x; rm -rf /", "percentage": 100}]}',
                                  '[{"id": "abc", "metadata": {"created_on": "2026-10-22T00:00:00Z"}}]'])
def test_no_live_version_without_a_well_formed_id(text):
    assert resilience.live_version(text) is None


def test_live_version_command(tmp_path, monkeypatch):
    gh = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(gh))
    src = tmp_path / "before.json"
    src.write_text(json.dumps({"versions": [{"version_id": VERSION_A, "percentage": 100}]}))
    out = tmp_path / "version_before.txt"
    assert nightly.main(["live-version", "--file", str(src), "--out", str(out)]) == 0
    assert gh.read_text() == f"version_id={VERSION_A}\n"
    assert out.read_text().strip() == VERSION_A
    src.write_text("X [ERROR] Authentication error [code: 10000]")
    assert nightly.main(["live-version", "--file", str(src)]) == 1
    assert gh.read_text() == f"version_id={VERSION_A}\n"


# -- smoke test ---------------------------------------------------------------

BASE = "https://lmiawatch.example"
DATA_DATE = "2026-10-22"
PATHS = ["/", "/search", "/data", "/employers/emp-a000000005"]


def page(date_text=DATA_DATE, status=200, headers=None):
    return Resp(status, f"<html><body>Data as of {date_text}</body></html>", headers)


def site(**overrides):
    routes = {BASE + p: page() for p in PATHS}
    routes.update({BASE + p: v for p, v in overrides.items()})
    return FakeHttp(routes)


def run_smoke(http, data_date=DATA_DATE):
    waits = []
    result = resilience.smoke(http, BASE, data_date, PATHS, sleep=waits.append, settle=20)
    return result, waits


def test_a_healthy_site_is_ok_without_a_second_try():
    http = site()
    result, waits = run_smoke(http)
    assert (result["verdict"], waits) == ("ok", [20])
    assert [u for u, _ in http.calls] == [BASE + p for p in PATHS]
    assert all(h["User-Agent"].startswith("LMIAWatch/") for _, h in http.calls)


def test_a_page_answering_5xx_twice_is_broken():
    http = site(**{"/search": [Resp(500, "Error 1101 Worker threw exception"), Resp(502, "bad gateway")]})
    result, waits = run_smoke(http)
    assert result["verdict"] == "broken"
    assert result["detail"] == "/search answered 500 and 502"
    # The second try waits 30 seconds and asks again only for the page that failed.
    assert waits == [20, 30]
    assert [u for u, _ in http.calls].count(BASE + "/search") == 2 and len(http.calls) == 5


def test_a_5xx_that_recovers_is_ok():
    http = site(**{"/": [Resp(503, "busy"), page()]})
    result, _ = run_smoke(http)
    assert result["verdict"] == "ok"


@pytest.mark.parametrize("answer", [
    Resp(403, "<title>Attention Required! | Cloudflare</title>"),
    Resp(403, "forbidden"),
    # Under Attack Mode answers 503 with a challenge page: the edge, not the Worker.
    Resp(503, "<title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/x'></script>"),
    Resp(503, "", headers={"cf-mitigated": "challenge"}),
])
def test_the_edge_refusing_the_runner_is_unverifiable_never_broken(answer):
    http = FakeHttp({BASE + p: answer for p in PATHS})
    result, _ = run_smoke(http)
    assert result["verdict"] == "unverifiable"
    assert "from the edge" in result["detail"]


def test_a_missing_data_date_or_a_strange_answer_is_unverifiable():
    stale, _ = run_smoke(site(**{"/data": page("2026-10-21")}))
    assert stale["verdict"] == "unverifiable" and "/data: 200 without the data date 2026-10-22" in stale["detail"]
    lost, _ = run_smoke(site(**{"/employers/emp-a000000005": Resp(404, "not found")}))
    assert lost["verdict"] == "unverifiable" and "404" in lost["detail"]
    down, _ = run_smoke(site(**{"/": ConnectionError("no route to host")}))
    assert down["verdict"] == "unverifiable" and "no answer (ConnectionError)" in down["detail"]
    # Without a date to look for, the dated pages cannot be confirmed.
    undated, _ = run_smoke(site(), data_date=None)
    assert undated["verdict"] == "unverifiable"
    # One 5xx and one timeout is not twice 5xx.
    mixed, _ = run_smoke(site(**{"/search": [Resp(500), TimeoutError("slow")]}))
    assert mixed["verdict"] == "unverifiable"


def test_smoke_paths_take_one_well_formed_employer_from_stats():
    stats = {"top_approvals": [{"employer_id": "../../admin"}, {"employer_id": "emp-a000000005"}, {"employer_id": "emp-b"}]}
    assert resilience.smoke_paths(stats) == ["/", "/search", "/data", "/employers/emp-a000000005"]
    assert resilience.smoke_paths(None) == ["/", "/search", "/data"]
    assert resilience.smoke_paths({"top_approvals": "x"}) == ["/", "/search", "/data"]


def test_smoke_command_writes_the_verdict(tmp_path, monkeypatch):
    gh = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(gh))
    stats = tmp_path / "stats.json"
    stats.write_text(json.dumps({"data_as_of": DATA_DATE, "top_approvals": [{"employer_id": "emp-a000000005"}]}))
    http = site(**{"/data": [Resp(500), Resp(500)]})
    monkeypatch.setattr(nightly, "_session", lambda: http)
    monkeypatch.setattr(resilience.time, "sleep", lambda s: None)
    out = tmp_path / "smoke.json"
    assert nightly.main(["smoke", "--base-url", BASE, "--stats", str(stats), "--out", str(out), "--settle", "0"]) == 1
    assert gh.read_text() == "verdict=broken\n"
    written = json.loads(out.read_text())
    assert written["verdict"] == "broken" and written["data_date"] == DATA_DATE and len(written["pages"]) == 4
    http2 = site()
    monkeypatch.setattr(nightly, "_session", lambda: http2)
    assert nightly.main(["smoke", "--base-url", BASE, "--data-date", DATA_DATE, "--stats", str(stats),
                         "--out", str(out), "--settle", "0"]) == 0
    assert gh.read_text().endswith("verdict=ok\n")


# -- weekly snapshot restore --------------------------------------------------

OBJECTS = f"/client/v4/accounts/{ACCOUNT}/r2/buckets/lmia-watch-data/objects"
MISSING = 'Downloading "lmia.sqlite.gz"\n[ERROR] The specified key does not exist.\n'


class FakeR2:
    """The bucket's listing and object downloads, as the REST API serves them."""

    def __init__(self, objects, list_answer=None, page_size=None):
        self.objects = objects  # key -> (bytes, last_modified)
        self.list_answer = list_answer
        self.page_size = page_size
        self.calls = []

    def get(self, url, headers=None, timeout=None, stream=False, **kwargs):
        self.calls.append((url, dict(headers or {})))
        parts = urlsplit(url)
        assert parts.scheme == "https" and parts.netloc == "api.cloudflare.com"
        if parts.path == OBJECTS:
            if self.list_answer is not None:
                return self.list_answer
            query = parse_qs(parts.query)
            prefix = query["prefix"][0]
            keys = sorted(k for k in self.objects if k.startswith(prefix))
            start = int(query.get("cursor", ["0"])[0])
            size = self.page_size or len(keys) or 1
            chunk = keys[start:start + size]
            more = start + size < len(keys)
            return Resp(200, json_data={
                "success": True, "errors": [],
                "result": [{"key": k, "last_modified": self.objects[k][1], "size": len(self.objects[k][0])} for k in chunk],
                "result_info": {"is_truncated": more, "cursor": str(start + size) if more else ""},
            })
        if parts.path.startswith(OBJECTS + "/"):
            key = unquote(parts.path[len(OBJECTS) + 1:])
            if key not in self.objects:
                return Resp(404, json_data={"success": False, "errors": [{"code": 10007, "message": "object not found"}]})
            body = self.objects[key][0]
            return Resp(200, chunks=[body[: len(body) // 2], body[len(body) // 2:]])
        return Resp(404)


def make_db(path, employers=3):
    conn = connect(path)
    for i in range(employers):
        upsert_employer(conn, f"Employer {i} Ltd", "BC", source="jobbank", now="2026-10-18T00:00:00Z")
    conn.commit()
    conn.close()


def download(folder, key, *, body=None, exit_code=0, log=""):
    folder.mkdir(parents=True, exist_ok=True)
    if body is not None:
        (folder / key).write_bytes(body)
    (folder / f"{key}.exit").write_text(str(exit_code), encoding="utf-8")
    (folder / f"{key}.log").write_text(log, encoding="utf-8")


def snapshot_bytes(tmp_path, employers):
    src = tmp_path / f"src-{employers}.sqlite"
    make_db(src, employers)
    return gzip.compress(src.read_bytes())


def r2(fake):
    return resilience.R2Rest(fake, ACCOUNT, DEPLOY_TOKEN, "lmia-watch-data")


def both_missing(folder):
    download(folder, nightly.BACKUP, exit_code=1, log=MISSING)
    download(folder, nightly.PREVIOUS, exit_code=1, log=MISSING)


def test_both_nightly_backups_missing_restores_the_newest_weekly_snapshot(tmp_path):
    folder = tmp_path / "restore"
    both_missing(folder)
    fake = FakeR2({
        "backups/weekly/db-slot-3.sqlite.gz": (snapshot_bytes(tmp_path, 4), "2026-10-11T00:52:10.120Z"),
        "backups/weekly/db-slot-4.sqlite.gz": (snapshot_bytes(tmp_path, 5), "2026-10-18T00:51:30.500Z"),
        "backups/weekly/d1-slot-4.sql.gz": (b"x", "2026-10-19T00:00:00Z"),
        # Under the prefix but not a snapshot the save step writes.
        "backups/weekly/db-slot-4.sqlite.gz.old": (b"x", "2026-10-20T00:00:00Z"),
    }, page_size=1)
    ok, record = nightly.restore_record(folder, tmp_path / "lmia.sqlite", r2(fake))
    assert ok and record["source"] == "weekly"
    assert record["weekly_key"] == "backups/weekly/db-slot-4.sqlite.gz"
    assert record["weekly_uploaded"] == "2026-10-18T00:51:30+00:00"
    assert record["counts"]["employers"] == 5
    # The listing followed its cursor, and every call carried the token in the header only.
    assert sum(1 for u, _ in fake.calls if urlsplit(u).path == OBJECTS) == 3
    assert all(h["Authorization"] == f"Bearer {DEPLOY_TOKEN}" and DEPLOY_TOKEN not in u for u, h in fake.calls)


def test_both_nightly_backups_damaged_restores_the_weekly_snapshot(tmp_path):
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, body=b"\x1f\x8b broken")
    download(folder, nightly.PREVIOUS, body=b"<html>oops</html>")
    fake = FakeR2({"backups/weekly/db-slot-4.sqlite.gz": (snapshot_bytes(tmp_path, 3), "2026-10-18T00:51:30Z")})
    ok, source, message, counts = nightly.restore(folder, tmp_path / "lmia.sqlite", r2(fake))
    assert (ok, source, counts["employers"]) == (True, "weekly", 3)
    assert "lmia.sqlite.gz: not a complete gzip file" in message


def test_a_nightly_backup_that_could_not_be_downloaded_never_falls_back_to_a_weekly_one(tmp_path):
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, exit_code=1, log="[ERROR] A request to the Cloudflare API failed. (503)")
    download(folder, nightly.PREVIOUS, exit_code=1, log=MISSING)
    fake = FakeR2({"backups/weekly/db-slot-4.sqlite.gz": (snapshot_bytes(tmp_path, 3), "2026-10-18T00:51:30Z")})
    ok, record = nightly.restore_record(folder, tmp_path / "lmia.sqlite", r2(fake))
    assert not ok and "503" in record["message"]
    assert fake.calls == []


def test_a_good_nightly_backup_never_asks_for_the_weekly_ones(tmp_path):
    folder = tmp_path / "restore"
    src = tmp_path / "src.sqlite"
    make_db(src)
    download(folder, nightly.BACKUP, body=gzip.compress(src.read_bytes()))
    download(folder, nightly.PREVIOUS, exit_code=1, log=MISSING)
    fake = FakeR2({})
    ok, record = nightly.restore_record(folder, tmp_path / "lmia.sqlite", r2(fake))
    assert ok and record["source"] == "backup" and fake.calls == []


def test_nothing_anywhere_is_still_a_first_run(tmp_path):
    folder = tmp_path / "restore"
    both_missing(folder)
    fake = FakeR2({"backups/weekly/d1-latest.sql.gz": (b"x", "2026-10-18T00:51:30Z")})
    ok, record = nightly.restore_record(folder, tmp_path / "lmia.sqlite", r2(fake))
    assert ok and record["source"] == "none" and "first run" in record["message"]
    assert not (tmp_path / "lmia.sqlite").exists()


def test_damaged_nightly_backups_and_no_snapshot_stop_the_run(tmp_path):
    folder = tmp_path / "restore"
    download(folder, nightly.BACKUP, body=b"\x1f\x8b broken")
    download(folder, nightly.PREVIOUS, exit_code=1, log=MISSING)
    ok, record = nightly.restore_record(folder, tmp_path / "lmia.sqlite", r2(FakeR2({})))
    assert not ok and "weekly snapshots: none in R2" in record["message"]


def test_a_listing_that_fails_stops_the_run_and_names_no_token(tmp_path):
    folder = tmp_path / "restore"
    both_missing(folder)
    refusal = Resp(403, json_data={"success": False, "errors": [{"code": 10000, "message": f"Authentication error {DEPLOY_TOKEN}"}]})
    ok, record = nightly.restore_record(folder, tmp_path / "lmia.sqlite", r2(FakeR2({}, list_answer=refusal)))
    assert not ok and record["source"] == "none"
    assert "weekly snapshots: the listing answered HTTP 403 (10000 Authentication error [token])" in record["message"]
    assert DEPLOY_TOKEN not in json.dumps(record)


def test_a_listing_of_an_unexpected_shape_never_reads_as_a_first_run(tmp_path):
    folder = tmp_path / "restore"
    both_missing(folder)
    undated = Resp(200, json_data={"success": True, "result": [{"key": "backups/weekly/db-slot-4.sqlite.gz", "size": 9}],
                                   "result_info": {"is_truncated": False}})
    ok, record = nightly.restore_record(folder, tmp_path / "lmia.sqlite", r2(FakeR2({}, list_answer=undated)))
    assert not ok and "without an upload time" in record["message"]
    for odd in ({"success": True, "result": {"buckets": []}}, {"success": False, "result": []}, None):
        answer = Resp(200, json_data=odd) if odd is not None else Resp(200, "<html>")
        ok, record = nightly.restore_record(folder, tmp_path / "lmia.sqlite", r2(FakeR2({}, list_answer=answer)))
        assert not ok and "weekly snapshots: the listing answered without" in record["message"]


def test_a_damaged_weekly_snapshot_stops_the_run(tmp_path):
    folder = tmp_path / "restore"
    both_missing(folder)
    fake = FakeR2({"backups/weekly/db-slot-4.sqlite.gz": (gzip.compress(b"not sqlite" * 500), "2026-10-18T00:51:30Z")})
    ok, record = nightly.restore_record(folder, tmp_path / "lmia.sqlite", r2(fake))
    assert not ok and "backups/weekly/db-slot-4.sqlite.gz:" in record["message"]
    assert not (tmp_path / "lmia.sqlite").exists()


def test_restore_command_reads_the_weekly_snapshots_with_the_runs_token(tmp_path, monkeypatch, caplog):
    folder = tmp_path / "restore"
    both_missing(folder)
    fake = FakeR2({"backups/weekly/db-slot-4.sqlite.gz": (snapshot_bytes(tmp_path, 3), "2026-10-18T00:51:30Z")})
    monkeypatch.setattr(nightly, "_session", lambda: fake)
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", DEPLOY_TOKEN)
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT)
    out = tmp_path / "restore.json"
    with caplog.at_level(logging.INFO):
        assert nightly.main(["restore", "--dir", str(folder), "--db", str(tmp_path / "lmia.sqlite"), "--out", str(out),
                             "--bucket", "lmia-watch-data"]) == 0
    record = json.loads(out.read_text())
    assert (record["source"], record["weekly_uploaded"]) == ("weekly", "2026-10-18T00:51:30+00:00")
    assert DEPLOY_TOKEN not in caplog.text and DEPLOY_TOKEN not in out.read_text()
    # Without the token (a dev machine) the decision is the one from before.
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN")
    (tmp_path / "lmia.sqlite").unlink()
    assert nightly.main(["restore", "--dir", str(folder), "--db", str(tmp_path / "lmia.sqlite"), "--out", str(out)]) == 0
    assert json.loads(out.read_text())["source"] == "none"


# -- expiry checks ------------------------------------------------------------

VERIFY_USER = f"{resilience.API}/user/tokens/verify"
VERIFY_ACCOUNT = f"{resilience.API}/accounts/{ACCOUNT}/tokens/verify"
REGISTRAR = f"{resilience.API}/accounts/{ACCOUNT}/registrar/domains/lmiawatch.ca"
FIRST = date(2026, 11, 1)
FIRST_NOW = datetime(2026, 11, 1, 0, 55, tzinfo=timezone.utc)
SITE = "https://lmiawatch.ca"
HOME = "https://lmiawatch.ca/"


class TokenApi(FakeHttp):
    """Answers each token by its Authorization header."""

    def __init__(self, by_token):
        super().__init__({})
        self.by_token = by_token

    def get(self, url, headers=None, timeout=None, stream=False, **kwargs):
        self.calls.append((url, dict(headers or {})))
        token = (headers or {}).get("Authorization", "").removeprefix("Bearer ")
        answer = self.by_token.get((token, url), Resp(404))
        if isinstance(answer, Exception):
            raise answer
        return answer


def verified(status="active", expires=None):
    result = {"id": "t1", "status": status}
    if expires:
        result["expires_on"] = expires
    return Resp(200, json_data={"success": True, "result": result, "errors": []})


def refused(code=10000, message="Authentication error", status=403):
    return Resp(status, json_data={"success": False, "errors": [{"code": code, "message": message}]})


ENV = {"CLOUDFLARE_API_TOKEN": DEPLOY_TOKEN, "CLOUDFLARE_ANALYTICS_TOKEN": ANALYTICS_TOKEN, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT}


def test_checks_run_on_the_first_day_of_a_month_only():
    assert resilience.checks_due(FIRST) and not resilience.checks_due(TODAY)
    # Another day: the HTML check alone, and no request to the API.
    api = TokenApi({("", HOME): home_page()})
    result = resilience.run_checks(TODAY, ENV, api, domain="lmiawatch.ca", site_url=SITE, now=NOW)
    assert result["due"] is True and result["monthly"] is False and result["date"] == "2026-10-22"
    assert result["html_rewrite"]["state"] == "ok" and result["items"] == []
    assert not {"deploy_token", "analytics_token", "domain"} & result.keys()
    assert [url for url, _ in api.calls] == [HOME]
    # The first of a month: the HTML check and the three expiry checks.
    first = resilience.run_checks(FIRST, ENV, TokenApi({("", HOME): home_page()}), domain="lmiawatch.ca", site_url=SITE,
                                  now=FIRST_NOW)
    assert first["monthly"] is True
    assert {"html_rewrite", "deploy_token", "analytics_token", "domain"} <= first.keys()


def test_tokens_and_domain_far_from_expiry_are_ok_and_a_missing_permission_is_unknown():
    api = TokenApi({
        (DEPLOY_TOKEN, VERIFY_USER): verified(expires="2027-06-01T00:00:00Z"),
        (ANALYTICS_TOKEN, VERIFY_USER): verified(),
        (DEPLOY_TOKEN, REGISTRAR): refused(),
    })
    result = resilience.run_checks(FIRST, ENV, api, domain="lmiawatch.ca", now=FIRST_NOW)
    assert result["deploy_token"] == {"status": "active", "expires_on": "2027-06-01T00:00:00+00:00", "days_left": 211, "state": "ok"}
    assert result["analytics_token"] == {"status": "active", "expires_on": None, "state": "ok"}
    assert result["domain"]["state"] == "unknown" and "lacks the permission" in result["domain"]["detail"]
    assert result["items"] == []


def test_a_token_or_domain_close_to_expiry_or_a_token_not_active_is_an_item():
    api = TokenApi({
        (DEPLOY_TOKEN, VERIFY_USER): verified(expires="2026-11-20T00:00:00Z"),
        (ANALYTICS_TOKEN, VERIFY_USER): verified(status="disabled"),
        (DEPLOY_TOKEN, REGISTRAR): Resp(200, json_data={"success": True, "result": {
            "expires_at": "2026-11-25T12:00:00Z", "auto_renew": False}}),
    })
    result = resilience.run_checks(FIRST, ENV, api, domain="lmiawatch.ca", now=FIRST_NOW)
    assert [result[k]["state"] for k in ("deploy_token", "analytics_token", "domain")] == ["expiring", "inactive", "expiring"]
    assert result["items"] == [
        "The deploy token (CLOUDFLARE_API_TOKEN) expires 2026-11-20 (18 days): make a new one and replace the secret",
        "The analytics token (CLOUDFLARE_ANALYTICS_TOKEN) is disabled, not active",
        "The domain lmiawatch.ca expires 2026-11-25 (24 days); auto-renew is off",
    ]


def test_an_account_owned_token_is_verified_at_the_account_address():
    api = TokenApi({
        (DEPLOY_TOKEN, VERIFY_USER): refused(1000, "Invalid API Token", 401),
        (DEPLOY_TOKEN, VERIFY_ACCOUNT): verified(expires="2027-01-01T00:00:00Z"),
    })
    result = resilience.run_checks(FIRST, {**ENV, "CLOUDFLARE_ANALYTICS_TOKEN": ""}, api, domain="lmiawatch.ca", now=FIRST_NOW)
    assert result["deploy_token"]["state"] == "ok"
    assert result["analytics_token"] == {"state": "not set"}


def test_checks_that_get_no_readable_answer_are_unknown_and_name_no_token():
    api = TokenApi({
        (DEPLOY_TOKEN, VERIFY_USER): refused(1000, f"Invalid API Token {DEPLOY_TOKEN}", 401),
        (DEPLOY_TOKEN, VERIFY_ACCOUNT): ConnectionError("reset"),
        (ANALYTICS_TOKEN, VERIFY_USER): Resp(500, "oops"),
        (DEPLOY_TOKEN, REGISTRAR): Resp(200, json_data={"success": True, "result": {"auto_renew": True}}),
    })
    result = resilience.run_checks(FIRST, ENV, api, domain="lmiawatch.ca", now=FIRST_NOW)
    assert [result[k]["state"] for k in ("deploy_token", "analytics_token", "domain")] == ["unknown"] * 3
    assert result["items"] == []
    text = json.dumps(result)
    assert DEPLOY_TOKEN not in text and ANALYTICS_TOKEN not in text and "[token]" in text


def test_checks_command_writes_its_file_and_logs_no_token(tmp_path, monkeypatch, caplog):
    api = TokenApi({(DEPLOY_TOKEN, VERIFY_USER): verified(expires="2026-11-10T00:00:00Z"), ("", HOME): home_page()})
    monkeypatch.setattr(nightly, "_session", lambda: api)
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)
    out = tmp_path / "checks.json"
    with caplog.at_level(logging.INFO):
        assert nightly.main(["checks", "--today", "2026-11-01", "--domain", "lmiawatch.ca", "--site-url", SITE,
                             "--out", str(out)]) == 0
    written = json.loads(out.read_text())
    assert written["due"] is True and written["monthly"] is True
    assert written["deploy_token"]["state"] == "expiring" and len(written["items"]) == 1
    assert written["html_rewrite"]["state"] == "ok"
    assert DEPLOY_TOKEN not in caplog.text and ANALYTICS_TOKEN not in caplog.text
    # Another day: the HTML check runs, the expiry checks do not; the domain comes from --site-url.
    api.calls.clear()
    assert nightly.main(["checks", "--today", "2026-11-02", "--site-url", SITE, "--out", str(out)]) == 0
    written = json.loads(out.read_text())
    assert written["due"] is True and written["monthly"] is False and written["html_rewrite"]["state"] == "ok"
    assert "deploy_token" not in written and [url for url, _ in api.calls] == [HOME]


def test_the_domain_comes_from_the_site_address():
    assert resilience.domain_of("https://lmiawatch.ca") == "lmiawatch.ca"
    assert resilience.domain_of("https://lmiawatch.example") == ""
    assert resilience.domain_of("") == ""


# -- the nightly HTML check ---------------------------------------------------

BEACON = """<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="{&quot;token&quot;:&quot;x&quot;}"></script>"""
INJECTED = """<script defer src="https://static.cloudflareinsights.com/beacon.min.js/v1" data-cf-beacon='{"token": "y"}'></script>"""
REWRITE_HELP = ("In the dashboard, Web Analytics, lmiawatch.ca, Manage site must be 'Enable with JS Snippet installation', "
                "and Email Obfuscation, Automatic HTTPS Rewrites and Replace insecure JavaScript must be off.")


def home_page(status=200, etag='W/"0123abcd"', beacons=(BEACON,), encoding="gzip", body=None):
    headers = {"Content-Type": "text/html; charset=UTF-8"}
    if etag:
        headers["ETag"] = etag
    if encoding:
        headers["Content-Encoding"] = encoding
    text = body if body is not None else f"<!doctype html><html><head>{''.join(beacons)}</head><body>Data as of 2026-10-21</body></html>"
    return Resp(status, text, headers=headers)


def test_the_html_check_asks_like_a_browser_and_passes_a_page_left_alone():
    http = FakeHttp({HOME: home_page()})
    result = resilience.check_html_rewrite(http, SITE, NOW)
    assert result == {"checked_at": "2026-10-22T00:50:00+00:00", "status": 200, "etag": True, "beacons": 1,
                      "content_encoding": "gzip", "state": "ok"}
    [(url, headers)] = http.calls
    assert url == HOME
    assert headers["Accept"] == "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    assert headers["User-Agent"].startswith("Mozilla/5.0 (Windows NT 10.0; Win64; x64)") and "Chrome/" in headers["User-Agent"]
    assert headers["Accept-Encoding"] == "gzip"
    # A trailing slash on the site address changes nothing; no Content-Encoding reads as null.
    plain = resilience.check_html_rewrite(FakeHttp({HOME: home_page(encoding=None)}), SITE + "/", NOW)
    assert plain["state"] == "ok" and plain["content_encoding"] is None


def test_a_page_without_its_etag_or_with_a_second_beacon_is_rewritten():
    cases = [
        (home_page(etag=None), "no ETag", False, 1),
        (home_page(beacons=(BEACON, INJECTED)), "2 beacons", True, 2),
        (home_page(etag=None, beacons=(INJECTED, BEACON)), "no ETag and 2 beacons", False, 2),
        # The template's beacon gone and the edge's in its place, ETag dropped with it.
        (home_page(etag=None, beacons=(INJECTED,)), "no ETag", False, 1),
    ]
    for resp, wrong, etag, beacons in cases:
        result = resilience.check_html_rewrite(FakeHttp({HOME: resp}), SITE, NOW)
        assert result["state"] == "rewritten", wrong
        assert result["etag"] is etag and result["beacons"] == beacons
        assert result["item"] == (f"Cloudflare is rewriting the site's HTML again (home page for a browser-like request: "
                                  f"{wrong}). {REWRITE_HELP}")


def test_any_other_answer_is_unknown_and_raises_no_item():
    cases = [
        (home_page(status=500, etag=None, beacons=()), "HTTP 500"),
        (home_page(status=403, etag=None, beacons=(), body="<title>Just a moment...</title>"), "HTTP 403"),
        (home_page(body="<html><title>Just a moment...</title><div id='cf-chl-widget'></div></html>"),
         "the edge answered with a challenge"),
        (ConnectionError("reset"), "request failed (ConnectionError)"),
        (home_page(beacons=()), "200 with an ETag but no beacon in the page"),
    ]
    for answer, detail in cases:
        result = resilience.check_html_rewrite(FakeHttp({HOME: answer}), SITE, NOW)
        assert result["state"] == "unknown" and result["detail"] == detail and "item" not in result, detail
    # No site address (a dev machine without LMIAWATCH_SITE_URL): no request at all.
    http = FakeHttp({})
    assert resilience.check_html_rewrite(http, "https://lmiawatch.example", NOW) == {
        "state": "unknown", "detail": "no site address configured"}
    assert http.calls == []


def test_the_html_item_reaches_the_run_status_without_the_expiry_label():
    api = TokenApi({("", HOME): home_page(etag=None)})
    result = resilience.run_checks(TODAY, ENV, api, domain="lmiawatch.ca", site_url=SITE, now=NOW)
    assert result["html_rewrite"]["state"] == "rewritten" and "item" not in result["html_rewrite"]
    assert len(result["items"]) == 1 and result["items"][0].startswith("Cloudflare is rewriting")
    status = {"stages": [], "checks": {**result, "items": result["items"] + [
        "The domain lmiawatch.ca expires 2026-11-25 (24 days); auto-renew is off"]}}
    assert resilience.attention_items(status) == [
        result["items"][0],
        "Expiry check: The domain lmiawatch.ca expires 2026-11-25 (24 days); auto-renew is off",
    ]


# -- status, attention items and the issue ------------------------------------


def test_status_records_the_resilience_outcomes(tmp_path):
    db = tmp_path / "lmia.sqlite"
    make_db(db)
    steps = {"restore": "success", "pipeline": "success", "deploy": "success"}
    checks = {"due": True, "items": ["The domain lmiawatch.ca expires 2026-11-25 (24 days); auto-renew is off"]}
    status = nightly.run_status(db, "2000-01-01T00:00:00Z", {"problems": []}, "posted", steps, now=NOW,
                                restore_info={"source": "weekly", "weekly_key": "backups/weekly/db-slot-4.sqlite.gz",
                                              "weekly_uploaded": "2026-10-18T00:51:30+00:00", "counts": {"employers": 3}},
                                smoke={"verdict": "broken", "detail": "/ answered 500 and 500"},
                                rollback="rolled back", version_before=VERSION_A, checks=checks)
    assert status["steps"] == steps
    assert status["restore"] == {"source": "weekly", "weekly_key": "backups/weekly/db-slot-4.sqlite.gz",
                                 "weekly_uploaded": "2026-10-18T00:51:30+00:00"}
    assert (status["smoke"], status["rollback"], status["deploy_rolled_back"]) == ("broken", "rolled back", True)
    assert status["version_before"] == VERSION_A and status["checks"] == checks
    # The site was broken tonight even though it was put back.
    assert status["ok"] is False
    calm = nightly.run_status(db, "2000-01-01T00:00:00Z", {"problems": []}, "posted", steps, now=NOW,
                              smoke={"verdict": "unverifiable", "detail": "/: 403 from the edge"}, rollback="ignored")
    assert (calm["smoke"], calm["rollback"], calm["deploy_rolled_back"], calm["ok"]) == ("unverifiable", "not needed", False, True)
    bare = nightly.run_status(db, None, None, None, {})
    assert (bare["smoke"], bare["rollback"], bare["restore"], bare["version_before"]) == ("not run", "not needed", {"source": "not run"}, None)
    assert bare["checks"]["due"] is None and bare["deploy_rolled_back"] is False
    odd = nightly.run_status(db, None, None, None, {}, smoke={"verdict": "fine"}, version_before="$(id)")
    assert (odd["smoke"], odd["version_before"]) == ("not run", None)


def test_status_command_reads_the_new_files(tmp_path):
    db = tmp_path / "lmia.sqlite"
    make_db(db)
    deploy = tmp_path / "deploy"
    deploy.mkdir()
    (deploy / "smoke.json").write_text(json.dumps({"verdict": "broken", "detail": "/data answered 500 and 500"}))
    (deploy / "rollback.txt").write_text("failed\n")
    (deploy / "version_before.txt").write_text(VERSION_B + "\n")
    (tmp_path / "restore.json").write_text(json.dumps({"source": "backup", "message": "restored", "counts": {}}))
    (tmp_path / "checks.json").write_text(json.dumps({"due": False, "date": "2026-10-22", "items": []}))
    out = tmp_path / "status.json"
    assert nightly.main(["status", "--db", str(db), "--restore", str(tmp_path / "restore.json"),
                         "--smoke", str(deploy / "smoke.json"), "--rollback-outcome", str(deploy / "rollback.txt"),
                         "--version-before", str(deploy / "version_before.txt"), "--checks", str(tmp_path / "checks.json"),
                         "--step", "deploy=success", "--out", str(out)]) == 0
    written = json.loads(out.read_text())
    assert (written["smoke"], written["rollback"], written["deploy_rolled_back"]) == ("broken", "failed", False)
    assert written["restore"] == {"source": "backup"} and written["checks"]["due"] is False
    assert written["steps"] == {"deploy": "success"} and written["version_before"] == VERSION_B


def test_attention_items_keep_the_existing_wording():
    status = {
        "stages": [{"source": "jobbank", "ok": False, "detail": "HTTP 503"}, {"source": "esdc", "ok": True}],
        "x_post": "failed", "bluesky_post": "no credentials", "zenodo_deposit": "failed",
        "search_sync": "failed", "views_rollup": "failed",
    }
    assert resilience.attention_items(status) == [
        "jobbank: HTTP 503",
        "X post: failed",
        "Bluesky post: no credentials",
        "Zenodo deposit: failed (tried again next run)",
        "Search database sync: failed (sent again next run)",
        "Audience roll-up: failed (caught up next run)",
    ]
    assert resilience.attention_items(None) == ["no run status was written"]
    assert resilience.attention_items({"stages": [], "x_post": "posted", "smoke": "unverifiable"}) == []


def test_only_an_indexnow_rejection_is_an_item():
    rejected = {"stages": [], "indexnow": "rejected (403)"}
    assert resilience.attention_items(rejected) == ["IndexNow: rejected; check the key file"]
    for outcome in ("submitted 613 URLs", "rate limited", "failed", "off", "dry run (12 URLs)", "not run", None, 403):
        assert resilience.attention_items({"stages": [], "indexnow": outcome}) == []
    # A status from before the field existed.
    assert resilience.attention_items({"stages": []}) == []


def test_an_unverified_x_post_asks_for_a_look_at_the_account():
    status = {"stages": [], "x_post": "unverified", "bluesky_post": "posted"}
    assert resilience.attention_items(status) == ["X post: unverified after an error from X; check the account"]


def test_attention_items_for_a_rollback_a_weekly_restore_and_the_checks():
    status = {"stages": [], "smoke": "broken", "smoke_detail": "/ answered 500 and 500", "deploy_rolled_back": True,
              "version_before": VERSION_A, "restore": {"source": "weekly", "weekly_key": "backups/weekly/db-slot-4.sqlite.gz",
                                                       "weekly_uploaded": "2026-10-18T00:51:30+00:00"},
              "checks": {"due": True, "items": ["The domain lmiawatch.ca expires 2026-11-25 (24 days); auto-renew is off"]}}
    assert resilience.attention_items(status) == [
        f"Deploy rolled back: the site answered with server errors after the deploy (/ answered 500 and 500); "
        f"the Worker is back on version {VERSION_A}, with the previous data, and a later run tries again",
        "Restored from the weekly snapshot backups/weekly/db-slot-4.sqlite.gz (uploaded 2026-10-18T00:51:30+00:00): "
        "both nightly backups were missing or damaged, so the Job Bank observations since that snapshot are lost",
        "Expiry check: The domain lmiawatch.ca expires 2026-11-25 (24 days); auto-renew is off",
    ]
    stuck = {"stages": [], "smoke": "broken", "smoke_detail": "/data answered 502 and 500", "deploy_rolled_back": False,
             "rollback": "no version recorded"}
    assert resilience.attention_items(stuck) == [
        "Deploy broken: the site answered with server errors after the deploy (/data answered 502 and 500) "
        "and was not rolled back (no version recorded)",
    ]


def test_the_issue_texts():
    texts = resilience.issue_texts(["jobbank: HTTP 503", "X post: failed"], "https://github.com/o/r/actions/runs/7", "2026-10-22")
    assert texts["title"] == "Nightly run needs attention"
    assert texts["body"] == (
        "The nightly run of 2026-10-22 found 2 items needing attention:\n\n"
        "1. jobbank: HTTP 503\n2. X post: failed\n\n"
        "Run: https://github.com/o/r/actions/runs/7\n\n"
        "Each run updates this issue while an item remains, and the first run with none closes it.\n"
    )
    assert texts["comment"] == (
        "The run of 2026-10-22 still finds:\n\n1. jobbank: HTTP 503\n2. X post: failed\n\n"
        "Run: https://github.com/o/r/actions/runs/7\n"
    )
    assert texts["close"] == "The run of 2026-10-22 finished with nothing needing attention: https://github.com/o/r/actions/runs/7\n"
    assert "found 1 item needing" in resilience.issue_texts(["x"], "u", "d")["body"]
    for text in texts.values():
        assert chr(0x2014) not in text


def test_attention_command_writes_the_issue_texts_and_its_exit_code(tmp_path, capsys):
    status = tmp_path / "status.json"
    status.write_text(json.dumps({"run_at": "2026-10-22T00:48:10+00:00", "stages": [], "search_sync": "failed"}))
    out = tmp_path / "attention"
    assert nightly.main(["attention", "--status", str(status), "--run-url", "https://example.org/run/1", "--out-dir", str(out)]) == 1
    assert capsys.readouterr().out == "ATTENTION: Search database sync: failed (sent again next run)\n"
    assert (out / "items.txt").read_text() == "Search database sync: failed (sent again next run)\n"
    assert (out / "body.md").read_text().startswith("The nightly run of 2026-10-22 found 1 item needing attention:")
    assert (out / "title.txt").read_text() == "Nightly run needs attention"
    status.write_text(json.dumps({"run_at": "2026-10-23T00:48:10+00:00", "stages": []}))
    assert nightly.main(["attention", "--status", str(status), "--run-url", "https://example.org/run/2", "--out-dir", str(out)]) == 0
    assert (out / "items.txt").read_text() == ""
    assert (out / "close.md").read_text() == "The run of 2026-10-23 finished with nothing needing attention: https://example.org/run/2\n"
    assert nightly.main(["attention", "--status", str(tmp_path / "none.json"), "--run-url", "u", "--out-dir", str(out)]) == 1
    assert (out / "items.txt").read_text() == "no run status was written\n"


NOTICES = [
    {"source": "gov_notices", "detail": "Government notice: 2026-10-26 Express Entry measure https://www.canada.ca/en/m.html"},
    {"source": "high_wage", "detail": "IRCC high-wage list changed and was adopted for grading from 2026-10-26: 1 added"},
    {"source": "registers", "detail": "Designated-employer lists read again: aip_nl"},
]


def test_notices_are_information_never_items_needing_attention():
    status = {"run_at": "2026-10-27T00:48:10+00:00", "ok": True, "stages": [{"source": "gov_notices", "ok": True}],
              "notices": NOTICES + [{"source": "x"}, "junk"]}
    assert resilience.attention_items(status) == []
    assert resilience.notice_items(status) == [
        "gov_notices: Government notice: 2026-10-26 Express Entry measure https://www.canada.ca/en/m.html",
        "high_wage: IRCC high-wage list changed and was adopted for grading from 2026-10-26: 1 added",
        "registers: Designated-employer lists read again: aip_nl",
    ]
    assert resilience.notice_items(None) == []
    # A failed stage beside them is still an item needing attention.
    failed = {**status, "stages": [{"source": "jobbank", "ok": False, "detail": "HTTP 503"}]}
    assert resilience.attention_items(failed) == ["jobbank: HTTP 503"]


def test_the_attention_command_passes_with_notices_alone_and_prints_them(tmp_path, capsys):
    status = tmp_path / "status.json"
    status.write_text(json.dumps({"run_at": "2026-10-27T00:48:10+00:00", "ok": True, "stages": [], "notices": NOTICES}))
    out = tmp_path / "attention"
    assert nightly.main(["attention", "--status", str(status), "--run-url", "u", "--out-dir", str(out)]) == 0
    printed = capsys.readouterr().out
    assert printed.startswith("NOTICE: gov_notices: Government notice: 2026-10-26 Express Entry measure")
    assert "ATTENTION" not in printed
    # Nothing for the issue: the step neither opens nor updates it.
    assert (out / "items.txt").read_text() == ""


def test_the_notices_command_writes_the_section_for_last_run(tmp_path, capsys):
    status = tmp_path / "status.json"
    status.write_text(json.dumps({"run_at": "2026-10-27T00:48:10+00:00", "stages": [], "notices": NOTICES}))
    assert nightly.main(["notices", "--status", str(status)]) == 0
    assert capsys.readouterr().out == (
        "Notices from this run (information; nothing failed):\n\n"
        "- gov_notices: Government notice: 2026-10-26 Express Entry measure https://www.canada.ca/en/m.html\n"
        "- high_wage: IRCC high-wage list changed and was adopted for grading from 2026-10-26: 1 added\n"
        "- registers: Designated-employer lists read again: aip_nl\n"
    )
    status.write_text(json.dumps({"run_at": "2026-10-27T00:48:10+00:00", "stages": []}))
    assert nightly.main(["notices", "--status", str(status)]) == 0
    assert nightly.main(["notices", "--status", str(tmp_path / "none.json")]) == 0
    assert capsys.readouterr().out == ""


def test_the_workflow_keeps_notices_out_of_the_attention_step_and_records_them():
    text = (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "nightly.yml").read_text(encoding="utf-8")
    record = text.split("- name: Record the run so the schedule stays enabled", 1)[1].split("\n      - ", 1)[0]
    assert ("python -m lmia_pipeline.nightly notices --status data/out/status.json > data/out/notices.md "
            "2>/dev/null || true") in record
    assert "cat data/out/notices.md >> LAST_RUN.md" in record
    attention = text.split("- name: Items needing attention", 1)[1].split("\n      - ", 1)[0]
    assert "exit $code" in attention and "notices" not in attention.split("run: |", 1)[1]


def test_a_clean_night_with_the_new_fields_has_no_items(tmp_path):
    db = tmp_path / "lmia.sqlite"
    make_db(db)
    conn = connect(db)
    log_run(conn, "export", detail="static {}")
    conn.close()
    status = nightly.run_status(db, "2000-01-01T00:00:00Z", {"problems": []}, "posted",
                                {"restore": "success", "deploy": "success"}, now=NOW,
                                restore_info={"source": "backup"}, smoke={"verdict": "ok", "detail": "4 pages"},
                                checks={"due": True, "items": [], "domain": {"state": "unknown"}})
    assert status["ok"] is True and resilience.attention_items(status) == []
