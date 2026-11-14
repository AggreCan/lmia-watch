"""Nightly roll-up of the Worker's audience counts into files kept in R2.

Why: Workers Analytics Engine keeps a data point for three months, so the
counts the Worker writes (site/src/views.ts, dataset lmia_watch_views) would
be gone a quarter after they were taken. Once a night this asks the SQL API
for each finished UTC day the summary does not hold yet (normally only
yesterday) and keeps the answer: one CSV per day (`<day>.csv`) and one row
per day in `summary.csv`. The workflow uploads both under `views/` in R2.

What a stored row can hold: only what the Worker writes, which is the route
template, the kind of request, the page language, the country code
Cloudflare's edge attaches, the referring site's host name, the status, for
an Atom feed the file name and the subscriber count a feed reader stated,
since 2026-10-30 whether the request came from a bot or a person and the
person's device class, and for a page view the page cache's state. The
Worker never writes an IP address, a user agent, a cookie, a full referrer
or a raw path, so no query can read one back. Each value read is checked
against the shape the Worker writes before it reaches a file, so a row
cannot carry more than that even if the dataset ever did.

People and bots (since 2026-10-30): the summary's human_* columns count page
views below status 400 by requests the Worker marked "human", bot_pages
those it marked "bot". unique_visitors and human_visits count distinct daily
visitor codes (blob10): the queries ask only for how many there are
(count(DISTINCT)), so no code ever leaves Analytics Engine. A day on which
any page view carries no bot flag (the days before the flag, and the day it
was deployed) gets blanks in every one of those columns, never figures that
would undercount; a day on which any person's request carries no code (no
VIEWS_SALT_KEY, or the secret set part way through the day) gets blank
visitor columns. A blank means "not counted", a 0 means none.

The page cache: blob11 holds the Worker's page cache state for a page
view, "hit", "miss" or "" (the cache did not consider the request).
page_cache_hits and page_cache_misses count page views below status 400
in each state. A day on which no page view is a hit or a miss gets blanks
in both, the same as a column that did not exist yet: the days before the
Worker wrote blob11 (their points read back with an empty blob11), and any
day the cache considered nothing. On the day the cache was deployed the two
count only the part of the day after the deploy.

Why a day is caught up rather than only yesterday: a night whose query fails
leaves a gap, and nothing should need a manual step to fill it. Each night
rolls up every day after the newest one in the summary, back to the three
months Analytics Engine still holds (all of them on the first night, which
keeps the counts written before the roll-up existed). A day with no data
points at all is not written: an empty day means the counting failed, not
that nobody came, and the next night asks again. Queries are per day: one
for the totals by kind, and seven more only for a day that has data points.

Why "failed" never stops the run: the counts are a record of the audience,
not part of the data refresh. The step reports the outcome in the run status
and the next night catches up.

Readings taken on the night, on the row for yesterday only: the Bluesky
follower count (the public profile endpoint, no token); the X follower count
once a month, on the row for a month's last day, when X posting is enabled
(X_POST_ENABLED and the four X secrets), since a profile read costs a credit
under X's pay-per-use API; and the site's employer and record counts from
tonight's stats.json. A row rolled up again without a reading keeps the one
it had.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlencode, urlsplit

from . import config

log = logging.getLogger(__name__)

SQL_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/analytics_engine/sql"
DATASET = "lmia_watch_views"
TOKEN_ENV = "CLOUDFLARE_ANALYTICS_TOKEN"
ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID"
BSKY_PROFILE_URL = "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile"
X_ME_URL = "https://api.x.com/2/users/me"

# Analytics Engine keeps data points for three months; asking for an older
# day returns nothing, and on a re-run would replace a kept row with zeros.
RETENTION_DAYS = 90
# Grouped rows per day. A day of this site's traffic has a few hundred; the
# cap keeps one answer bounded, and the per-kind totals (a separate query)
# stay exact if it is ever reached.
MAX_ROWS = 10_000

SUMMARY = "summary.csv"
# The days written by the last run, one per line, for the workflow's upload loop.
ROLLED_UP = "rolled_up.txt"

DAY_HEADER = ["date", "section", "route", "kind", "lang", "country", "referrer", "status", "feed",
              "responses", "subscribers", "agent", "device", "cache"]
# New columns go at the end: a summary written before them still reads, with
# the new columns blank on its rows.
SUMMARY_HEADER = ["date", "responses", "pages", "api", "downloads", "forms", "feeds", "other",
                  "feed_subscribers", "bluesky_followers", "top_routes",
                  "human_pages", "bot_pages", "unique_visitors", "human_visits",
                  "human_by_country", "human_by_device", "human_by_lang", "human_by_route",
                  "x_followers", "employers", "records", "page_cache_hits", "page_cache_misses"]
# The columns that are blank on a day counted before the bot flag.
AUDIENCE_COLUMNS = ["human_pages", "bot_pages", "unique_visitors", "human_visits",
                    "human_by_country", "human_by_device", "human_by_lang", "human_by_route"]
# Readings taken on the night (not counts of the day), kept when a re-run cannot take them again.
READINGS = ["bluesky_followers", "x_followers", "employers", "records"]
# Summary columns by the kind the Worker records; every other kind is "other".
KIND_COLUMNS = {"page": "pages", "api": "api", "download": "downloads", "form": "forms", "feed": "feeds"}
KINDS = {"page", "api", "download", "form", "hook", "file", "feed", "other"}
AGENTS = {"bot", "human"}
CACHE_STATES = {"hit", "miss"}
DEVICES = {"desktop", "mobile", "tablet"}
TOP_ROUTES = 5
TOP_COUNTRIES = 10
UNKNOWN = "unknown"

# The shapes site/src/views.ts writes. Anything else is blanked (or "other"
# for a route), never stored as read.
ROUTE_RE = re.compile(r"^(?:other|/[A-Za-z0-9._:/-]{0,99})$")
COUNTRY_RE = re.compile(r"^[A-Z0-9]{2}$")
HOST_RE = re.compile(r"^[a-z0-9.-]{1,100}$")
FEED_RE = re.compile(r"^feeds/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\.xml$")
ACCOUNT_RE = re.compile(r"^[0-9A-Fa-f]{16,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class QueryError(Exception):
    """The SQL API did not answer with rows."""


class SummaryError(Exception):
    """The summary file exists but cannot be read safely, so it is never replaced."""


# -- SQL ----------------------------------------------------------------------


def day_bounds(day: date) -> tuple[int, int]:
    """Unix seconds of the day's first instant and of the next day's, in UTC."""
    start = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())
    return start, start + 86_400


def _where(day: date) -> str:
    # Absolute unix bounds, so the server's time zone setting cannot move the day.
    start, end = day_bounds(day)
    return f"timestamp >= toDateTime({start}) AND timestamp < toDateTime({end})"


# Analytics Engine samples at high volume, so every count of responses is
# SUM(_sample_interval). The two visitor queries count distinct codes, which
# is exact while the dataset does not sample (this site's volume is far below
# where it starts) and an undercount if it ever does.
def kinds_sql(day: date) -> str:
    return (f"SELECT blob2 AS kind, SUM(_sample_interval) AS responses FROM {DATASET} "
            f"WHERE {_where(day)} GROUP BY kind ORDER BY kind FORMAT JSON")


def counts_sql(day: date) -> str:
    return ("SELECT blob1 AS route, blob2 AS kind, blob3 AS lang, blob4 AS country, blob5 AS referrer, "
            f"double1 AS status, SUM(_sample_interval) AS responses FROM {DATASET} WHERE {_where(day)} "
            "GROUP BY route, kind, lang, country, referrer, status "
            f"ORDER BY responses DESC LIMIT {MAX_ROWS} FORMAT JSON")


def feeds_sql(day: date) -> str:
    # blob7 is the feed file and double2 the subscriber count a reader stated
    # (0 when it stated none); the largest of the day is the figure kept.
    return (f"SELECT blob7 AS feed, SUM(_sample_interval) AS responses, MAX(double2) AS subscribers "
            f"FROM {DATASET} WHERE blob2 = 'feed' AND {_where(day)} GROUP BY feed ORDER BY feed FORMAT JSON")


def audience_sql(day: date) -> str:
    # Page views below 400 by bot flag (blob8), country, device (blob9) and
    # language. Points from before the flag answer with an empty agent.
    return ("SELECT blob8 AS agent, blob4 AS country, blob9 AS device, blob3 AS lang, "
            f"SUM(_sample_interval) AS pages FROM {DATASET} "
            f"WHERE blob2 = 'page' AND double1 < 400 AND {_where(day)} "
            f"GROUP BY agent, country, device, lang ORDER BY pages DESC LIMIT {MAX_ROWS} FORMAT JSON")


def human_routes_sql(day: date) -> str:
    return (f"SELECT blob1 AS route, SUM(_sample_interval) AS pages FROM {DATASET} "
            f"WHERE blob2 = 'page' AND double1 < 400 AND blob8 = 'human' AND {_where(day)} "
            f"GROUP BY route ORDER BY pages DESC LIMIT {MAX_ROWS} FORMAT JSON")


def visitors_sql(day: date) -> str:
    # Distinct codes over a person's every request, and how many of those
    # requests carry no code; any such request blanks the day's visitor counts.
    return ("SELECT count(DISTINCT blob10) AS visitors, sumIf(_sample_interval, blob10 = '') AS uncoded "
            f"FROM {DATASET} WHERE blob8 = 'human' AND {_where(day)} FORMAT JSON")


def visits_sql(day: date) -> str:
    # Distinct codes with at least one page view (any status).
    return (f"SELECT count(DISTINCT blob10) AS visits FROM {DATASET} "
            f"WHERE blob8 = 'human' AND blob2 = 'page' AND blob10 != '' AND {_where(day)} FORMAT JSON")


def page_cache_sql(day: date) -> str:
    # Page views below 400 by page cache state (blob11); points written
    # before the cache answer with an empty state.
    return (f"SELECT blob11 AS cache, SUM(_sample_interval) AS pages FROM {DATASET} "
            f"WHERE blob2 = 'page' AND double1 < 400 AND {_where(day)} GROUP BY cache ORDER BY cache FORMAT JSON")


# -- the API ------------------------------------------------------------------


def _status(resp: Any) -> int:
    return int(getattr(resp, "status_code", 0) or 0)


def _body(resp: Any) -> str:
    try:
        return re.sub(r"\s+", " ", str(resp.text))[:300]
    except Exception:
        return "(no body)"


def query(http: Any, account: str, token: str, sql: str, timeout: float = 60) -> list[dict[str, Any]]:
    """The rows of one SQL API answer. Raises QueryError for anything else.

    The token travels only in the Authorization header, never in a URL, so
    no error message or log line can carry it."""
    headers = {"Authorization": f"Bearer {token}", "User-Agent": config.USER_AGENT, "Content-Type": "text/plain"}
    try:
        resp = http.post(SQL_URL.format(account=account), data=sql.encode("utf-8"), headers=headers, timeout=timeout)
    except Exception as exc:
        raise QueryError(f"request failed ({type(exc).__name__}): {str(exc)[:200]}") from None
    status = _status(resp)
    if not 200 <= status < 300:
        raise QueryError(f"HTTP {status}: {_body(resp)}")
    try:
        rows = resp.json()["data"]
    except Exception:
        raise QueryError(f"HTTP {status} without rows: {_body(resp)}") from None
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise QueryError(f"HTTP {status}: data is not a list of rows")
    return rows


def _number(value: Any) -> float:
    """A count as the API gives it. JSON output quotes 64-bit integers, so
    "12" and 12 are both read; anything else is 0."""
    if isinstance(value, bool):
        return 0.0
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    return n if n == n and n not in (float("inf"), float("-inf")) and n >= 0 else 0.0


def _count(value: Any) -> int:
    return int(round(_number(value)))


def _count_or_none(value: Any) -> int | None:
    """A distinct count, or None when the answer carries none that can be read."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")) or n < 0:
        return None
    return int(round(n))


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


