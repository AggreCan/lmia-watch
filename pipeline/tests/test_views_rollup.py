"""The audience roll-up, against a stub session: nothing here reaches the network."""

from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest
import requests

from lmia_pipeline import cli, config, nightly, views_rollup as vr

ACCOUNT = "0123456789abcdef0123456789abcdef"
TOKEN = "analytics-token-value"
ENV = {vr.TOKEN_ENV: TOKEN, vr.ACCOUNT_ENV: ACCOUNT, "BSKY_HANDLE": "lmiawatch.ca"}
NOW = datetime(2026, 10, 22, 0, 40, tzinfo=timezone.utc)
YESTERDAY = date(2026, 10, 21)
START = 1792540800  # 2026-10-21T00:00:00Z


class FakeResponse:
    def __init__(self, status: int, body: object = None, text: str | None = None) -> None:
        self.status_code = status
        self._body = body
        self.text = text if text is not None else json.dumps(body)

    def json(self) -> object:
        if self._body is None:
            raise ValueError("no json")
        return self._body


def answer(rows: list[dict]) -> FakeResponse:
    # The shape the SQL API gives with FORMAT JSON; 64-bit sums come quoted.
    return FakeResponse(200, {"meta": [], "data": rows, "rows": len(rows)})


KINDS = [{"kind": "page", "responses": "120"}, {"kind": "api", "responses": "30"},
         {"kind": "download", "responses": "4"}, {"kind": "form", "responses": "1"},
         {"kind": "feed", "responses": "40"}, {"kind": "hook", "responses": "2"}, {"kind": "other", "responses": "9"}]
COUNTS = [
    {"route": "/employers/:id", "kind": "page", "lang": "en", "country": "CA", "referrer": "news.example.org",
     "status": 200, "responses": "70"},
    {"route": "/", "kind": "page", "lang": "fr", "country": "CA", "referrer": "", "status": 200, "responses": "50"},
    {"route": "/api/stats", "kind": "api", "lang": "en", "country": "US", "referrer": "", "status": 200, "responses": "30"},
    {"route": "/downloads/employers.csv", "kind": "download", "lang": "en", "country": "", "referrer": "",
     "status": 200, "responses": "4"},
    {"route": "/corrections", "kind": "form", "lang": "en", "country": "CA", "referrer": "lmiawatch.ca",
     "status": 200, "responses": "1"},
    {"route": "/data/feeds/:file", "kind": "feed", "lang": "en", "country": "US", "referrer": "", "status": 200,
     "responses": "36"},
    {"route": "/data/feeds/:file", "kind": "feed", "lang": "en", "country": "US", "referrer": "", "status": 404,
     "responses": "4"},
    {"route": "/hooks/kofi", "kind": "hook", "lang": "en", "country": "", "referrer": "", "status": 200, "responses": "2"},
    {"route": "other", "kind": "other", "lang": "en", "country": "NL", "referrer": "", "status": 404, "responses": "9"},
]
FEEDS = [
    {"feed": "", "responses": "4", "subscribers": 0},
    {"feed": "feeds/canada/pending.xml", "responses": "30", "subscribers": 12},
    {"feed": "feeds/prov/BC/approved.xml", "responses": "6", "subscribers": 3.0},
]


# What Analytics Engine answers for a day counted before the bot flag: every
# page point has an empty blob8, and no point is a person's.
UNFLAGGED = {
    "audience": [{"agent": "", "country": "CA", "device": "", "lang": "en", "pages": "120"}],
    "routes": [],
    "visitors": [{"visitors": "0", "uncoded": "0"}],
    "visits": [{"visits": "0"}],
}


class FakeHttp:
    """Stands in for requests.Session. Answers the SQL API per day from `days`
    (day -> (kinds, counts, feeds) or (kinds, counts, feeds, audience answers);
    a day not listed has no data points; three answers stand for a day before
    the bot flag; an audience dict without "cache" stands for a day before the
    page cache), the Bluesky profile from `profile` and the X profile from
    `x_profile`. `fail` replaces every SQL answer."""

    def __init__(self, days: dict | None = None, *, fail: FakeResponse | Exception | None = None,
                 profile: FakeResponse | Exception | None = None,
                 x_profile: FakeResponse | Exception | None = None) -> None:
        self.days = {YESTERDAY: (KINDS, COUNTS, FEEDS)} if days is None else days
        self.fail = fail
        self.profile = profile or FakeResponse(200, {"did": "did:plc:x", "handle": "lmiawatch.ca", "followersCount": 57})
        self.x_profile = x_profile or FakeResponse(200, {"data": {"id": "1", "public_metrics": {"followers_count": 31}}})
        self.posts: list[dict] = []
        self.gets: list[dict] = []
        self.closed = False

    def post(self, url, data=None, headers=None, timeout=None):
        sql = data.decode("utf-8")
        self.posts.append({"url": url, "sql": sql, "headers": headers or {}})
        if isinstance(self.fail, Exception):
            raise self.fail
        if self.fail is not None:
            return self.fail
        # The start bound names the day (its end bound is the next day's start).
        day = next((d for d in self.days if f">= toDateTime({vr.day_bounds(d)[0]})" in sql), None)
        held = self.days.get(day)
        if held is None:
            # No point at all: grouped queries answer no rows, aggregates one row of zeros.
            kinds, counts, feeds, extra = [], [], [], {"audience": [], "routes": [],
                                                       "visitors": [{"visitors": "0", "uncoded": "0"}],
                                                       "visits": [{"visits": "0"}]}
        else:
            kinds, counts, feeds = held[:3]
            extra = held[3] if len(held) > 3 else UNFLAGGED
        if "blob7 AS feed" in sql:
            return answer(feeds)
        if "GROUP BY kind " in sql:
            return answer(kinds)
        if "blob8 AS agent" in sql:
            return answer(extra["audience"])
        if "blob11 AS cache" in sql:
            return answer(extra.get("cache", []))
        if "SUM(_sample_interval) AS pages" in sql:
            return answer(extra["routes"])
        if "AS uncoded" in sql:
            return answer(extra["visitors"])
        if "AS visits" in sql:
            return answer(extra["visits"])
        return answer(counts)

    def get(self, url, headers=None, timeout=None, params=None, auth=None):
        self.gets.append({"url": url, "headers": headers or {}, "params": params, "auth": auth})
        reply = self.x_profile if url == vr.X_ME_URL else self.profile
        if isinstance(reply, Exception):
            raise reply
        return reply

    def close(self):
        self.closed = True


