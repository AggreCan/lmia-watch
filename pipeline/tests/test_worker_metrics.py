"""The nightly record of the Worker's CPU time, against a stub session: nothing here reaches the network."""

from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, timedelta, timezone

import pytest
import requests

from lmia_pipeline import config, worker_metrics as wm

ACCOUNT = "0123456789abcdef0123456789abcdef"
TOKEN = "analytics-token-value"
ENV = {wm.TOKEN_ENV: TOKEN}
NOW = datetime(2026, 11, 3, 0, 40, tzinfo=timezone.utc)  # yesterday is 2026-11-02


class FakeResponse:
    def __init__(self, status: int, body: object = None, text: str | None = None) -> None:
        self.status_code = status
        self._body = body
        self.text = text if text is not None else json.dumps(body)

    def json(self) -> object:
        if self._body is None:
            raise ValueError("no json")
        return self._body


def group(day: str, requests_: int = 100_000, cpu_us: float = 1_000_000_000, startup_us: float = 300_000_000,
          **quantiles) -> dict:
    """One group of the answer, in the shape the GraphQL API gives it."""
    q = {"cpuTimeP50": 4200, "cpuTimeP90": 20500, "cpuTimeP99": 95000, "startupCpuTimeUsP50": 3100,
         "memoryUsageBytesP50": 3 * 1024 * 1024}
    q.update(quantiles)
    return {
        "dimensions": {"date": day},
        "sum": {"requests": requests_, "errors": 12, "subrequests": 40, "cpuTimeUs": cpu_us,
                "startupCpuTimeUs": startup_us, "responseBodySize": 12_345_678},
        "quantiles": q,
    }


def answer(groups: list[dict]) -> FakeResponse:
    return FakeResponse(200, {"data": {"viewer": {"accounts": [{"inv": groups}]}}, "errors": None})


class FakeHttp:
    """Stands in for requests.Session. Answers each POST with the groups of
    `days` (date text -> group) that fall in the window the variables ask
    for, or with `fail` for every POST."""

    def __init__(self, days: dict[str, dict] | None = None, *, fail: FakeResponse | Exception | None = None,
                 extra: list[dict] | None = None) -> None:
        self.days = days or {}
        self.fail = fail
        self.extra = extra or []  # groups answered whatever the window
        self.posts: list[dict] = []
        self.closed = False

    def post(self, url, json=None, headers=None, timeout=None):
        self.posts.append({"url": url, "json": json, "headers": headers or {}})
        if isinstance(self.fail, Exception):
            raise self.fail
        if self.fail is not None:
            return self.fail
        since = json["variables"]["since"][:10]
        until = json["variables"]["until"][:10]
        return answer([g for d, g in sorted(self.days.items()) if since <= d < until] + self.extra)

    def close(self):
        self.closed = True


def read_rows(path) -> tuple[list[str], list[dict]]:
    reader = csv.DictReader(io.StringIO(path.read_text(encoding="utf-8")))
    return list(reader.fieldnames or []), list(reader)


def held_file(path, rows: list[dict]) -> None:
    wm.write_file(path, wm.derive(wm.merge([], rows)))