# -- one day ------------------------------------------------------------------


AudienceKey = tuple[str, str, str, str]  # (agent, country, device, lang)


@dataclass
class Day:
    day: date
    kinds: dict[str, int] = field(default_factory=dict)
    counts: dict[tuple[str, str, str, str, str, int], int] = field(default_factory=dict)
    feeds: dict[str, tuple[int, int]] = field(default_factory=dict)  # feed -> (fetches, most subscribers)
    truncated: bool = False
    audience: dict[AudienceKey, int] = field(default_factory=dict)  # page views below 400
    human_routes: dict[str, int] = field(default_factory=dict)
    visitors: int | None = None   # distinct codes over people's requests
    uncoded: int = 0              # people's requests without a code
    visits: int | None = None     # distinct codes with a page view
    page_cache: dict[str, int] = field(default_factory=dict)  # "hit", "miss" or "" -> page views below 400

    @property
    def total(self) -> int:
        return sum(self.kinds.values())

    @property
    def flagged(self) -> bool:
        """Every page view of the day carries a bot flag, so the people and bot columns can be filled."""
        agents = {key[0] for key, n in self.audience.items() if n > 0}
        return bool(agents) and agents <= AGENTS

    @property
    def coded(self) -> bool:
        """Every person's request of the day carries a visitor code."""
        return self.flagged and self.visitors is not None and self.uncoded == 0


