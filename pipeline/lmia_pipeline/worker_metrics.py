"""Nightly record of the Worker's CPU time, one row per finished UTC day, kept in R2.

Why: the Worker runs over the CPU time its plan includes, and the changes
made to bring it down need a before and after that outlives Cloudflare's
own window (about three months for this dataset). Once a night this asks
the GraphQL Analytics API for every finished UTC day the file does not hold
yet (normally only yesterday) and merges the answer into one CSV, which the
workflow keeps in R2 as metrics/worker_cpu.csv, the same way the audience
roll-up keeps views/summary.csv (views_rollup.py).

What is asked: the account-level dataset workersInvocationsAdaptive,
filtered on the Worker's script name and grouped by UTC date: requests,
errors, subrequests, CPU time and start-up CPU time (summed, in
microseconds), response body bytes, and the median and upper percentiles of
CPU time, start-up CPU time and memory. Adaptive datasets sample at high
volume and scale their sums back up, so a day's figures are estimates of
the same kind as the dashboard's.

Windows: Cloudflare answers Worker metrics "for up to three months in the
past in maximum increments of one week" (the Workers metrics and analytics
docs), so a catch-up is asked one week at a time and never reaches further
back than MAX_DAYS. Normally there is one window of one day.

Catch-up: every day after the newest row in the file, or from BASELINE_DAY
when the file is empty, so the figures from before the optimisations stay
in the record; up to and including yesterday (UTC). Today's partial day is
never asked for, so it is never written. A day Cloudflare returns nothing
for is not written and is asked again the next night while it is the
oldest day due.

Derived columns, recomputed over the whole file on every write so a row
replaced by a newer answer carries through: mean_cpu_ms (cpu_ms over
requests), startup_share (start-up CPU over CPU), month_to_date_cpu_ms (the
month's rows up to and including the day) and month_projection_cpu_ms (the
month to date scaled to the whole month by the calendar days elapsed).
included_cpu_ms is the plan's monthly allowance at the time the row was
first written.

Why "failed" never stops the run: the figures are a record of cost, not
part of the data refresh. The run status and LAST_RUN.md carry the
outcome, and the next night catches up. The token travels only in the
Authorization header and is never written to a file, a log line or the
outcome.
"""

from __future__ import annotations

import calendar
import csv
import io
import logging
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from . import config
from .views_rollup import ACCOUNT_RE, TOKEN_ENV

log = logging.getLogger(__name__)

GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
SCRIPT = "lmia-watch"
R2_KEY = "metrics/worker_cpu.csv"

# The Workers Paid plan's monthly allowance of CPU time (30 million CPU
# milliseconds). CPU time beyond it is billed per additional million
# milliseconds. The allowance belongs to the account and covers every
# Worker on it; this file counts the one Worker named, so the projection
# compared with it is that Worker's share of the allowance.
WORKERS_CPU_INCLUDED_MS = 30_000_000

# The first day kept: before the optimisations, so the record has a baseline.
BASELINE_DAY = date(2026, 11, 1)
# Cloudflare keeps about three months of this dataset; a day older than this
# would answer nothing, and a window of such days would be asked forever.
MAX_DAYS = 90
# The widest range one query may ask for (one week, per the docs above).
WINDOW_DAYS = 7

STATES = ("ok", "failed", "no credentials")

HEADER = ["date", "requests", "errors", "subrequests", "cpu_ms", "startup_cpu_ms", "mean_cpu_ms", "startup_share",
          "cpu_p50_ms", "cpu_p90_ms", "cpu_p99_ms", "startup_p50_ms", "memory_p50_mb", "body_bytes",
          "month_to_date_cpu_ms", "month_projection_cpu_ms", "included_cpu_ms"]
REQUIRED = ("date", "requests", "cpu_ms")

QUERY = (
    "query($acct:String!,$since:Time!,$until:Time!,$script:String!){viewer{accounts(filter:{accountTag:$acct}){\n"
    "  inv:workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$since,datetime_lt:$until,"
    "scriptName:$script},orderBy:[date_ASC]){\n"
    "    dimensions{date}\n"
    "    sum{requests errors subrequests cpuTimeUs startupCpuTimeUs responseBodySize}\n"
    "    quantiles{cpuTimeP50 cpuTimeP90 cpuTimeP99 startupCpuTimeUsP50 memoryUsageBytesP50}}}}}"
)
SUM_FIELDS = ("requests", "errors", "subrequests", "cpuTimeUs", "startupCpuTimeUs", "responseBodySize")
QUANTILE_FIELDS = ("cpuTimeP50", "cpuTimeP90", "cpuTimeP99", "startupCpuTimeUsP50", "memoryUsageBytesP50")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
# Worker names are lowercase letters, digits, dashes and underscores.
SCRIPT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
MIB = 1024 * 1024