def read_csv(path) -> tuple[list[str], list[dict]]:
    reader = csv.DictReader(io.StringIO(path.read_text(encoding="utf-8")))
    return list(reader.fieldnames or []), list(reader)


def roll(tmp_path, http: FakeHttp | None = None, **kw) -> str:
    kw.setdefault("stats_path", tmp_path / "no-stats.json")
    return vr.run(tmp_path, env=kw.pop("env", ENV), session=http if http is not None else FakeHttp(), now=NOW, **kw)


@pytest.fixture(autouse=True)
def site(monkeypatch):
    monkeypatch.setattr(config, "SITE_URL", "https://lmiawatch.ca")


# -- SQL ----------------------------------------------------------------------


def test_the_sql_for_a_day_covers_exactly_that_utc_day():
    assert vr.day_bounds(YESTERDAY) == (START, START + 86_400)
    assert vr.counts_sql(YESTERDAY) == (
        "SELECT blob1 AS route, blob2 AS kind, blob3 AS lang, blob4 AS country, blob5 AS referrer, "
        "double1 AS status, SUM(_sample_interval) AS responses FROM lmia_watch_views "
        f"WHERE timestamp >= toDateTime({START}) AND timestamp < toDateTime({START + 86_400}) "
        "GROUP BY route, kind, lang, country, referrer, status ORDER BY responses DESC LIMIT 10000 FORMAT JSON"
    )
    assert vr.kinds_sql(YESTERDAY) == (
        "SELECT blob2 AS kind, SUM(_sample_interval) AS responses FROM lmia_watch_views "
        f"WHERE timestamp >= toDateTime({START}) AND timestamp < toDateTime({START + 86_400}) "
        "GROUP BY kind ORDER BY kind FORMAT JSON"
    )
    feeds = vr.feeds_sql(YESTERDAY)
    assert "blob7 AS feed" in feeds and "MAX(double2) AS subscribers" in feeds and "blob2 = 'feed'" in feeds
    assert f"toDateTime({START})" in feeds and f"toDateTime({START + 86_400})" in feeds
    # Sampled counts are summed, never counted.
    for sql in (vr.counts_sql(YESTERDAY), vr.kinds_sql(YESTERDAY), feeds):
        assert "COUNT(" not in sql.upper() and "SUM(_sample_interval)" in sql


def test_each_query_is_a_post_with_the_sql_as_body_and_the_token_only_in_the_header(tmp_path):
    http = FakeHttp()
    assert roll(tmp_path, http, day=YESTERDAY) == "rolled up"
    assert [p["sql"] for p in http.posts] == [
        vr.kinds_sql(YESTERDAY), vr.counts_sql(YESTERDAY), vr.feeds_sql(YESTERDAY), vr.audience_sql(YESTERDAY),
        vr.human_routes_sql(YESTERDAY), vr.visitors_sql(YESTERDAY), vr.visits_sql(YESTERDAY),
        vr.page_cache_sql(YESTERDAY)]
    for p in http.posts:
        assert p["url"] == f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/analytics_engine/sql"
        assert p["headers"]["Authorization"] == f"Bearer {TOKEN}"
        assert p["headers"]["User-Agent"] == config.USER_AGENT
        assert TOKEN not in p["url"] and TOKEN not in p["sql"]
    assert not http.closed  # a session handed in belongs to the caller


# -- the files ----------------------------------------------------------------


def test_the_day_file_holds_the_total_the_kinds_every_count_and_every_feed(tmp_path):
    assert roll(tmp_path) == "rolled up"
    header, rows = read_csv(tmp_path / "2026-10-21.csv")
    assert header == vr.DAY_HEADER == ["date", "section", "route", "kind", "lang", "country", "referrer", "status",
                                       "feed", "responses", "subscribers", "agent", "device", "cache"]
    assert {r["date"] for r in rows} == {"2026-10-21"}
    sections = [r["section"] for r in rows]
    assert sections == ["total"] + ["kind"] * 7 + ["count"] * 9 + ["feed"] * 3 + ["audience"]
    # A day before the bot flag: its page views are kept, with the agent left empty.
    audience = rows[-1]
    assert (audience["agent"], audience["country"], audience["device"], audience["lang"], audience["responses"]) == (
        "", "CA", "", "en", "120")
    assert rows[0]["responses"] == "206" and rows[0]["route"] == "" and rows[0]["subscribers"] == ""
    assert {r["kind"]: r["responses"] for r in rows if r["section"] == "kind"} == {
        "api": "30", "download": "4", "feed": "40", "form": "1", "hook": "2", "other": "9", "page": "120"}
    first = rows[8]
    assert (first["route"], first["kind"], first["lang"], first["country"], first["referrer"], first["status"],
            first["responses"]) == ("/employers/:id", "page", "en", "CA", "news.example.org", "200", "70")
    feeds = {r["feed"]: (r["route"], r["kind"], r["responses"], r["subscribers"]) for r in rows if r["section"] == "feed"}
    assert feeds == {
        "": ("/data/feeds/:file", "feed", "4", "0"),
        "feeds/canada/pending.xml": ("/data/feeds/:file", "feed", "30", "12"),
        "feeds/prov/BC/approved.xml": ("/data/feeds/:file", "feed", "6", "3"),
    }
    assert (tmp_path / vr.ROLLED_UP).read_text(encoding="utf-8") == "2026-10-21\n"
    assert not list(tmp_path.glob("*.partial"))