def clean_kind(value: Any) -> str:
    kind = _text(value)
    return kind if kind in KINDS else "other"


def clean_route(value: Any) -> str:
    route = _text(value)
    return route if ROUTE_RE.match(route) else "other"


def clean_country(value: Any) -> str:
    country = _text(value)
    return country if COUNTRY_RE.match(country) else ""


def clean_lang(value: Any) -> str:
    lang = _text(value)
    return lang if lang in ("en", "fr") else ""


def clean_count_key(row: dict[str, Any]) -> tuple[str, str, str, str, str, int]:
    """(route, kind, lang, country, referrer, status), each in the shape the Worker writes."""
    referrer = _text(row.get("referrer"))
    status = _count(row.get("status"))
    return (
        clean_route(row.get("route")),
        clean_kind(row.get("kind")),
        clean_lang(row.get("lang")),
        clean_country(row.get("country")),
        referrer if HOST_RE.match(referrer) else "",
        status if 100 <= status <= 599 else 0,
    )


def clean_audience_key(row: dict[str, Any]) -> AudienceKey:
    """(agent, country, device, lang); an agent or device the Worker would not write is ""."""
    agent = _text(row.get("agent"))
    device = _text(row.get("device"))
    return (
        agent if agent in AGENTS else "",
        clean_country(row.get("country")),
        device if device in DEVICES else "",
        clean_lang(row.get("lang")),
    )