def held_row(day: str, cpu_ms: int, requests_: int = 100_000, **extra) -> dict:
    row = dict.fromkeys(wm.HEADER, "")
    row.update(date=day, requests=str(requests_), errors="0", subrequests="0", cpu_ms=str(cpu_ms),
               startup_cpu_ms=str(cpu_ms // 4))
    row.update(extra)
    return row


def run(path, http, **kw):
    return wm.run(path, account=kw.pop("account", ACCOUNT), env=kw.pop("env", ENV), session=http,
                  now=kw.pop("now", NOW), **kw)


# -- the query ------------------------------------------------------------------


def test_one_post_per_window_with_the_token_only_in_the_header():
    http = FakeHttp({"2026-11-12": group("2026-11-12")})
    rows, detail = wm.fetch_days(http, ACCOUNT, TOKEN, "lmia-watch", [date(2026, 11, 12), date(2026, 11, 13)])
    assert detail == "" and [r["date"] for r in rows] == ["2026-11-12"]
    (post,) = http.posts
    assert post["url"] == "https://api.cloudflare.com/client/v4/graphql"
    assert post["json"]["query"] == wm.QUERY
    assert post["json"]["variables"] == {"acct": ACCOUNT, "since": "2026-11-12T00:00:00Z",
                                         "until": "2026-11-14T00:00:00Z", "script": "lmia-watch"}
    assert post["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert post["headers"]["User-Agent"] == config.USER_AGENT
    assert TOKEN not in json.dumps(post["json"])
    # The query asks the account-level dataset, filtered on the script, grouped by date.
    for part in ("accounts(filter:{accountTag:$acct})", "workersInvocationsAdaptive", "scriptName:$script",
                 "datetime_lt:$until", "dimensions{date}", "cpuTimeUs", "startupCpuTimeUs", "memoryUsageBytesP50"):
        assert part in wm.QUERY, part


# -- rows and the derived columns -------------------------------------------------


def test_an_answer_becomes_rows_with_the_derived_columns_across_a_month_boundary(tmp_path):
    path = tmp_path / "worker_cpu.csv"
    held_file(path, [held_row("2026-10-30", 1_000_000)])
    http = FakeHttp({
        "2026-10-31": group("2026-10-31", 150_000, 1_500_000_000, 450_000_000),
        "2026-11-01": group("2026-11-01", 250_000, 2_000_000_000, 500_000_000),
        "2026-11-02": group("2026-11-02", 100_000, 1_000_400_400, 250_000_000, cpuTimeP99=95123.4),
    })
    summary = run(path, http)
    assert summary["state"] == "ok" and summary["detail"] == "3 days fetched"
    assert summary["days_fetched"] == ["2026-10-31", "2026-11-01", "2026-11-02"]
    assert len(http.posts) == 1  # three days fit in one window
    header, rows = read_rows(path)
    assert header == wm.HEADER == [
        "date", "requests", "errors", "subrequests", "cpu_ms", "startup_cpu_ms", "mean_cpu_ms", "startup_share",
        "cpu_p50_ms", "cpu_p90_ms", "cpu_p99_ms", "startup_p50_ms", "memory_p50_mb", "body_bytes",
        "month_to_date_cpu_ms", "month_projection_cpu_ms", "included_cpu_ms"]
    by_date = {r["date"]: r for r in rows}
    assert list(by_date) == ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]

    oct31 = by_date["2026-10-31"]
    assert {k: oct31[k] for k in wm.HEADER} == {
        "date": "2026-10-31", "requests": "150000", "errors": "12", "subrequests": "40",
        "cpu_ms": "1500000", "startup_cpu_ms": "450000",
        "mean_cpu_ms": "10.000",            # 1,500,000 / 150,000
        "startup_share": "0.300",           # 450,000 / 1,500,000
        "cpu_p50_ms": "4.200", "cpu_p90_ms": "20.500", "cpu_p99_ms": "95.000", "startup_p50_ms": "3.100",
        "memory_p50_mb": "3.00", "body_bytes": "12345678",
        "month_to_date_cpu_ms": "2500000",  # 1,000,000 on the 30th + 1,500,000
        "month_projection_cpu_ms": "2500000",  # the month's last day: no scaling
        "included_cpu_ms": "30000000",
    }
    # The 30th, written before: its month to date and projection (x 31 / 30).
    assert (by_date["2026-10-30"]["month_to_date_cpu_ms"], by_date["2026-10-30"]["month_projection_cpu_ms"]) == (
        "1000000", "1033333")
    # A new month starts from nothing.
    nov1, nov2 = by_date["2026-11-01"], by_date["2026-11-02"]
    assert (nov1["mean_cpu_ms"], nov1["startup_share"]) == ("8.000", "0.250")
    assert (nov1["month_to_date_cpu_ms"], nov1["month_projection_cpu_ms"]) == ("2000000", "60000000")  # x 30 / 1
    assert nov2["cpu_ms"] == "1000400"  # 1,000,400,400 microseconds, rounded to the millisecond
    assert nov2["mean_cpu_ms"] == "10.004"
    assert nov2["cpu_p99_ms"] == "95.123"
    assert (nov2["month_to_date_cpu_ms"], nov2["month_projection_cpu_ms"]) == ("3000400", "45006000")  # x 30 / 2

    assert summary["yesterday"] == {"date": "2026-11-02", "requests": 100_000, "cpu_ms": 1_000_400,
                                    "mean_cpu_ms": 10.004, "startup_share": 0.25}
    assert (summary["month"], summary["month_to_date_cpu_ms"], summary["month_projection_cpu_ms"],
            summary["included_cpu_ms"]) == ("2026-11", 3_000_400, 45_006_000, 30_000_000)
    assert not list(tmp_path.glob("*.partial"))
    assert not http.closed  # a session handed in belongs to the caller


def test_merge_replaces_a_same_date_row_and_appends_new_ones():
    held = wm.derive(wm.merge([], [held_row("2026-11-01", 1_000_000, included_cpu_ms="25000000"),
                                   held_row("2026-11-02", 2_000_000)]))
    new = [held_row("2026-11-02", 500_000), held_row("2026-11-03", 700_000)]
    rows = wm.derive(wm.merge(held, new))
    assert [(r["date"], r["cpu_ms"], r["month_to_date_cpu_ms"]) for r in rows] == [
        ("2026-11-01", "1000000", "1000000"), ("2026-11-02", "500000", "1500000"), ("2026-11-03", "700000", "2200000")]
    # A row kept keeps the allowance it was written with; new and replaced rows take today's.
    assert [r["included_cpu_ms"] for r in rows] == ["25000000", "30000000", "30000000"]
    assert held[1]["cpu_ms"] == "2000000"  # the rows passed in are not changed


def test_a_day_outside_the_window_asked_is_never_written(tmp_path):
    path = tmp_path / "worker_cpu.csv"
    held_file(path, [held_row("2026-11-01", 1_000_000)])
    # Cloudflare answering with today's partial day as well: left out.
    http = FakeHttp({"2026-11-02": group("2026-11-02")}, extra=[group("2026-11-03")])
    assert run(path, http)["days_fetched"] == ["2026-11-02"]
    _, rows = read_rows(path)
    assert [r["date"] for r in rows] == ["2026-11-01", "2026-11-02"]


# -- the catch-up -----------------------------------------------------------------


def test_the_catch_up_starts_after_the_last_row_or_at_the_baseline_and_never_reaches_today():
    yesterday = date(2026, 11, 13)
    assert wm.days_to_fetch(date(2026, 11, 10), yesterday) == [date(2026, 11, d) for d in (11, 12, 13)]
    assert wm.days_to_fetch(yesterday, yesterday) == []
    first = wm.days_to_fetch(None, yesterday)
    assert first[0] == wm.BASELINE_DAY == date(2026, 11, 1) and first[-1] == yesterday and len(first) == 13
    # Never more than 90 days, and never further back than Cloudflare keeps.
    long_ago = wm.days_to_fetch(date(2026, 1, 1), yesterday)
    assert len(long_ago) == wm.MAX_DAYS == 90
    assert long_ago[0] == yesterday - timedelta(days=89) and long_ago[-1] == yesterday
    later = date(2027, 6, 30)
    assert wm.days_to_fetch(None, later)[0] == later - timedelta(days=89)


def test_a_long_catch_up_is_asked_a_week_at_a_time_and_stops_before_today(tmp_path):
    path = tmp_path / "worker_cpu.csv"
    now = datetime(2026, 11, 21, 0, 40, tzinfo=timezone.utc)  # yesterday is the 20th
    days = {f"2026-11-{d:02d}": group(f"2026-11-{d:02d}") for d in range(1, 22)}  # the 21st is today
    http = FakeHttp(days)
    summary = run(path, http, now=now)
    windows = [(p["json"]["variables"]["since"], p["json"]["variables"]["until"]) for p in http.posts]
    assert windows == [("2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z"),
                       ("2026-11-08T00:00:00Z", "2026-11-15T00:00:00Z"),
                       ("2026-11-15T00:00:00Z", "2026-11-21T00:00:00Z")]
    assert summary["days_fetched"][0] == "2026-11-01" and summary["days_fetched"][-1] == "2026-11-20"
    _, rows = read_rows(path)
    assert len(rows) == 20 and rows[-1]["date"] == "2026-11-20"

    # Nothing left to ask: no request, the file untouched, yesterday read from it.
    before = path.read_bytes()
    again = FakeHttp(days)
    summary = run(path, again, now=now)
    assert again.posts == [] and path.read_bytes() == before
    assert (summary["state"], summary["detail"], summary["days_fetched"]) == ("ok", "up to date", [])
    assert summary["yesterday"]["date"] == "2026-11-20" and summary["month_to_date_cpu_ms"] == 20 * 1_000_000


def test_days_cloudflare_has_no_figures_for_are_asked_again(tmp_path):
    path = tmp_path / "worker_cpu.csv"
    summary = run(path, FakeHttp({}))
    assert (summary["state"], summary["detail"]) == ("ok", "no figures for the 2 days asked")
    assert summary["days_fetched"] == [] and summary["yesterday"] is None and summary["month_to_date_cpu_ms"] is None
    assert not path.exists()


# -- failures ---------------------------------------------------------------------


@pytest.mark.parametrize("fail, words", [
    (FakeResponse(200, {"data": None, "errors": [{"message": "unknown field cpuTimeP50",
                                                 "path": ["viewer"], "extensions": {"code": "x"}}]}),
     "GraphQL error: unknown field cpuTimeP50"),
    (FakeResponse(500, None, "internal error"), "HTTP 500: internal error"),
    (requests.ConnectionError("connection reset"), "request failed (ConnectionError)"),
    (FakeResponse(200, {"data": {"viewer": {"accounts": []}}, "errors": None}), "no account in the answer"),
    (FakeResponse(200, {"data": {"viewer": None}}), "no data.viewer.accounts"),
    (FakeResponse(200, {"data": {"viewer": {"accounts": [{"inv": {"x": 1}}]}}}), "no list of invocation groups"),
    (FakeResponse(200, None, "<html>"), "without JSON"),
    (answer([{"dimensions": {"date": "2026-11-02"}, "sum": {"requests": 1}, "quantiles": {}}]),
     "errors on 2026-11-02 is not a figure"),
    (answer([group("2026-11-02", cpu_us=-5)]), "cpuTimeUs on 2026-11-02 is not a figure"),
    (answer([group("2026-11-02"), group("2026-11-02")]), "2026-11-02 appears twice"),
    (answer([group("Nov 2")]), "a group's date reads"),
])
def test_every_failure_is_failed_with_a_detail_and_leaves_the_file_as_it_was(tmp_path, caplog, fail, words):
    path = tmp_path / "worker_cpu.csv"
    held_file(path, [held_row("2026-10-31", 1_000_000)])
    before = path.read_bytes()
    summary = run(path, FakeHttp(fail=fail))
    assert summary["state"] == "failed"
    assert words in summary["detail"], summary["detail"]
    assert summary["detail"].startswith("2026-11-01 to 2026-11-02: ")
    assert summary["days_fetched"] == [] and summary["yesterday"] is None
    assert path.read_bytes() == before
    assert TOKEN not in json.dumps(summary) and TOKEN not in caplog.text


def test_a_failure_part_way_through_a_catch_up_writes_nothing(tmp_path):
    path = tmp_path / "worker_cpu.csv"

    class FailsLater(FakeHttp):
        def post(self, url, json=None, headers=None, timeout=None):
            if self.posts:
                self.posts.append({"url": url, "json": json, "headers": headers})
                return FakeResponse(502, None, "bad gateway")
            return super().post(url, json=json, headers=headers, timeout=timeout)

    days = {f"2026-11-{d:02d}": group(f"2026-11-{d:02d}") for d in range(1, 21)}
    summary = run(path, FailsLater(days), now=datetime(2026, 11, 21, 1, tzinfo=timezone.utc))
    assert summary["state"] == "failed" and summary["detail"].startswith("2026-11-08 to 2026-11-14: HTTP 502")
    assert not path.exists()


def test_without_a_token_or_an_account_id_it_is_no_credentials_and_asks_nothing(tmp_path):
    path = tmp_path / "worker_cpu.csv"
    http = FakeHttp({"2026-11-02": group("2026-11-02")})
    for env, account in (({}, ACCOUNT), ({wm.TOKEN_ENV: "  "}, ACCOUNT), (ENV, ""), (ENV, None)):
        summary = run(path, http, env=env, account=account)
        assert summary["state"] == "no credentials", (env, account)
        assert summary["included_cpu_ms"] == wm.WORKERS_CPU_INCLUDED_MS
    assert http.posts == [] and not path.exists()


def test_a_malformed_account_id_or_script_is_failed_before_any_request(tmp_path):
    http = FakeHttp()
    assert run(tmp_path / "a.csv", http, account="abc/../../zones")["state"] == "failed"
    assert wm.run(tmp_path / "a.csv", account=ACCOUNT, script="Bad Name", env=ENV, session=http,
                  now=NOW)["state"] == "failed"
    assert http.posts == []


def test_a_file_that_cannot_be_read_safely_is_never_replaced(tmp_path):
    path = tmp_path / "worker_cpu.csv"
    bad = [
        "",
        "date,requests,cpu_ms,visitor_ip\n2026-11-01,1,1,x\n",          # a column this code does not know
        "date,requests\n2026-11-01,1\n",                                 # a column it needs is missing
        "date,requests,cpu_ms\nnot-a-date,1,1\n",
        "date,requests,cpu_ms\n2026-11-01,1,many\n",
        "date,requests,cpu_ms\n2026-11-01,1,1,extra\n",                  # one field too many
    ]
    for text in bad:
        path.write_text(text, encoding="utf-8")
        http = FakeHttp({"2026-11-02": group("2026-11-02")})
        summary = run(path, http)
        assert summary["state"] == "failed", text
        assert "left as it is" in summary["detail"]
        assert path.read_text(encoding="utf-8") == text and http.posts == []


def test_a_file_written_before_a_newer_column_reads_with_it_blank(tmp_path):
    path = tmp_path / "worker_cpu.csv"
    path.write_text("date,requests,cpu_ms\n2026-11-01,100,1000\n", encoding="utf-8")
    assert run(path, FakeHttp({"2026-11-02": group("2026-11-02")}))["state"] == "ok"
    header, rows = read_rows(path)
    assert header == wm.HEADER
    assert (rows[0]["startup_cpu_ms"], rows[0]["startup_share"], rows[0]["mean_cpu_ms"]) == ("", "", "10.000")


def test_the_session_is_made_and_closed_when_none_is_handed_in(tmp_path, monkeypatch):
    fake = FakeHttp({"2026-11-02": group("2026-11-02")})
    monkeypatch.setattr(requests, "Session", lambda: fake)
    summary = wm.run(tmp_path / "worker_cpu.csv", account=ACCOUNT, env=ENV, now=NOW)
    assert summary["state"] == "ok" and fake.closed


# -- the run status and LAST_RUN.md -----------------------------------------------

EXAMPLE = {
    "state": "ok", "detail": "1 day fetched", "days_fetched": ["2026-11-13"], "day": "2026-11-13",
    "yesterday": {"date": "2026-11-13", "requests": 238_037, "cpu_ms": 2_305_908, "mean_cpu_ms": 9.687,
                  "startup_share": 0.320},
    "month": "2026-11", "month_to_date_cpu_ms": 26_100_000, "month_projection_cpu_ms": 48_200_000,
    "included_cpu_ms": 30_000_000,
}


def test_the_last_run_line():
    field = wm.status_field(EXAMPLE)
    assert wm.last_run_line(field) == (
        "Worker CPU: 2026-11-13: 2,305,908 ms over 238,037 requests (9.7 ms mean, start-up 32%); "
        "month to date 26.1M of 30M included, projection 48.2M")
    assert wm.last_run_line(wm.status_field({"state": "failed", "detail": "2026-11-13 to 2026-11-13: HTTP 500: x"})) == (
        "Worker CPU: failed (caught up next run): 2026-11-13 to 2026-11-13: HTTP 500: x")
    assert wm.last_run_line(wm.status_field({"state": "no credentials", "detail": "no account id"})) == (
        "Worker CPU: no credentials")
    assert wm.last_run_line(wm.status_field(None)) is None
    assert wm.last_run_line(None) is None
    quiet = dict(EXAMPLE, yesterday=None, detail="no figures for the 1 day asked")
    assert wm.last_run_line(wm.status_field(quiet)) == (
        "Worker CPU: no figures for 2026-11-13 (no figures for the 1 day asked); "
        "month to date 26.1M of 30M included, projection 48.2M")


def test_the_status_field_keeps_known_keys_and_checks_each_one():
    assert wm.status_field(None) == {"state": "not run"}
    assert wm.status_field("ok") == {"state": "not run"}
    assert wm.status_field({"state": "rolled up"}) == {"state": "failed",
                                                       "detail": "the step's outcome could not be read"}
    field = wm.status_field(dict(EXAMPLE, token=TOKEN, days_fetched=["2026-11-13", "x", 5],
                                 month_to_date_cpu_ms=-1, yesterday={"date": "2026-11-13", "requests": "1"}))
    assert TOKEN not in json.dumps(field)
    assert field["days_fetched"] == ["2026-11-13"]
    assert field["month_to_date_cpu_ms"] is None and field["yesterday"] is None
    assert set(field) == {"state", "detail", "days_fetched", "day", "yesterday", "month", "month_to_date_cpu_ms",
                          "month_projection_cpu_ms", "included_cpu_ms"}
    # The line the workflow writes before the step starts, for a step stopped part way.
    assert wm.status_field({"state": "failed", "detail": "the step stopped before it finished"})["state"] == "failed"