def test_a_value_the_worker_would_never_write_is_blanked_before_it_is_stored(tmp_path):
    odd = [
        {"route": "/someone@example.com/profile?x=1", "kind": "page", "lang": "de",
         "country": "Canada", "referrer": "https://news.example.org/story?id=7", "status": 200, "responses": "3"},
        {"route": "/", "kind": "Mozilla/5.0 (X11; Linux x86_64)", "lang": "en", "country": "203.0.113.42",
         "referrer": "UPPER.example", "status": "nan", "responses": "2"},
    ]
    feeds = [{"feed": "feeds/../../etc/passwd.xml", "responses": "1", "subscribers": "inf"}]
    kinds = [{"kind": "page", "responses": "5"}]
    assert roll(tmp_path, FakeHttp({YESTERDAY: (kinds, odd, feeds)})) == "rolled up"
    text = (tmp_path / "2026-10-21.csv").read_text(encoding="utf-8")
    for leaked in ("someone@example.com", "?x=1", "Canada", "/story", "id=7", "Mozilla", "203.0.113.42", "UPPER",
                   "passwd", "inf", "nan", "de,"):
        assert leaked not in text, leaked
    _, rows = read_csv(tmp_path / "2026-10-21.csv")
    counts = [(r["route"], r["kind"], r["lang"], r["country"], r["referrer"], r["status"], r["responses"])
              for r in rows if r["section"] == "count"]
    assert counts == [("other", "page", "", "", "", "200", "3"), ("/", "other", "en", "", "", "", "2")]
    assert [(r["feed"], r["subscribers"]) for r in rows if r["section"] == "feed"] == [("", "0")]


def test_the_summary_gets_one_row_per_day_and_a_re_run_replaces_it_in_place(tmp_path):
    summary = tmp_path / vr.SUMMARY
    summary.write_text(
        ",".join(vr.SUMMARY_HEADER) + "\n"
        "2026-10-19,100,80,10,5,1,4,0,6,50,/ 60\n"
        "2026-10-20,110,90,10,5,1,4,0,6,55,/ 61\n", encoding="utf-8")
    assert roll(tmp_path) == "rolled up"
    header, rows = read_csv(summary)
    assert header == vr.SUMMARY_HEADER == ["date", "responses", "pages", "api", "downloads", "forms", "feeds", "other",
                                           "feed_subscribers", "bluesky_followers", "top_routes",
                                           "human_pages", "bot_pages", "unique_visitors", "human_visits",
                                           "human_by_country", "human_by_device", "human_by_lang", "human_by_route",
                                           "x_followers", "employers", "records",
                                           "page_cache_hits", "page_cache_misses"]
    assert [r["date"] for r in rows] == ["2026-10-19", "2026-10-20", "2026-10-21"]
    assert rows[0]["top_routes"] == "/ 60"  # earlier rows are kept as they were
    new = rows[-1]
    assert {k: new[k] for k in vr.SUMMARY_HEADER} == {
        "date": "2026-10-21", "responses": "206", "pages": "120", "api": "30", "downloads": "4", "forms": "1",
        "feeds": "40", "other": "11", "feed_subscribers": "15", "bluesky_followers": "57",
        "top_routes": "/employers/:id 70; / 50; /data/feeds/:file 36; /api/stats 30; /downloads/employers.csv 4",
        # A day before the bot flag: blank, never 0.
        **dict.fromkeys(vr.AUDIENCE_COLUMNS, ""),
        # Not the last day of a month (no X reading), and no stats.json in this test.
        "x_followers": "", "employers": "", "records": "",
        # A day before the page cache: blank, never 0.
        "page_cache_hits": "", "page_cache_misses": "",
    }
    assert rows[0]["human_pages"] == "" and rows[0]["unique_visitors"] == ""  # older rows read with blanks

    # The same night again (a manual re-run): still one row for the day, and a
    # follower count that could not be read this time keeps the one it had.
    again = FakeHttp(profile=FakeResponse(503, None, "unavailable"))
    assert roll(tmp_path, again) == "rolled up"
    _, rows = read_csv(summary)
    assert [r["date"] for r in rows] == ["2026-10-19", "2026-10-20", "2026-10-21"]
    assert rows[-1]["bluesky_followers"] == "57" and rows[-1]["responses"] == "206"


def test_a_summary_that_cannot_be_read_safely_is_never_replaced(tmp_path):
    summary = tmp_path / vr.SUMMARY
    bad = [
        "",  # an empty download
        "date,responses,visitors_ip\n2026-10-20,5,x\n",  # a column this code does not know
        ",".join(vr.SUMMARY_HEADER) + "\nnot-a-date,1,1,0,0,0,0,0,0,,\n",
        ",".join(vr.SUMMARY_HEADER) + "\n2026-13-45,1,1,0,0,0,0,0,0,,\n",
        ",".join(vr.SUMMARY_HEADER) + "\n2026-10-20" + ",1" * (len(vr.SUMMARY_HEADER) - 1) + ",extra\n",  # one field too many
    ]
    for text in bad:
        summary.write_text(text, encoding="utf-8")
        http = FakeHttp()
        assert roll(tmp_path, http) == "failed", text
        assert summary.read_text(encoding="utf-8") == text
        assert http.posts == []
        assert not (tmp_path / "2026-10-21.csv").exists()
        assert (tmp_path / vr.ROLLED_UP).read_text(encoding="utf-8") == ""