def build_day(day: date, kinds: list[dict], counts: list[dict], feeds: list[dict],
              audience: list[dict] | None = None, human_routes: list[dict] | None = None,
              visitors: list[dict] | None = None, visits: list[dict] | None = None,
              page_cache: list[dict] | None = None) -> Day:
    """One day from the answers. Rows that clean to the same key are added together."""
    out = Day(day)
    for row in kinds:
        kind = clean_kind(row.get("kind"))
        out.kinds[kind] = out.kinds.get(kind, 0) + _count(row.get("responses"))
    for row in counts:
        key = clean_count_key(row)
        out.counts[key] = out.counts.get(key, 0) + _count(row.get("responses"))
    out.truncated = len(counts) >= MAX_ROWS
    for row in feeds:
        name = _text(row.get("feed"))
        name = name if len(name) <= 120 and FEED_RE.match(name) else ""
        fetches, most = out.feeds.get(name, (0, 0))
        out.feeds[name] = (fetches + _count(row.get("responses")), max(most, _count(row.get("subscribers"))))
    for row in audience or []:
        akey = clean_audience_key(row)
        out.audience[akey] = out.audience.get(akey, 0) + _count(row.get("pages"))
    if audience is not None and len(audience) >= MAX_ROWS:
        out.truncated = True
    for row in human_routes or []:
        route = clean_route(row.get("route"))
        out.human_routes[route] = out.human_routes.get(route, 0) + _count(row.get("pages"))
    # One row each, from an aggregate without GROUP BY; anything else reads as not counted.
    if visitors is not None and len(visitors) == 1:
        out.visitors = _count_or_none(visitors[0].get("visitors"))
        uncoded = _count_or_none(visitors[0].get("uncoded"))
        out.uncoded = 1 if uncoded is None else uncoded
    if visits is not None and len(visits) == 1:
        out.visits = _count_or_none(visits[0].get("visits"))
    for row in page_cache or []:
        state = _text(row.get("cache"))
        state = state if state in CACHE_STATES else ""
        out.page_cache[state] = out.page_cache.get(state, 0) + _count(row.get("pages"))
    return out