class MetricsFileError(Exception):
    """The CSV exists but cannot be read safely, so it is never replaced."""


# -- the API ------------------------------------------------------------------


def _status(resp: Any) -> int:
    return int(getattr(resp, "status_code", 0) or 0)


def _body(resp: Any) -> str:
    try:
        return re.sub(r"\s+", " ", str(resp.text))[:300]
    except Exception:
        return "(no body)"


def _number(value: Any) -> float | None:
    """A figure as the API gives it (a number, sometimes a quoted one), or None."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")) or n < 0:
        return None
    return n


def _date(text: Any) -> date | None:
    if not isinstance(text, str) or not DATE_RE.match(text):
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def parse_group(group: Any) -> tuple[dict[str, str] | None, str]:
    """One day's row (the measured columns, as text) from one group of the answer,
    or None and why the group cannot be read."""
    if not isinstance(group, dict):
        return None, "unexpected answer: a group is not an object"
    dims, sums, quantiles = group.get("dimensions"), group.get("sum"), group.get("quantiles")
    if not all(isinstance(part, dict) for part in (dims, sums, quantiles)):
        return None, "unexpected answer: a group lacks dimensions, sum or quantiles"
    day = _date(dims.get("date"))
    if day is None:
        return None, f"unexpected answer: a group's date reads {str(dims.get('date'))[:20]!r}"
    figures: dict[str, float] = {}
    for name, part in [(f, sums) for f in SUM_FIELDS] + [(f, quantiles) for f in QUANTILE_FIELDS]:
        n = _number(part.get(name))
        if n is None:
            return None, f"unexpected answer: {name} on {day} is not a figure"
        figures[name] = n
    return {
        "date": day.isoformat(),
        "requests": str(round(figures["requests"])),
        "errors": str(round(figures["errors"])),
        "subrequests": str(round(figures["subrequests"])),
        "cpu_ms": str(round(figures["cpuTimeUs"] / 1000)),
        "startup_cpu_ms": str(round(figures["startupCpuTimeUs"] / 1000)),
        "cpu_p50_ms": f"{figures['cpuTimeP50'] / 1000:.3f}",
        "cpu_p90_ms": f"{figures['cpuTimeP90'] / 1000:.3f}",
        "cpu_p99_ms": f"{figures['cpuTimeP99'] / 1000:.3f}",
        "startup_p50_ms": f"{figures['startupCpuTimeUsP50'] / 1000:.3f}",
        "memory_p50_mb": f"{figures['memoryUsageBytesP50'] / MIB:.2f}",
        "body_bytes": str(round(figures["responseBodySize"])),
    }, ""


def parse_answer(payload: Any, wanted: set[date]) -> tuple[list[dict[str, str]] | None, str]:
    """The rows of a GraphQL answer for the days wanted, oldest first, or None
    and a short reason. A day outside the window asked for is left out."""
    if not isinstance(payload, dict):
        return None, "unexpected answer: not a JSON object"
    errors = payload.get("errors")
    if errors:
        first = errors[0] if isinstance(errors, list) and errors else errors
        message = first.get("message") if isinstance(first, dict) else None
        text = message if isinstance(message, str) and message else str(first)
        return None, f"GraphQL error: {' '.join(text.split())[:200]}"
    try:
        accounts = payload["data"]["viewer"]["accounts"]
    except (KeyError, TypeError):
        return None, "unexpected answer: no data.viewer.accounts"
    if not isinstance(accounts, list) or not accounts:
        return None, "no account in the answer (a wrong account id, or a token that cannot read it)"
    groups = accounts[0].get("inv") if isinstance(accounts[0], dict) else None
    if not isinstance(groups, list):
        return None, "unexpected answer: no list of invocation groups"
    rows: dict[str, dict[str, str]] = {}
    for group in groups:
        row, problem = parse_group(group)
        if row is None:
            return None, problem
        if date.fromisoformat(row["date"]) not in wanted:
            continue
        if row["date"] in rows:
            return None, f"unexpected answer: {row['date']} appears twice"
        rows[row["date"]] = row
    return [rows[k] for k in sorted(rows)], ""


def fetch_days(http: Any, account_id: str, token: str, script: str, days: list[date],
               timeout: float = 60) -> tuple[list[dict[str, str]] | None, str]:
    """One POST for the UTC days asked (at most a week). Returns (rows, "") or
    (None, why); never raises. Rows hold the measured columns as text."""
    if not days:
        return [], ""
    first, last = min(days), max(days)
    variables = {
        "acct": account_id,
        "since": f"{first.isoformat()}T00:00:00Z",
        "until": f"{(last + timedelta(days=1)).isoformat()}T00:00:00Z",
        "script": script,
    }
    headers = {"Authorization": f"Bearer {token}", "User-Agent": config.USER_AGENT, "Content-Type": "application/json"}
    try:
        resp = http.post(GRAPHQL_URL, json={"query": QUERY, "variables": variables}, headers=headers, timeout=timeout)
    except Exception as exc:
        return None, f"request failed ({type(exc).__name__}): {str(exc)[:200]}"
    status = _status(resp)
    if not 200 <= status < 300:
        return None, f"HTTP {status}: {_body(resp)}"
    try:
        payload = resp.json()
    except Exception:
        return None, f"HTTP {status} without JSON: {_body(resp)}"
    try:
        return parse_answer(payload, set(days))
    except Exception as exc:
        return None, f"unexpected answer ({type(exc).__name__})"


# -- the file -----------------------------------------------------------------


def _int(text: Any) -> int | None:
    try:
        n = int(str(text))
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def read_file(path: Path) -> list[dict[str, str]]:
    """The file's rows, oldest first; none when it does not exist (the first night).

    Raises MetricsFileError when it exists but is empty, unreadable, has a
    column this code does not know or lacks one it needs, or holds a row
    without a date or with an unreadable count: replacing it then would lose
    the history it holds. A file written before a newer column reads with it
    blank."""
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise MetricsFileError(f"{path.name} cannot be read: {exc}") from None
    if not text.strip():
        raise MetricsFileError(f"{path.name} is empty")
    reader = csv.DictReader(io.StringIO(text))
    header = reader.fieldnames or []
    if any(c not in HEADER for c in header) or any(c not in header for c in REQUIRED):
        raise MetricsFileError(f"{path.name} has an unexpected header: {','.join(header)[:200]}")
    rows = []
    for row in reader:
        stamp = row.get("date") or ""
        if None in row or _date(stamp) is None or _int(row.get("requests")) is None or _int(row.get("cpu_ms")) is None:
            raise MetricsFileError(f"{path.name} has a malformed row near {stamp[:20]!r}")
        rows.append({k: (row.get(k) or "") for k in HEADER})
    return sorted(rows, key=lambda r: r["date"])


def merge(rows: list[dict[str, str]], new: list[dict[str, str]]) -> list[dict[str, str]]:
    """rows with each new row added, or put in place of the row for its date, sorted by date."""
    by_date = {r["date"]: dict(r) for r in rows}
    for row in new:
        by_date[row["date"]] = dict(row)
    return [by_date[k] for k in sorted(by_date)]


def derive(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """Fill the derived columns of rows sorted by date (in place, and returned)."""
    month_total: dict[str, int] = {}
    for row in rows:
        day = date.fromisoformat(row["date"])
        requests, cpu = int(row["requests"]), int(row["cpu_ms"])
        startup = _int(row.get("startup_cpu_ms"))
        row["mean_cpu_ms"] = f"{cpu / requests:.3f}" if requests else ""
        row["startup_share"] = f"{startup / cpu:.3f}" if cpu and startup is not None else ""
        month = row["date"][:7]
        month_total[month] = month_total.get(month, 0) + cpu
        to_date = month_total[month]
        days_in_month = calendar.monthrange(day.year, day.month)[1]
        row["month_to_date_cpu_ms"] = str(to_date)
        row["month_projection_cpu_ms"] = str(round(to_date * days_in_month / day.day))
        if _int(row.get("included_cpu_ms")) is None:
            row["included_cpu_ms"] = str(WORKERS_CPU_INCLUDED_MS)
    return rows


def write_file(path: Path, rows: list[dict[str, str]]) -> None:
    """Write through a temporary file, so a run stopped part way never leaves half a file to upload."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=HEADER, lineterminator="\n", extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial")
    partial.write_bytes(buf.getvalue().encode("utf-8"))
    partial.replace(path)