# -- outcomes -----------------------------------------------------------------


def test_without_a_token_nothing_is_asked_and_nothing_written(tmp_path, caplog):
    (tmp_path / vr.ROLLED_UP).write_text("2026-10-01\n", encoding="utf-8")  # left by an earlier run
    http = FakeHttp()
    caplog.set_level("INFO")
    assert roll(tmp_path, http, env={vr.ACCOUNT_ENV: ACCOUNT}) == "no token"
    assert roll(tmp_path, http, env={vr.TOKEN_ENV: "  ", vr.ACCOUNT_ENV: ACCOUNT}) == "no token"
    assert "no analytics token; nothing rolled up" in caplog.text
    assert http.posts == [] and http.gets == []
    assert (tmp_path / vr.ROLLED_UP).read_text(encoding="utf-8") == ""
    assert not (tmp_path / vr.SUMMARY).exists()


@pytest.mark.parametrize("fail", [
    FakeResponse(500, None, "internal error"),
    FakeResponse(401, {"errors": [{"message": "Authentication error"}]}),
    FakeResponse(200, {"errors": []}),  # no rows
    FakeResponse(200, {"data": "not rows"}),
    FakeResponse(200, None, "<html>"),
    requests.ConnectionError("connection reset"),
])
def test_an_api_failure_is_failed_and_leaves_every_file_as_it_was(tmp_path, fail, caplog):
    summary = tmp_path / vr.SUMMARY
    summary.write_text(",".join(vr.SUMMARY_HEADER) + "\n2026-10-20,1,1,0,0,0,0,0,0,,/ 1\n", encoding="utf-8")
    before = summary.read_text(encoding="utf-8")
    assert roll(tmp_path, FakeHttp(fail=fail)) == "failed"
    assert summary.read_text(encoding="utf-8") == before
    assert not (tmp_path / "2026-10-21.csv").exists()
    assert (tmp_path / vr.ROLLED_UP).read_text(encoding="utf-8") == ""
    assert TOKEN not in caplog.text


def test_a_failure_part_way_through_a_catch_up_writes_nothing(tmp_path):
    summary = tmp_path / vr.SUMMARY
    summary.write_text(",".join(vr.SUMMARY_HEADER) + "\n2026-10-19,1,1,0,0,0,0,0,0,,/ 1\n", encoding="utf-8")

    class FailsLater(FakeHttp):
        def post(self, url, data=None, headers=None, timeout=None):
            if len(self.posts) >= 3:
                self.posts.append({"url": url, "sql": data.decode(), "headers": headers})
                return FakeResponse(502, None, "bad gateway")
            return super().post(url, data=data, headers=headers, timeout=timeout)

    days = {date(2026, 10, 20): (KINDS, COUNTS, FEEDS), YESTERDAY: (KINDS, COUNTS, FEEDS)}
    assert roll(tmp_path, FailsLater(days)) == "failed"
    assert not list(tmp_path.glob("2026-*.csv"))
    assert summary.read_text(encoding="utf-8").count("\n") == 2


def test_missing_days_are_caught_up_and_empty_days_are_not_written(tmp_path):
    summary = tmp_path / vr.SUMMARY
    summary.write_text(",".join(vr.SUMMARY_HEADER) + "\n2026-10-17,1,1,0,0,0,0,0,0,,/ 1\n", encoding="utf-8")
    days = {date(2026, 10, 18): (KINDS, COUNTS, FEEDS), YESTERDAY: (KINDS, COUNTS, FEEDS)}
    http = FakeHttp(days)
    assert roll(tmp_path, http) == "rolled up"
    asked = [p["sql"] for p in http.posts if "GROUP BY kind " in p["sql"]]
    assert asked == [vr.kinds_sql(date(2026, 10, d)) for d in (18, 19, 20, 21)]
    # An empty day costs one question, not eight.
    assert len(http.posts) == 4 + 2 * 7
    assert sorted(p.name for p in tmp_path.glob("2026-*.csv")) == ["2026-10-18.csv", "2026-10-21.csv"]
    assert (tmp_path / vr.ROLLED_UP).read_text(encoding="utf-8") == "2026-10-18\n2026-10-21\n"
    _, rows = read_csv(summary)
    assert [(r["date"], r["bluesky_followers"]) for r in rows] == [
        ("2026-10-17", ""), ("2026-10-18", ""), ("2026-10-21", "57")]
    assert len(http.gets) == 1  # the follower count is read once, for yesterday


def test_the_first_night_asks_for_all_three_months_analytics_engine_keeps(tmp_path):
    early = date(2026, 10, 9)
    http = FakeHttp({early: (KINDS, COUNTS, FEEDS), YESTERDAY: (KINDS, COUNTS, FEEDS)})
    assert roll(tmp_path, http) == "rolled up"
    asked = [p["sql"] for p in http.posts if "GROUP BY kind " in p["sql"]]
    assert len(asked) == vr.RETENTION_DAYS
    assert asked[0] == vr.kinds_sql(YESTERDAY - timedelta(days=vr.RETENTION_DAYS - 1))
    assert asked[-1] == vr.kinds_sql(YESTERDAY)
    _, rows = read_csv(tmp_path / vr.SUMMARY)
    assert [r["date"] for r in rows] == ["2026-10-09", "2026-10-21"]