def day_rows(d: Day) -> list[dict[str, Any]]:
    """The day file's rows: the total, the total per kind, every grouped count, every feed,
    the page views by bot flag, country, device and language, and the page views by page cache state."""
    stamp = d.day.isoformat()
    blank = dict.fromkeys(DAY_HEADER, "")
    rows: list[dict[str, Any]] = [dict(blank, date=stamp, section="total", responses=d.total)]
    for kind in sorted(d.kinds):
        rows.append(dict(blank, date=stamp, section="kind", kind=kind, responses=d.kinds[kind]))
    for (route, kind, lang, country, referrer, status), n in sorted(d.counts.items(), key=lambda kv: (-kv[1], kv[0])):
        rows.append(dict(blank, date=stamp, section="count", route=route, kind=kind, lang=lang, country=country,
                         referrer=referrer, status=status or "", responses=n))
    for name in sorted(d.feeds):
        fetches, most = d.feeds[name]
        rows.append(dict(blank, date=stamp, section="feed", route="/data/feeds/:file", kind="feed", feed=name,
                         responses=fetches, subscribers=most))
    for (agent, country, device, lang), n in sorted(d.audience.items(), key=lambda kv: (-kv[1], kv[0])):
        rows.append(dict(blank, date=stamp, section="audience", kind="page", agent=agent, country=country,
                         device=device, lang=lang, responses=n))
    for state in sorted(d.page_cache):
        rows.append(dict(blank, date=stamp, section="page_cache", kind="page", cache=state,
                         responses=d.page_cache[state]))
    return rows


def top_routes(d: Day, n: int = TOP_ROUTES) -> str:
    """The n route templates with the most responses below status 400, as short text."""
    by_route: dict[str, int] = {}
    for (route, _kind, _lang, _country, _referrer, status), count in d.counts.items():
        if 0 < status < 400:
            by_route[route] = by_route.get(route, 0) + count
    best = sorted(by_route.items(), key=lambda kv: (-kv[1], kv[0]))[:n]
    return "; ".join(f"{route} {count}" for route, count in best)


def _compact(counts: dict[str, int], top: int | None = None) -> str:
    """{"key": n, ...} largest first as compact JSON; with top, the rest summed under "other"."""
    ranked = sorted(((k, v) for k, v in counts.items() if v > 0), key=lambda kv: (-kv[1], kv[0]))
    out = dict(ranked if top is None else ranked[:top])
    if top is not None and len(ranked) > top:
        out["other"] = sum(v for _k, v in ranked[top:])
    return json.dumps(out, separators=(",", ":"))


def audience_columns(d: Day) -> dict[str, Any]:
    """The people and bot columns of the summary, or blanks when the day cannot fill them."""
    out: dict[str, Any] = dict.fromkeys(AUDIENCE_COLUMNS, "")
    if not d.flagged:
        return out
    by_country: dict[str, int] = {}
    by_device: dict[str, int] = {}
    by_lang: dict[str, int] = {}
    human = bot = 0
    for (agent, country, device, lang), n in d.audience.items():
        if agent == "bot":
            bot += n
            continue
        human += n
        by_country[country or UNKNOWN] = by_country.get(country or UNKNOWN, 0) + n
        by_device[device or UNKNOWN] = by_device.get(device or UNKNOWN, 0) + n
        by_lang[lang or UNKNOWN] = by_lang.get(lang or UNKNOWN, 0) + n
    out.update(
        human_pages=human, bot_pages=bot,
        human_by_country=_compact(by_country, TOP_COUNTRIES), human_by_device=_compact(by_device),
        human_by_lang=_compact(by_lang), human_by_route=_compact(d.human_routes),
    )
    if d.coded:
        out["unique_visitors"] = d.visitors
        out["human_visits"] = "" if d.visits is None else d.visits
    return out


def page_cache_columns(d: Day) -> dict[str, Any]:
    """Hits and misses, or blanks when no page view of the day was either."""
    hits, misses = d.page_cache.get("hit", 0), d.page_cache.get("miss", 0)
    if hits + misses == 0:
        return {"page_cache_hits": "", "page_cache_misses": ""}
    return {"page_cache_hits": hits, "page_cache_misses": misses}