# -- the run ------------------------------------------------------------------


def previous_day(now: datetime | None = None) -> date:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date() - timedelta(days=1)


def days_to_fetch(newest: date | None, yesterday: date) -> list[date]:
    """Every day after the newest row (from BASELINE_DAY when there is none) up
    to and including yesterday, never further back than MAX_DAYS."""
    start = BASELINE_DAY if newest is None else newest + timedelta(days=1)
    start = max(start, yesterday - timedelta(days=MAX_DAYS - 1))
    return [start + timedelta(days=i) for i in range((yesterday - start).days + 1)]


def windows(days: list[date], size: int = WINDOW_DAYS) -> list[list[date]]:
    return [days[i:i + size] for i in range(0, len(days), size)]


def _scrub(text: str, token: str) -> str:
    return text.replace(token, "[token]") if token else text


def _summary(state: str, detail: str, yesterday: date) -> dict[str, Any]:
    return {
        "state": state,
        "detail": detail,
        "days_fetched": [],
        "day": yesterday.isoformat(),
        "yesterday": None,
        "month": yesterday.strftime("%Y-%m"),
        "month_to_date_cpu_ms": None,
        "month_projection_cpu_ms": None,
        "included_cpu_ms": WORKERS_CPU_INCLUDED_MS,
    }