def test_days_due():
    assert vr.days_to_roll(["2026-10-20"], YESTERDAY) == [YESTERDAY]
    # Already rolled up tonight: yesterday again, in place.
    assert vr.days_to_roll(["2026-10-19", "2026-10-21"], YESTERDAY) == [YESTERDAY]
    assert vr.days_to_roll(["2026-10-18"], YESTERDAY) == [date(2026, 10, 19), date(2026, 10, 20), YESTERDAY]
    # Never further back than the retention, however old the newest row.
    long_ago = vr.days_to_roll(["2025-01-01"], YESTERDAY)
    assert len(long_ago) == vr.RETENTION_DAYS and long_ago[-1] == YESTERDAY


def test_no_data_points_at_all_is_no_data(tmp_path):
    http = FakeHttp({})
    assert vr.run(tmp_path, day=YESTERDAY, env=ENV, session=http, now=NOW) == "no data"
    assert len(http.posts) == 1
    assert not (tmp_path / vr.SUMMARY).exists()
    assert (tmp_path / vr.ROLLED_UP).read_text(encoding="utf-8") == ""


def test_a_day_asked_for_by_hand_must_be_over_and_still_held(tmp_path):
    for day in (NOW.date(), NOW.date() + timedelta(days=3), YESTERDAY - timedelta(days=vr.RETENTION_DAYS)):
        http = FakeHttp()
        assert vr.run(tmp_path, day=day, env=ENV, session=http, now=NOW) == "failed", day
        assert http.posts == []
    oldest = YESTERDAY - timedelta(days=vr.RETENTION_DAYS - 1)
    http = FakeHttp({oldest: (KINDS, COUNTS, FEEDS)})
    assert vr.run(tmp_path, day=oldest, env=ENV, session=http, now=NOW) == "rolled up"
    assert (tmp_path / f"{oldest.isoformat()}.csv").exists()
    assert http.gets == []  # not yesterday, so no follower reading is attached


def test_a_malformed_account_id_is_failed_before_any_request(tmp_path):
    http = FakeHttp()
    assert roll(tmp_path, http, env={vr.TOKEN_ENV: TOKEN, vr.ACCOUNT_ENV: "abc/../../zones"}) == "failed"
    assert roll(tmp_path, http, env={vr.TOKEN_ENV: TOKEN}) == "failed"
    assert http.posts == []


# -- Bluesky ------------------------------------------------------------------


def test_the_bluesky_follower_count_is_read_from_the_public_profile():
    assert vr.parse_followers({"followersCount": 12, "followsCount": 3}) == 12
    assert vr.parse_followers({"followersCount": 0}) == 0
    for odd in ({"followersCount": "12"}, {"followersCount": -1}, {"followersCount": True},
                {"followersCount": 1.5}, {}, [], None, "12"):
        assert vr.parse_followers(odd) is None, odd

    http = FakeHttp()
    assert vr.bluesky_followers(http, "lmiawatch.ca") == 57
    (get,) = http.gets
    parts = urlsplit(get["url"])
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == vr.BSKY_PROFILE_URL
    assert parse_qs(parts.query) == {"actor": ["lmiawatch.ca"]}
    assert "Authorization" not in get["headers"]

    assert vr.bluesky_followers(FakeHttp(profile=FakeResponse(400, {"error": "InvalidRequest"})), "x.example") is None
    assert vr.bluesky_followers(FakeHttp(profile=requests.Timeout("slow")), "lmiawatch.ca") is None
    assert vr.bluesky_followers(FakeHttp(profile=FakeResponse(200, {"handle": "lmiawatch.ca"})), "lmiawatch.ca") is None
    assert vr.bluesky_followers(FakeHttp(), "") is None


def test_the_handle_comes_from_the_secret_else_the_site_domain(monkeypatch):
    assert vr.bluesky_handle({"BSKY_HANDLE": " @lmiawatch.ca "}) == "lmiawatch.ca"
    assert vr.bluesky_handle({}) == "lmiawatch.ca"
    monkeypatch.setattr(config, "SITE_URL", "https://lmiawatch.example")
    assert vr.bluesky_handle({}) == ""


def test_a_bluesky_outage_never_fails_the_roll_up(tmp_path):
    assert roll(tmp_path, FakeHttp(profile=requests.ConnectionError("down"))) == "rolled up"
    _, rows = read_csv(tmp_path / vr.SUMMARY)
    assert rows[-1]["bluesky_followers"] == ""


# -- the command and the run status -------------------------------------------


def test_the_command_exits_1_only_when_the_roll_up_failed(tmp_path, monkeypatch):
    monkeypatch.delenv(vr.TOKEN_ENV, raising=False)
    assert cli.main(["rollup-views", "--out", str(tmp_path)]) == 0

    fake = FakeHttp(fail=FakeResponse(500, None, "boom"))
    monkeypatch.setattr(requests, "Session", lambda: fake)
    monkeypatch.setenv(vr.TOKEN_ENV, TOKEN)
    monkeypatch.setenv(vr.ACCOUNT_ENV, ACCOUNT)
    assert cli.main(["rollup-views", "--out", str(tmp_path)]) == 1
    assert fake.closed and fake.posts

    good = FakeHttp({date(2026, 9, 1): (KINDS, COUNTS, FEEDS)})
    monkeypatch.setattr(requests, "Session", lambda: good)
    monkeypatch.setattr(vr, "previous_day", lambda now=None: date(2026, 9, 2))
    assert cli.main(["rollup-views", "--out", str(tmp_path), "--day", "2026-09-01"]) == 0
    assert (tmp_path / "2026-09-01.csv").exists()