def summary_row(d: Day, followers: int | None = None, *, x_followers: int | None = None,
                site_counts: dict[str, int] | None = None) -> dict[str, Any]:
    row: dict[str, Any] = dict.fromkeys(SUMMARY_HEADER, 0)
    row["date"] = d.day.isoformat()
    row["responses"] = d.total
    for kind, n in d.kinds.items():
        row[KIND_COLUMNS.get(kind, "other")] += n
    # A person who follows two feeds counts twice, and a feed read through two
    # services counts only the larger figure; the column says what readers stated.
    row["feed_subscribers"] = sum(most for name, (_fetches, most) in d.feeds.items() if name)
    row["bluesky_followers"] = "" if followers is None else followers
    row["top_routes"] = top_routes(d)
    row.update(audience_columns(d))
    row["x_followers"] = "" if x_followers is None else x_followers
    counts = site_counts or {}
    row["employers"] = counts.get("employers", "")
    row["records"] = counts.get("records", "")
    row.update(page_cache_columns(d))
    return row


# -- files --------------------------------------------------------------------


def _write_csv(path: Path, header: list[str], rows: list[dict[str, Any]]) -> None:
    """Write through a temporary file, so a run stopped part way never leaves half a file to upload."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=header, lineterminator="\n", extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial")
    partial.write_text(buf.getvalue(), encoding="utf-8")
    partial.replace(path)


def write_day(folder: Path, d: Day) -> Path:
    path = folder / f"{d.day.isoformat()}.csv"
    _write_csv(path, DAY_HEADER, day_rows(d))
    return path


def read_summary(path: Path) -> list[dict[str, str]]:
    """The summary's rows; none when the file does not exist (the first night).

    Raises SummaryError when the file exists but is empty, unreadable, has a
    column this code does not know, or a row without a date: replacing it
    then would lose the history it holds, so the run fails instead. A file
    written before the newer columns reads with them blank."""
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise SummaryError(f"{path.name} cannot be read: {exc}") from None
    if not text.strip():
        raise SummaryError(f"{path.name} is empty")
    reader = csv.DictReader(io.StringIO(text))
    header = reader.fieldnames or []
    unknown = [c for c in header if c not in SUMMARY_HEADER]
    if "date" not in header or unknown:
        raise SummaryError(f"{path.name} has an unexpected header: {','.join(header)[:200]}")
    rows = []
    for row in reader:
        stamp = row.get("date") or ""
        try:
            ok = None not in row and bool(DATE_RE.match(stamp)) and date.fromisoformat(stamp) is not None
        except ValueError:
            ok = False
        if not ok:
            raise SummaryError(f"{path.name} has a malformed row near {stamp[:20]!r}")
        rows.append({k: (row.get(k) or "") for k in SUMMARY_HEADER})
    return rows


def merge_summary(rows: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """rows with each new row added, or put in place of the row for its date, sorted by date.

    A follower count or a site count is a reading taken on the night, so a
    day rolled up again without one keeps the one it had."""
    by_date = {r["date"]: r for r in rows}
    for row in new:
        old = by_date.get(row["date"])
        merged = dict(row)
        if old:
            for column in READINGS:
                if merged.get(column) in ("", None):
                    merged[column] = old.get(column, "")
        by_date[row["date"]] = merged
    return [by_date[k] for k in sorted(by_date)]


def update_summary(path: Path, new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = merge_summary(read_summary(path), new)
    _write_csv(path, SUMMARY_HEADER, rows)
    return rows


# -- readings: Bluesky, X, the site's own counts ------------------------------


def parse_followers(payload: Any) -> int | None:
    """followersCount from a getProfile answer, when it is a whole number."""
    n = payload.get("followersCount") if isinstance(payload, dict) else None
    if isinstance(n, bool) or not isinstance(n, int) or n < 0:
        return None
    return n


def bluesky_handle(env: Mapping[str, str]) -> str:
    """BSKY_HANDLE, else the site's host name: the account's handle is its domain."""
    handle = (env.get("BSKY_HANDLE") or "").strip().lstrip("@")
    if handle:
        return handle
    host = urlsplit(config.SITE_URL).hostname or ""
    return "" if host.endswith(".example") else host


def bluesky_followers(http: Any, handle: str, timeout: float = 30) -> int | None:
    """The account's follower count, or None. The endpoint is public, so no token is sent."""
    if not handle:
        return None
    url = BSKY_PROFILE_URL + "?" + urlencode({"actor": handle})
    try:
        resp = http.get(url, headers={"User-Agent": config.USER_AGENT}, timeout=timeout)
        status = _status(resp)
        if not 200 <= status < 300:
            log.warning("views: Bluesky profile HTTP %s; no follower count: %s", status, _body(resp))
            return None
        n = parse_followers(resp.json())
    except Exception as exc:
        log.warning("views: Bluesky profile not readable (%s); no follower count", type(exc).__name__)
        return None
    if n is None:
        log.warning("views: the Bluesky profile carries no follower count")
    return n