def _row_figures(row: dict[str, str]) -> dict[str, Any]:
    mean = row.get("mean_cpu_ms") or ""
    share = row.get("startup_share") or ""
    return {
        "date": row["date"],
        "requests": int(row["requests"]),
        "cpu_ms": int(row["cpu_ms"]),
        "mean_cpu_ms": float(mean) if mean else None,
        "startup_share": float(share) if share else None,
    }


def run(csv_path: Path, *, account: str | None, script: str = SCRIPT, env: Mapping[str, str] | None = None,
        session: Any | None = None, now: datetime | None = None) -> dict[str, Any]:
    """Fetch the days due into csv_path. Returns the outcome summary, whose
    state is "ok", "failed" or "no credentials"; never raises. The file is
    written only when a day was fetched."""
    source = os.environ if env is None else env
    token = (source.get(TOKEN_ENV) or "").strip()
    yesterday = previous_day(now)
    try:
        return _run(csv_path, account=(account or "").strip(), script=script, token=token, session=session,
                    yesterday=yesterday)
    except Exception as exc:
        detail = _scrub(f"{type(exc).__name__}: {str(exc)[:200]}", token)
        log.error("worker metrics failed: %s", detail)
        return _summary("failed", detail, yesterday)


def _run(csv_path: Path, *, account: str, script: str, token: str, session: Any | None,
         yesterday: date) -> dict[str, Any]:
    if not token:
        return _summary("no credentials", f"{TOKEN_ENV} is not set", yesterday)
    if not account:
        return _summary("no credentials", "no account id", yesterday)
    if not ACCOUNT_RE.match(account):
        return _summary("failed", "the account id is malformed", yesterday)
    if not SCRIPT_RE.match(script):
        return _summary("failed", "the script name is malformed", yesterday)
    try:
        held = read_file(csv_path)
    except MetricsFileError as exc:
        return _summary("failed", f"{exc}; nothing fetched, and the file is left as it is", yesterday)

    days = days_to_fetch(date.fromisoformat(held[-1]["date"]) if held else None, yesterday)
    fetched: list[dict[str, str]] = []
    if days:
        if session is None:
            import requests
            http: Any = requests.Session()
        else:
            http = session
        try:
            for window in windows(days):
                rows, detail = fetch_days(http, account, token, script, window)
                if rows is None:
                    detail = _scrub(f"{window[0]} to {window[-1]}: {detail}", token)
                    log.error("worker metrics: %s", detail)
                    return _summary("failed", detail, yesterday)
                fetched.extend(rows)
        finally:
            if session is None:
                http.close()

    rows = derive(merge(held, fetched))
    if fetched:
        write_file(csv_path, rows)
    if not days:
        detail = "up to date"
    elif fetched:
        detail = f"{len(fetched)} day{'s' if len(fetched) != 1 else ''} fetched"
    else:
        detail = f"no figures for the {len(days)} day{'s' if len(days) != 1 else ''} asked"
    out = _summary("ok", detail, yesterday)
    out["days_fetched"] = [r["date"] for r in fetched]
    by_date = {r["date"]: r for r in rows}
    if yesterday.isoformat() in by_date:
        out["yesterday"] = _row_figures(by_date[yesterday.isoformat()])
    in_month = [r for r in rows if r["date"][:7] == out["month"] and r["date"] <= yesterday.isoformat()]
    if in_month:
        newest = in_month[-1]
        out["month_to_date_cpu_ms"] = int(newest["month_to_date_cpu_ms"])
        out["month_projection_cpu_ms"] = int(newest["month_projection_cpu_ms"])
        out["included_cpu_ms"] = int(newest["included_cpu_ms"])
    log.info("worker metrics: %s", detail)
    return out