def test_the_run_status_carries_the_roll_up(tmp_path):
    db = tmp_path / "none.sqlite"
    assert nightly.run_status(db, None, None, None, {}, views="failed")["views_rollup"] == "failed"
    assert nightly.run_status(db, None, None, None, {})["views_rollup"] == "not run"
    (tmp_path / "views.txt").write_text("no token\n", encoding="utf-8")
    out = tmp_path / "status.json"
    assert nightly.main(["status", "--db", str(db), "--views-outcome", str(tmp_path / "views.txt"),
                         "--out", str(out)]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["views_rollup"] == "no token"


# -- people and bots (the bot flag and the visitor code, since 2026-10-30) -----

AUDIENCE = [
    {"agent": "human", "country": "CA", "device": "desktop", "lang": "en", "pages": "60"},
    {"agent": "human", "country": "CA", "device": "mobile", "lang": "fr", "pages": "20"},
    {"agent": "human", "country": "US", "device": "mobile", "lang": "en", "pages": "10"},
    {"agent": "human", "country": "", "device": "tablet", "lang": "en", "pages": "2"},
    {"agent": "bot", "country": "US", "device": "", "lang": "en", "pages": "300"},
]
ROUTES = [{"route": "/employers/:id", "pages": "70"}, {"route": "/", "pages": "22"}]
FLAGGED = {"audience": AUDIENCE, "routes": ROUTES, "visitors": [{"visitors": "41", "uncoded": "0"}],
           "visits": [{"visits": "37"}]}


def flagged_day(**changes) -> dict:
    return {date(2026, 10, 21): (KINDS, COUNTS, FEEDS, {**FLAGGED, **changes})}


def summary_last(folder) -> dict:
    _, rows = read_csv(folder / vr.SUMMARY)
    return rows[-1]


def test_the_people_and_bot_queries_read_page_views_below_400_and_only_count_codes():
    where = f"timestamp >= toDateTime({START}) AND timestamp < toDateTime({START + 86_400})"
    assert vr.audience_sql(YESTERDAY) == (
        "SELECT blob8 AS agent, blob4 AS country, blob9 AS device, blob3 AS lang, SUM(_sample_interval) AS pages "
        f"FROM lmia_watch_views WHERE blob2 = 'page' AND double1 < 400 AND {where} "
        "GROUP BY agent, country, device, lang ORDER BY pages DESC LIMIT 10000 FORMAT JSON")
    assert vr.human_routes_sql(YESTERDAY) == (
        "SELECT blob1 AS route, SUM(_sample_interval) AS pages FROM lmia_watch_views "
        f"WHERE blob2 = 'page' AND double1 < 400 AND blob8 = 'human' AND {where} "
        "GROUP BY route ORDER BY pages DESC LIMIT 10000 FORMAT JSON")
    assert vr.visitors_sql(YESTERDAY) == (
        "SELECT count(DISTINCT blob10) AS visitors, sumIf(_sample_interval, blob10 = '') AS uncoded "
        f"FROM lmia_watch_views WHERE blob8 = 'human' AND {where} FORMAT JSON")
    assert vr.visits_sql(YESTERDAY) == (
        "SELECT count(DISTINCT blob10) AS visits FROM lmia_watch_views "
        f"WHERE blob8 = 'human' AND blob2 = 'page' AND blob10 != '' AND {where} FORMAT JSON")
    # No query ever reads a visitor code back: blob10 appears only inside a
    # distinct count or a comparison with the empty string.
    for sql in (vr.kinds_sql(YESTERDAY), vr.counts_sql(YESTERDAY), vr.feeds_sql(YESTERDAY), vr.audience_sql(YESTERDAY),
                vr.human_routes_sql(YESTERDAY), vr.visitors_sql(YESTERDAY), vr.visits_sql(YESTERDAY),
                vr.page_cache_sql(YESTERDAY)):
        rest = sql.replace("count(DISTINCT blob10)", "").replace("blob10 = ''", "").replace("blob10 != ''", "")
        assert "blob10" not in rest, sql


def test_a_flagged_day_fills_the_people_and_bot_columns(tmp_path):
    assert roll(tmp_path, FakeHttp(flagged_day())) == "rolled up"
    row = summary_last(tmp_path)
    assert {k: row[k] for k in vr.AUDIENCE_COLUMNS} == {
        "human_pages": "92", "bot_pages": "300", "unique_visitors": "41", "human_visits": "37",
        "human_by_country": '{"CA":80,"US":10,"unknown":2}',
        "human_by_device": '{"desktop":60,"mobile":30,"tablet":2}',
        "human_by_lang": '{"en":72,"fr":20}',
        "human_by_route": '{"/employers/:id":70,"/":22}',
    }
    # The existing columns are unchanged by the flag.
    assert (row["responses"], row["pages"]) == ("206", "120")
    _, rows = read_csv(tmp_path / "2026-10-21.csv")
    audience = [(r["agent"], r["country"], r["device"], r["lang"], r["responses"]) for r in rows if r["section"] == "audience"]
    assert audience == [("bot", "US", "", "en", "300"), ("human", "CA", "desktop", "en", "60"),
                        ("human", "CA", "mobile", "fr", "20"), ("human", "US", "mobile", "en", "10"),
                        ("human", "", "tablet", "en", "2")]


def test_the_country_column_keeps_the_top_ten_and_sums_the_rest():
    rows = [{"agent": "human", "country": f"A{chr(65 + i)}", "device": "desktop", "lang": "en", "pages": str(100 - i)}
            for i in range(12)]
    d = vr.build_day(YESTERDAY, KINDS, COUNTS, FEEDS, audience=rows, human_routes=[],
                     visitors=[{"visitors": 5, "uncoded": 0}], visits=[{"visits": 5}])
    columns = vr.audience_columns(d)
    by_country = json.loads(columns["human_by_country"])
    assert list(by_country) == [f"A{chr(65 + i)}" for i in range(10)] + ["other"]
    assert by_country["other"] == 90 + 89
    assert sum(by_country.values()) == columns["human_pages"]


def test_a_day_with_any_page_view_lacking_the_flag_is_blank_never_zero(tmp_path):
    # The day the flag was deployed: points from before it carry no agent.
    mixed = AUDIENCE + [{"agent": "", "country": "CA", "device": "", "lang": "en", "pages": "5"}]
    assert roll(tmp_path, FakeHttp(flagged_day(audience=mixed))) == "rolled up"
    assert all(summary_last(tmp_path)[k] == "" for k in vr.AUDIENCE_COLUMNS)
    # A value the Worker would never write is no flag either.
    odd = [dict(AUDIENCE[0], agent="robot")] + AUDIENCE[1:]
    assert roll(tmp_path, FakeHttp(flagged_day(audience=odd))) == "rolled up"
    assert all(summary_last(tmp_path)[k] == "" for k in vr.AUDIENCE_COLUMNS)


def test_a_day_with_a_person_without_a_code_has_blank_visitor_columns(tmp_path):
    # VIEWS_SALT_KEY not set (every request uncoded), or set part way through the
    # day, or an answer that cannot be read.
    for visitors in ([{"visitors": "1", "uncoded": "92"}], [{"visitors": "30", "uncoded": "4"}],
                     [], [{"visitors": None, "uncoded": "0"}], [{"visitors": "x", "uncoded": "0"}],
                     [{"visitors": "3"}]):
        assert roll(tmp_path, FakeHttp(flagged_day(visitors=visitors))) == "rolled up", visitors
        row = summary_last(tmp_path)
        assert (row["unique_visitors"], row["human_visits"]) == ("", ""), visitors
        assert (row["human_pages"], row["bot_pages"]) == ("92", "300"), visitors


def test_values_the_worker_would_never_write_are_cleaned_before_they_are_stored(tmp_path):
    odd = [{"agent": "human", "country": "Canada", "device": "Mozilla/5.0 (X11)", "lang": "de", "pages": "4"},
           {"agent": "human", "country": "CA", "device": "desktop", "lang": "en", "pages": "6"}]
    routes = [{"route": "/someone@example.com", "pages": "4"}, {"route": "/", "pages": "6"}]
    assert roll(tmp_path, FakeHttp(flagged_day(audience=odd, routes=routes))) == "rolled up"
    row = summary_last(tmp_path)
    assert row["human_by_country"] == '{"CA":6,"unknown":4}'
    assert row["human_by_device"] == '{"desktop":6,"unknown":4}'
    assert row["human_by_lang"] == '{"en":6,"unknown":4}'
    assert row["human_by_route"] == '{"/":6,"other":4}'
    text = (tmp_path / "2026-10-21.csv").read_text(encoding="utf-8") + (tmp_path / vr.SUMMARY).read_text(encoding="utf-8")
    for leaked in ("Canada", "Mozilla", "someone@example.com", ",de,"):
        assert leaked not in text, leaked


# -- readings taken on the night -----------------------------------------------

X_ENV = {**ENV, "X_POST_ENABLED": "true", "X_API_KEY": "k", "X_API_SECRET": "s", "X_ACCESS_TOKEN": "t",
         "X_ACCESS_TOKEN_SECRET": "ts"}
MONTH_END_NOW = datetime(2026, 11, 1, 0, 40, tzinfo=timezone.utc)
OCT31 = date(2026, 10, 31)


def test_x_followers_are_read_once_a_month_for_the_last_day_when_x_posting_is_enabled(tmp_path):
    http = FakeHttp({OCT31: (KINDS, COUNTS, FEEDS, FLAGGED)})
    assert vr.run(tmp_path, env=X_ENV, session=http, now=MONTH_END_NOW, stats_path=tmp_path / "none") == "rolled up"
    row = summary_last(tmp_path)
    assert (row["date"], row["x_followers"], row["bluesky_followers"]) == ("2026-10-31", "31", "57")
    (x_get,) = [g for g in http.gets if g["url"] == vr.X_ME_URL]
    assert x_get["params"] == {"user.fields": "public_metrics"} and x_get["auth"] is not None

    # Not the last day of a month, X not enabled, or no credentials: no read at all.
    for env, now, day in ((X_ENV, NOW, YESTERDAY), ({**X_ENV, "X_POST_ENABLED": "false"}, MONTH_END_NOW, OCT31),
                          ({**ENV, "X_POST_ENABLED": "true"}, MONTH_END_NOW, OCT31)):
        http = FakeHttp({day: (KINDS, COUNTS, FEEDS, FLAGGED)})
        assert vr.run(tmp_path / "other", env=env, session=http, now=now, stats_path=tmp_path / "none") == "rolled up"
        assert not [g for g in http.gets if g["url"] == vr.X_ME_URL]


def test_an_x_failure_leaves_the_reading_blank_and_never_fails_the_roll_up(tmp_path):
    for n, reply in enumerate((FakeResponse(429, {"title": "Too Many Requests"}), requests.Timeout("slow"),
                               FakeResponse(200, {"data": {"id": "1"}}))):
        http = FakeHttp({OCT31: (KINDS, COUNTS, FEEDS, FLAGGED)}, x_profile=reply)
        folder = tmp_path / str(n)
        assert vr.run(folder, env=X_ENV, session=http, now=MONTH_END_NOW, stats_path=tmp_path / "none") == "rolled up"
        assert summary_last(folder)["x_followers"] == ""
    assert vr.parse_x_followers({"data": {"public_metrics": {"followers_count": 12}}}) == 12
    for odd in ({"data": {"public_metrics": {"followers_count": "12"}}}, {"data": {}}, {"errors": []}, None,
                {"data": {"public_metrics": {"followers_count": -1}}},
                {"data": {"public_metrics": {"followers_count": True}}}):
        assert vr.parse_x_followers(odd) is None, odd


def test_the_site_counts_come_from_tonights_stats_and_go_on_yesterdays_row_only(tmp_path):
    stats = tmp_path / "stats.json"
    stats.write_text(json.dumps({"counts": {"employers": 166497, "approved_records": 433083, "refused_records": 41319,
                                            "pending": 4000}}), encoding="utf-8")
    days = {date(2026, 10, 20): (KINDS, COUNTS, FEEDS, FLAGGED), YESTERDAY: (KINDS, COUNTS, FEEDS, FLAGGED)}
    summary = tmp_path / vr.SUMMARY
    # A summary written before the newer columns.
    summary.write_text(",".join(vr.SUMMARY_HEADER[:11]) + "\n2026-10-19,1,1,0,0,0,0,0,0,,/ 1\n", encoding="utf-8")
    assert roll(tmp_path, FakeHttp(days), stats_path=stats) == "rolled up"
    _, rows = read_csv(summary)
    assert [(r["date"], r["employers"], r["records"]) for r in rows] == [
        ("2026-10-19", "", ""), ("2026-10-20", "", ""), ("2026-10-21", "166497", "474402")]

    # Rolled up again without a readable stats file: the readings stay.
    assert roll(tmp_path, FakeHttp(days), stats_path=tmp_path / "gone.json") == "rolled up"
    row = summary_last(tmp_path)
    assert (row["employers"], row["records"]) == ("166497", "474402")

    assert vr.site_counts(tmp_path / "gone.json") == {}
    for bad in ('{"counts": {"employers": "1", "approved_records": 1, "refused_records": 1}}', "[]", "not json",
                '{"counts": {"employers": 1}}'):
        stats.write_text(bad, encoding="utf-8")
        assert vr.site_counts(stats) == {}, bad


# -- the page cache (blob11) ----------------------------------------------------

CACHE = [{"cache": "", "pages": "40"}, {"cache": "hit", "pages": "55"}, {"cache": "miss", "pages": "25"}]


def test_the_page_cache_query_reads_page_views_below_400_by_cache_state():
    where = f"timestamp >= toDateTime({START}) AND timestamp < toDateTime({START + 86_400})"
    assert vr.page_cache_sql(YESTERDAY) == (
        "SELECT blob11 AS cache, SUM(_sample_interval) AS pages FROM lmia_watch_views "
        f"WHERE blob2 = 'page' AND double1 < 400 AND {where} GROUP BY cache ORDER BY cache FORMAT JSON")


def test_a_day_with_hits_and_misses_fills_both_columns_and_the_day_file(tmp_path):
    assert roll(tmp_path, FakeHttp(flagged_day(cache=CACHE))) == "rolled up"
    row = summary_last(tmp_path)
    assert (row["page_cache_hits"], row["page_cache_misses"]) == ("55", "25")
    # The other columns are unchanged by the cache.
    assert (row["pages"], row["human_pages"]) == ("120", "92")
    _, rows = read_csv(tmp_path / "2026-10-21.csv")
    cache = [(r["kind"], r["cache"], r["responses"]) for r in rows if r["section"] == "page_cache"]
    assert cache == [("page", "", "40"), ("page", "hit", "55"), ("page", "miss", "25")]
    assert rows[-1]["section"] == "page_cache"


def test_hits_without_misses_read_zero_misses(tmp_path):
    assert roll(tmp_path, FakeHttp(flagged_day(cache=[{"cache": "hit", "pages": "7"}]))) == "rolled up"
    row = summary_last(tmp_path)
    assert (row["page_cache_hits"], row["page_cache_misses"]) == ("7", "0")


def test_a_day_the_cache_considered_nothing_is_blank_never_zero(tmp_path):
    # Points written before the Worker wrote blob11 read back with an empty state.
    for cache in ([{"cache": "", "pages": "120"}], []):
        assert roll(tmp_path, FakeHttp(flagged_day(cache=cache))) == "rolled up", cache
        row = summary_last(tmp_path)
        assert (row["page_cache_hits"], row["page_cache_misses"]) == ("", ""), cache


def test_a_cache_state_the_worker_would_never_write_counts_as_not_considered(tmp_path):
    odd = [{"cache": "HIT", "pages": "5"}, {"cache": "Mozilla/5.0", "pages": "3"}, {"cache": None, "pages": "2"},
           {"cache": "miss", "pages": "4"}]
    assert roll(tmp_path, FakeHttp(flagged_day(cache=odd))) == "rolled up"
    row = summary_last(tmp_path)
    assert (row["page_cache_hits"], row["page_cache_misses"]) == ("0", "4")
    _, rows = read_csv(tmp_path / "2026-10-21.csv")
    assert [(r["cache"], r["responses"]) for r in rows if r["section"] == "page_cache"] == [("", "10"), ("miss", "4")]
    text = (tmp_path / "2026-10-21.csv").read_text(encoding="utf-8")
    assert "HIT" not in text and "Mozilla" not in text


def test_a_summary_written_before_the_cache_columns_reads_and_keeps_its_rows(tmp_path):
    summary = tmp_path / vr.SUMMARY
    summary.write_text(",".join(vr.SUMMARY_HEADER[:-2]) + "\n2026-10-20,1,1,0,0,0,0,0,0,,/ 1\n", encoding="utf-8")
    assert roll(tmp_path, FakeHttp(flagged_day(cache=CACHE))) == "rolled up"
    header, rows = read_csv(summary)
    assert header == vr.SUMMARY_HEADER
    assert [(r["date"], r["page_cache_hits"], r["page_cache_misses"]) for r in rows] == [
        ("2026-10-20", "", ""), ("2026-10-21", "55", "25")]