def parse_x_followers(payload: Any) -> int | None:
    """public_metrics.followers_count from a GET /2/users/me answer."""
    try:
        n = payload["data"]["public_metrics"]["followers_count"]
    except (KeyError, TypeError):
        return None
    if isinstance(n, bool) or not isinstance(n, int) or n < 0:
        return None
    return n


def x_due(day: date, env: Mapping[str, str]) -> bool:
    """X is read once a month, for a month's last day, and only when X posting is enabled."""
    from .social import credentials_from_env

    last_of_month = (day + timedelta(days=1)).month != day.month
    return last_of_month and (env.get("X_POST_ENABLED") or "").strip() == "true" and credentials_from_env(env) is not None


def x_followers(http: Any, env: Mapping[str, str], timeout: float = 30) -> int | None:
    """The X account's follower count (one read, billed per use), or None. Never raises."""
    from .social import credentials_from_env

    creds = credentials_from_env(env)
    if creds is None:
        return None
    try:
        from requests_oauthlib import OAuth1

        auth = OAuth1(creds.api_key, creds.api_secret, creds.access_token, creds.access_token_secret)
        resp = http.get(X_ME_URL, params={"user.fields": "public_metrics"}, auth=auth,
                        headers={"User-Agent": config.USER_AGENT}, timeout=timeout)
        status = _status(resp)
        if not 200 <= status < 300:
            log.warning("views: X profile HTTP %s; no follower count: %s", status, _body(resp))
            return None
        n = parse_x_followers(resp.json())
    except Exception as exc:
        log.warning("views: X profile not readable (%s); no follower count", type(exc).__name__)
        return None
    if n is None:
        log.warning("views: the X profile carries no follower count")
    return n