# -- the run status and LAST_RUN.md -------------------------------------------


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _ratio(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value == value and 0 <= value < float("inf") else None


def status_field(summary: Any) -> dict[str, Any]:
    """The run status's worker_metrics field from the step's outcome summary:
    known keys only, each checked, so a damaged file cannot carry anything else.
    {"state": "not run"} when the step left no summary."""
    if not isinstance(summary, dict):
        return {"state": "not run"}
    state = summary.get("state")
    if state not in STATES:
        return {"state": "failed", "detail": "the step's outcome could not be read"}
    out: dict[str, Any] = {"state": state, "detail": " ".join(str(summary.get("detail") or "").split())[:300]}
    days = summary.get("days_fetched")
    out["days_fetched"] = [d for d in days if _date(d)][:MAX_DAYS] if isinstance(days, list) else []
    out["day"] = summary.get("day") if _date(summary.get("day")) else None
    row = summary.get("yesterday")
    if isinstance(row, dict) and _date(row.get("date")) and _count(row.get("requests")) is not None \
            and _count(row.get("cpu_ms")) is not None:
        out["yesterday"] = {"date": row["date"], "requests": row["requests"], "cpu_ms": row["cpu_ms"],
                            "mean_cpu_ms": _ratio(row.get("mean_cpu_ms")),
                            "startup_share": _ratio(row.get("startup_share"))}
    else:
        out["yesterday"] = None
    month = summary.get("month")
    out["month"] = month if isinstance(month, str) and MONTH_RE.match(month) else None
    for key in ("month_to_date_cpu_ms", "month_projection_cpu_ms", "included_cpu_ms"):
        out[key] = _count(summary.get(key))
    return out


def _millions(ms: int) -> str:
    text = f"{ms / 1_000_000:.1f}"
    return (text[:-2] if text.endswith(".0") else text) + "M"


def last_run_line(field: Any) -> str | None:
    """The line LAST_RUN.md carries, or None when the step did not run.

    "Worker CPU: 2026-11-13: 2,305,908 ms over 238,037 requests (9.7 ms mean,
    start-up 32%); month to date 26.1M of 30M included, projection 48.2M"."""
    if not isinstance(field, dict) or field.get("state") not in STATES:
        return None
    state, detail = field["state"], field.get("detail") or ""
    if state == "no credentials":
        return "Worker CPU: no credentials"
    if state == "failed":
        return "Worker CPU: failed (caught up next run)" + (f": {detail}" if detail else "")
    parts = []
    row = field.get("yesterday")
    if isinstance(row, dict):
        text = f"{row['date']}: {row['cpu_ms']:,} ms over {row['requests']:,} requests"
        notes = []
        if row.get("mean_cpu_ms") is not None:
            notes.append(f"{row['mean_cpu_ms']:.1f} ms mean")
        if row.get("startup_share") is not None:
            notes.append(f"start-up {100 * row['startup_share']:.0f}%")
        parts.append(text + (f" ({', '.join(notes)})" if notes else ""))
    else:
        parts.append(f"no figures for {field.get('day') or 'yesterday'} ({detail})" if detail else
                     f"no figures for {field.get('day') or 'yesterday'}")
    to_date, projection, included = (field.get("month_to_date_cpu_ms"), field.get("month_projection_cpu_ms"),
                                     field.get("included_cpu_ms"))
    if isinstance(to_date, int) and isinstance(projection, int) and isinstance(included, int):
        parts.append(f"month to date {_millions(to_date)} of {_millions(included)} included, "
                     f"projection {_millions(projection)}")
    return "Worker CPU: " + "; ".join(parts)