def site_counts(stats_path: Path) -> dict[str, int]:
    """Employers and records (ESDC list rows, approved and refused) from tonight's stats.json; {} when unreadable."""
    try:
        counts = json.loads(stats_path.read_text(encoding="utf-8"))["counts"]
        employers = counts["employers"]
        records = counts["approved_records"] + counts["refused_records"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    if not all(isinstance(n, int) and not isinstance(n, bool) and n >= 0 for n in (employers, records)):
        return {}
    return {"employers": employers, "records": records}


# -- the run ------------------------------------------------------------------


def previous_day(now: datetime | None = None) -> date:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date() - timedelta(days=1)


def days_to_roll(held: list[str], yesterday: date) -> list[date]:
    """Every day after the newest one held, back to the retention limit, and
    always yesterday (rolled up again in place on a re-run)."""
    oldest = yesterday - timedelta(days=RETENTION_DAYS - 1)
    newest = max((date.fromisoformat(d) for d in held), default=None)
    start = oldest if newest is None else max(newest + timedelta(days=1), oldest)
    start = min(start, yesterday)
    return [start + timedelta(days=i) for i in range((yesterday - start).days + 1)]


def check_day(day: date, now: datetime | None = None) -> str | None:
    """Why a day asked for by hand cannot be rolled up, or None."""
    yesterday = previous_day(now)
    if day > yesterday:
        return f"{day} is not over yet (UTC)"
    if day < yesterday - timedelta(days=RETENTION_DAYS - 1):
        return f"{day} is older than the {RETENTION_DAYS} days Analytics Engine keeps"
    return None


def roll_day(http: Any, account: str, token: str, day: date) -> Day | None:
    """One day's counts, or None when the dataset holds no point for it."""
    kinds = query(http, account, token, kinds_sql(day))
    if sum(_count(r.get("responses")) for r in kinds) == 0:
        return None
    d = build_day(
        day, kinds,
        query(http, account, token, counts_sql(day)),
        query(http, account, token, feeds_sql(day)),
        audience=query(http, account, token, audience_sql(day)),
        human_routes=query(http, account, token, human_routes_sql(day)),
        visitors=query(http, account, token, visitors_sql(day)),
        visits=query(http, account, token, visits_sql(day)),
        page_cache=query(http, account, token, page_cache_sql(day)),
    )
    if d.truncated:
        log.warning("views: %s has more than %d grouped rows; the smallest are left out of the day file "
                    "(the totals are exact)", day, MAX_ROWS)
    return d


def run(out_dir: Path | None = None, *, day: date | None = None, env: Mapping[str, str] | None = None,
        session: Any | None = None, now: datetime | None = None, stats_path: Path | None = None) -> str:
    """Roll up the days due (or one day given by hand). Returns "rolled up",
    "no data" (no day had a data point), "no token" or "failed"; never raises."""
    try:
        return _run(out_dir, day=day, env=env, session=session, now=now, stats_path=stats_path)
    except Exception as exc:
        log.error("views: roll-up failed (%s): %s", type(exc).__name__, str(exc)[:200])
        return "failed"


def _run(out_dir: Path | None, *, day: date | None, env: Mapping[str, str] | None, session: Any | None,
         now: datetime | None, stats_path: Path | None) -> str:
    source = os.environ if env is None else env
    folder = out_dir or (config.OUT_DIR / "views")
    folder.mkdir(parents=True, exist_ok=True)
    # Cleared first, so the workflow never uploads days listed by an earlier run.
    (folder / ROLLED_UP).write_text("", encoding="utf-8")
    token = (source.get(TOKEN_ENV) or "").strip()
    if not token:
        log.info("no analytics token; nothing rolled up")
        return "no token"
    account = (source.get(ACCOUNT_ENV) or "").strip()
    if not ACCOUNT_RE.match(account):
        log.error("views: %s is missing or malformed; nothing rolled up", ACCOUNT_ENV)
        return "failed"
    if day is not None:
        problem = check_day(day, now)
        if problem:
            log.error("views: %s; nothing rolled up", problem)
            return "failed"

    try:
        held = read_summary(folder / SUMMARY)
    except SummaryError as exc:
        log.error("views: %s; nothing rolled up, and the summary is left as it is", exc)
        return "failed"
    yesterday = previous_day(now)
    days = [day] if day is not None else days_to_roll([r["date"] for r in held], yesterday)

    if session is None:
        import requests
        http: Any = requests.Session()
    else:
        http = session
    followers = x_count = None
    try:
        rolled: list[Day] = []
        for d in days:
            try:
                result = roll_day(http, account, token, d)
            except QueryError as exc:
                log.error("views: the SQL API failed for %s: %s", d, exc)
                return "failed"
            if result is None:
                log.info("views: no data points for %s; nothing written for it", d)
                continue
            rolled.append(result)
        if any(d.day == yesterday for d in rolled):
            followers = bluesky_followers(http, bluesky_handle(source))
            if x_due(yesterday, source):
                x_count = x_followers(http, source)
    finally:
        if session is None:
            http.close()

    if not rolled:
        log.info("views: no data points in %d day(s) asked; nothing rolled up", len(days))
        return "no data"
    counts = site_counts(stats_path or (config.OUT_DIR / "static" / "stats.json"))
    for d in rolled:
        path = write_day(folder, d)
        log.info("views: %s: %d responses, %d grouped rows, %d feeds%s -> %s", d.day, d.total, len(d.counts),
                 len(d.feeds), "" if d.flagged else " (no bot flag, people columns blank)", path.name)
    update_summary(folder / SUMMARY, [
        summary_row(d, followers, x_followers=x_count, site_counts=counts) if d.day == yesterday else summary_row(d)
        for d in rolled])
    (folder / ROLLED_UP).write_text("".join(f"{d.day.isoformat()}\n" for d in rolled), encoding="utf-8")
    return "rolled up"
