"""The parts of the nightly workflow that let a failed night heal by itself.

nightly.py calls these from its command line; the workflow calls nightly.py.

  gate          decide whether a retry trigger (06:00 and 12:00 UTC) has
                anything to do, from the status.json the last run left in R2.
  live_version  the Worker version serving traffic, from Wrangler's JSON, so
                a deploy that breaks the site can be rolled back to it.
  smoke         fetch a few pages of the live site after a deploy and judge
                it ok, broken (the Worker answers 5xx) or unverifiable (the
                edge refused the runner, or the answer proves nothing).
  bundle_check  for the site-only deploy: compare the data files of R2's
                static.tar.gz with the ones the live site serves.
  R2Rest        list the bucket and download one object through Cloudflare's
                REST API, for the weekly snapshot the restore falls back to.
  run_checks    every night, that Cloudflare leaves the site's HTML as the
                Worker sent it; on the first of a month also the expiry
                dates of the tokens and the domain.
  attention_items, issue_texts
                the items the run's last step reports, and the text of the
                GitHub issue it opens, updates or closes.
  notice_items  the run's notices: information for LAST_RUN.md and the
                daily check's email, never an item needing attention.

Every function here returns its finding rather than raising: a fault in this
layer must never stop a night that would otherwise have worked. Tokens travel
only in Authorization headers and are scrubbed from any message, so no log
line, file or issue can carry one.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import quote, urlencode, urlsplit

from . import config

log = logging.getLogger("lmia_pipeline.resilience")

API = "https://api.cloudflare.com/client/v4"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _parse_iso(text: Any) -> datetime | None:
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        when = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def _status_code(resp: Any) -> int:
    try:
        return int(getattr(resp, "status_code", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _scrub(text: str, *secrets: str | None) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[token]")
    return text


def _api_errors(resp: Any) -> str:
    """Cloudflare's own error codes and messages, short; never the request."""
    try:
        errors = resp.json().get("errors") or []
        parts = [f"{e.get('code')} {e.get('message')}" for e in errors if isinstance(e, dict)]
    except Exception:
        return ""
    return f" ({'; '.join(parts)[:160]})" if parts else ""


def _api_codes(resp: Any) -> set[int]:
    try:
        return {int(e.get("code")) for e in resp.json().get("errors") or [] if isinstance(e, dict)}
    except Exception:
        return set()


# -- gate ---------------------------------------------------------------------


def gate(status: Any, today: date) -> tuple[bool, str]:
    """(skip, reason) for a retry trigger. Skip only when the status shows that
    a run finished today (UTC) clean and deployed; anything else, a missing or
    unreadable status included, runs the refresh again. The pipeline's
    20-hour guard keeps a second Job Bank pass from following a complete one."""
    if not isinstance(status, dict):
        return False, "no readable run status, so the refresh runs"
    when = _parse_iso(status.get("run_at"))
    if when is None:
        return False, "the run status has no readable run time, so the refresh runs"
    finished = when.astimezone(timezone.utc).date()
    if finished != today:
        return False, f"the last run finished on {finished}, not today ({today}), so the refresh runs"
    if status.get("ok") is not True:
        return False, "today's run did not finish clean, so the refresh runs again"
    steps = status.get("steps")
    if not isinstance(steps, dict) or steps.get("deploy") != "success":
        return False, "today's run did not deploy, so the refresh runs again"
    return True, f"today's run finished clean at {status['run_at']}; nothing to do"


# -- the live version ---------------------------------------------------------


def _first_json(text: str) -> Any:
    """The first JSON value in text. Wrangler may print a notice before it."""
    decoder = json.JSONDecoder()
    start = 0
    while True:
        found = [i for i in (text.find("{", start), text.find("[", start)) if i >= 0]
        if not found:
            raise ValueError("no JSON in the output")
        i = min(found)
        try:
            return decoder.raw_decode(text, i)[0]
        except ValueError:
            start = i + 1


def _largest_share(versions: list[Any]) -> str | None:
    best: tuple[float, str] | None = None
    for v in versions:
        if not isinstance(v, dict):
            continue
        vid, share = v.get("version_id"), v.get("percentage")
        if not isinstance(vid, str) or not UUID_RE.match(vid):
            continue
        try:
            pct = float(share)
        except (TypeError, ValueError):
            continue
        if best is None or pct > best[0]:
            best = (pct, vid)
    return best[1] if best else None


def live_version(text: str) -> str | None:
    """The Worker version serving traffic, or None.

    Reads `wrangler deployments status --json` (one deployment: the version
    with the largest share of traffic), and also the lists that
    `wrangler deployments list --json` and `wrangler versions list --json`
    print (the newest by created_on). The workflow uses deployments status:
    versions list returns every deployable version, and one uploaded without
    being deployed would be newer than the one serving traffic. Only a
    well-formed version id is returned, so the value is safe on a command line.
    """
    try:
        data = _first_json(text or "")
    except ValueError:
        return None
    if isinstance(data, dict) and isinstance(data.get("versions"), list):
        return _largest_share(data["versions"])
    if not isinstance(data, list):
        return None
    dated: list[tuple[datetime, str]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("versions"), list):
            vid, stamp = _largest_share(item["versions"]), item.get("created_on")
        else:
            meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            vid, stamp = item.get("id"), meta.get("created_on")
        when = _parse_iso(stamp)
        if isinstance(vid, str) and UUID_RE.match(vid) and when is not None:
            dated.append((when, vid))
    return max(dated)[1] if dated else None


# -- smoke test ---------------------------------------------------------------

SMOKE_PAGES = ("/", "/search", "/data")
# Pages that print the data date (the layout's "Data as of"); the deploy
# carried tonight's export only if they show it.
DATED_PAGES = {"/", "/data"}
SMOKE_RETRY_S = 30.0
# A new version reaches every edge location within seconds of the deploy.
SMOKE_SETTLE_S = 20.0
SMOKE_TIMEOUT_S = 30.0
EMPLOYER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Text of Cloudflare's challenge and block pages. The edge answers a challenge
# with 403 or, in Under Attack Mode, 503; neither says anything about the Worker.
CHALLENGE_MARKERS = ("cf-chl", "challenge-platform", "just a moment...", "attention required! | cloudflare",
                     "cf-error-details", "sorry, you have been blocked")
MAX_BODY = 2_000_000

VERDICTS = ("ok", "broken", "unverifiable")


@dataclass
class Attempt:
    status: int  # 0 when no answer came
    kind: str  # ok, server, edge, stale, other
    note: str


@dataclass
class PageResult:
    path: str
    attempts: list[Attempt] = field(default_factory=list)

    @property
    def final(self) -> Attempt:
        return self.attempts[-1]

    def as_dict(self) -> dict[str, Any]:
        return {"path": self.path, "attempts": [{"status": a.status, "kind": a.kind, "note": a.note} for a in self.attempts]}


def _challenge(resp: Any, body: str) -> bool:
    try:
        headers = {str(k).lower(): str(v).lower() for k, v in (getattr(resp, "headers", None) or {}).items()}
    except Exception:
        headers = {}
    if headers.get("cf-mitigated") == "challenge":
        return True
    low = body[:20_000].lower()
    return any(m in low for m in CHALLENGE_MARKERS)


def judge_answer(path: str, status: int, body: str, challenge: bool, data_date: str | None) -> Attempt:
    """One answer, classified."""
    if challenge or status == 403:
        return Attempt(status, "edge", f"{path}: {status} from the edge (the runner may be blocked by the dashboard's rules)")
    if 500 <= status <= 599:
        return Attempt(status, "server", f"{path}: {status}")
    if status != 200:
        return Attempt(status, "other", f"{path}: {status or 'no answer'}")
    if path in DATED_PAGES:
        if not data_date:
            return Attempt(status, "stale", f"{path}: 200, but no data date was given to look for")
        if data_date not in body:
            return Attempt(status, "stale", f"{path}: 200 without the data date {data_date}")
    return Attempt(status, "ok", f"{path}: 200")


def fetch(http: Any, base_url: str, path: str, data_date: str | None, timeout: float = SMOKE_TIMEOUT_S) -> Attempt:
    url = base_url.rstrip("/") + path
    try:
        resp = http.get(url, headers={"User-Agent": config.USER_AGENT, "Cache-Control": "no-cache"}, timeout=timeout)
    except Exception as exc:
        return Attempt(0, "other", f"{path}: no answer ({type(exc).__name__})")
    status = _status_code(resp)
    try:
        body = str(resp.text)[:MAX_BODY]
    except Exception:
        body = ""
    return judge_answer(path, status, body, _challenge(resp, body), data_date)


def smoke_paths(stats: Any) -> list[str]:
    """The pages to fetch: home, search, data, and the first employer of the
    approvals table when stats.json names a well-formed id."""
    paths = list(SMOKE_PAGES)
    rows = stats.get("top_approvals") if isinstance(stats, dict) else None
    for row in rows if isinstance(rows, list) else []:
        eid = row.get("employer_id") if isinstance(row, dict) else None
        if isinstance(eid, str) and EMPLOYER_ID_RE.match(eid):
            paths.append(f"/employers/{eid}")
            break
    return paths


def judge(results: list[PageResult]) -> tuple[str, str]:
    """(verdict, detail). broken: some page answered 5xx on both tries. ok:
    every page's last answer was 200 (with the data date where it is
    printed). unverifiable: anything else, the edge refusing the runner
    included, which is never a reason to roll back."""
    broken = [r for r in results if len(r.attempts) >= 2 and all(a.kind == "server" for a in r.attempts[:2])]
    if broken:
        return "broken", "; ".join(f"{r.path} answered {r.attempts[0].status} and {r.attempts[1].status}" for r in broken)
    if results and all(r.final.kind == "ok" for r in results):
        return "ok", f"{len(results)} pages answered 200"
    if not results:
        return "unverifiable", "no page was fetched"
    return "unverifiable", "; ".join(r.final.note for r in results if r.final.kind != "ok")[:400]


def smoke(http: Any, base_url: str, data_date: str | None, paths: list[str], *,
          sleep: Callable[[float], None] = time.sleep, settle: float = SMOKE_SETTLE_S,
          retry_after: float = SMOKE_RETRY_S) -> dict[str, Any]:
    """Fetch every page, then once more after retry_after seconds each page
    whose first answer was not ok, and judge. Never raises."""
    try:
        if settle:
            sleep(settle)
        results = [PageResult(p, [fetch(http, base_url, p, data_date)]) for p in paths]
        again = [r for r in results if r.final.kind != "ok"]
        if again:
            sleep(retry_after)
            for r in again:
                r.attempts.append(fetch(http, base_url, r.path, data_date))
        verdict, detail = judge(results)
        pages = [r.as_dict() for r in results]
    except Exception as exc:
        verdict, detail, pages = "unverifiable", f"the check itself failed ({type(exc).__name__})", []
    return {"verdict": verdict, "detail": detail, "base_url": base_url, "data_date": data_date, "pages": pages}


# -- site bundle check --------------------------------------------------------

# The files the site-only deploy (.github/workflows/deploy-site.yml) compares
# between R2's static.tar.gz and the live site. stats.json lists the newest
# runs with their times and changes with every refresh, so an archive from
# any other night fails; the two search files are what the search page shows
# first.
BUNDLE_FILES = ("stats.json", "search/facets.json", "search/first.json")
BUNDLE_RETRY_S = 10.0
# The Worker refuses an asset above 25 MiB, so nothing larger is one of its files.
MAX_BUNDLE_FILE = 25 * 1024 * 1024
SAVED_LABEL = "the copy saved before the deploy"


def _canonical(raw: bytes) -> str | None:
    """One text per JSON value, or None when raw is not JSON. Key order and
    spacing do not count; a change of type does (true is not 1, 1 is not 1.0)."""
    try:
        return json.dumps(json.loads(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    except (ValueError, TypeError, RecursionError):
        return None


def _archive_file(bundle: Path, rel: str) -> tuple[bytes | None, str]:
    path = bundle / rel
    try:
        if not path.is_file():
            return None, f"{rel}: not in the archive"
        if path.stat().st_size > MAX_BUNDLE_FILE:
            return None, f"{rel}: the archive's copy is larger than any asset the site can serve"
        return path.read_bytes(), ""
    except OSError as exc:
        return None, f"{rel}: the archive's copy could not be read ({type(exc).__name__})"


def _fetch_bytes(http: Any, url: str, timeout: float) -> tuple[bytes | None, str]:
    try:
        resp = http.get(url, headers={"User-Agent": config.USER_AGENT, "Cache-Control": "no-cache"}, timeout=timeout)
    except Exception as exc:
        return None, f"no answer ({type(exc).__name__})"
    status = _status_code(resp)
    if status != 200:
        return None, f"answered {status or 'nothing'}"
    try:
        body = bytes(resp.content)
    except Exception:
        return None, "answered 200 without a readable body"
    if len(body) > MAX_BUNDLE_FILE:
        return None, "answered with more than any asset can hold"
    return body, ""


def _compare(rel: str, against: str, archive: bytes, other: bytes | None, why: str) -> dict[str, str]:
    entry = {"file": rel, "against": against}
    if other is None:
        return entry | {"result": "unreachable", "note": f"{rel}: {against} {why}"}
    mine, theirs = _canonical(archive), _canonical(other)
    if mine is None:
        return entry | {"result": "unreadable", "note": f"{rel}: the archive's copy is not JSON"}
    if theirs is None:
        return entry | {"result": "unreadable", "note": f"{rel}: {against} is not JSON"}
    if mine != theirs:
        return entry | {"result": "differs", "note": f"{rel}: the archive and {against} differ"}
    return entry | {"result": "same", "note": f"{rel}: the same as {against}"}


def bundle_check(http: Any, base_url: str, bundle: Path, saved_stats: Path | None = None, *,
                 sleep: Callable[[float], None] = time.sleep, retry_after: float = BUNDLE_RETRY_S,
                 timeout: float = SMOKE_TIMEOUT_S) -> tuple[dict[str, Any], bytes | None]:
    """Compare the unpacked archive's BUNDLE_FILES with the ones the live site
    serves under /data/, as parsed JSON, and, when saved_stats is given, the
    archive's stats.json with that file as well. A file the site does not
    answer 200 for is fetched once more after retry_after seconds.

    Returns (record, live stats.json bytes). record["ok"] is true only when
    every comparison found the same value; a file missing from the archive,
    an answer other than 200, or a body that is not JSON is never ok. Never
    raises."""
    base = base_url.rstrip("/")
    files: list[dict[str, str]] = []
    live_stats: bytes | None = None
    try:
        for rel in BUNDLE_FILES:
            url = f"{base}/data/{rel}"
            archive, note = _archive_file(bundle, rel)
            if archive is None:
                files.append({"file": rel, "against": url, "result": "missing", "note": note})
                continue
            body, why = _fetch_bytes(http, url, timeout)
            if body is None:
                sleep(retry_after)
                body, why = _fetch_bytes(http, url, timeout)
            if rel == "stats.json":
                live_stats = body
            files.append(_compare(rel, url, archive, body, why))
        if saved_stats is not None:
            archive, note = _archive_file(bundle, "stats.json")
            if archive is None:
                files.append({"file": "stats.json", "against": SAVED_LABEL, "result": "missing", "note": note})
            else:
                try:
                    saved, why = saved_stats.read_bytes(), ""
                except OSError as exc:
                    saved, why = None, f"could not be read ({type(exc).__name__})"
                files.append(_compare("stats.json", SAVED_LABEL, archive, saved, why))
    except Exception as exc:
        files.append({"file": "(all)", "against": base, "result": "error",
                      "note": f"the check itself failed ({type(exc).__name__})"})
    ok = bool(files) and all(f["result"] == "same" for f in files)
    return {"ok": ok, "base_url": base_url, "files": files}, live_stats


# -- R2 through the REST API --------------------------------------------------

DATA_BUCKET = "lmia-watch-data"
WEEKLY_PREFIX = "backups/weekly/db-slot-"
WEEKLY_RE = re.compile(r"^backups/weekly/db-slot-\d+\.sqlite\.gz$")
# A listing of the weekly folder is a handful of objects; the cap only bounds
# a cursor that never ends.
MAX_LIST_PAGES = 20


class R2Error(Exception):
    """R2 did not answer as expected. The message never carries the token."""


class R2Rest:
    """The two R2 calls Wrangler has no command for: a listing, and the
    download of an object found by it. Same token as the rest of the run
    (CLOUDFLARE_API_TOKEN, R2 edit on the project account)."""

    def __init__(self, http: Any, account: str, token: str, bucket: str, timeout: float = 120) -> None:
        self.http, self.account, self.token, self.bucket, self.timeout = http, account, token, bucket, timeout

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "User-Agent": config.USER_AGENT}

    def _base(self) -> str:
        return f"{API}/accounts/{quote(self.account, safe='')}/r2/buckets/{quote(self.bucket, safe='')}/objects"

    def _fail(self, what: str, exc: Exception | None = None, resp: Any = None) -> R2Error:
        if exc is not None:
            text = f"{what} failed ({type(exc).__name__}: {str(exc)[:120]})"
        else:
            text = f"{what} answered HTTP {_status_code(resp)}{_api_errors(resp)}"
        return R2Error(_scrub(text, self.token, self.account))

    def list(self, prefix: str) -> list[dict[str, Any]]:
        objects: list[dict[str, Any]] = []
        cursor = None
        for _ in range(MAX_LIST_PAGES):
            params = {"prefix": prefix, "per_page": 100}
            if cursor:
                params["cursor"] = cursor
            try:
                resp = self.http.get(f"{self._base()}?{urlencode(params)}", headers=self._headers(), timeout=self.timeout)
            except Exception as exc:
                raise self._fail("the listing", exc) from None
            if _status_code(resp) != 200:
                raise self._fail("the listing", resp=resp)
            try:
                payload = resp.json()
                result = payload.get("result")
            except Exception:
                raise R2Error("the listing answered without JSON") from None
            if isinstance(result, dict):
                result = result.get("objects")
            if not isinstance(result, list) or payload.get("success") is False:
                raise R2Error("the listing answered without a list of objects")
            objects.extend(o for o in result if isinstance(o, dict))
            info = payload.get("result_info") if isinstance(payload.get("result_info"), dict) else {}
            cursor = info.get("cursor") if info.get("is_truncated") else None
            if not cursor:
                return objects
        raise R2Error(f"the listing did not end after {MAX_LIST_PAGES} pages")

    def newest_weekly(self) -> tuple[str, str] | None:
        """(key, upload time) of the newest weekly database snapshot, or None
        when the bucket holds none. Raises R2Error when that cannot be known."""
        best: tuple[datetime, str, str] | None = None
        undated = 0
        for obj in self.list(WEEKLY_PREFIX):
            key = obj.get("key")
            if not isinstance(key, str) or not WEEKLY_RE.match(key):
                continue
            when = _parse_iso(obj.get("last_modified") or obj.get("uploaded"))
            if when is None:
                undated += 1
                continue
            if best is None or when > best[0]:
                best = (when, key, when.astimezone(timezone.utc).isoformat(timespec="seconds"))
        # Snapshots that cannot be ordered are not "no snapshot": reading
        # them as none would start a first run over a week of history.
        if best is None and undated:
            raise R2Error(f"the listing named {undated} snapshot(s) without an upload time")
        return (best[1], best[2]) if best else None

    def download(self, key: str, dest: Path) -> int:
        """Write the object to dest (through a partial file); its size in bytes."""
        url = f"{self._base()}/{quote(key, safe='/')}"
        partial = dest.with_name(dest.name + ".partial")
        try:
            resp = self.http.get(url, headers=self._headers(), timeout=self.timeout, stream=True)
        except Exception as exc:
            raise self._fail(f"the download of {key}", exc) from None
        if _status_code(resp) != 200:
            raise self._fail(f"the download of {key}", resp=resp)
        size = 0
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with partial.open("wb") as fh:
                for chunk in resp.iter_content(1 << 20):
                    if chunk:
                        fh.write(chunk)
                        size += len(chunk)
        except Exception as exc:
            partial.unlink(missing_ok=True)
            raise self._fail(f"the download of {key}", exc) from None
        finally:
            close = getattr(resp, "close", None)
            if callable(close):
                close()
        partial.replace(dest)
        return size

    def get_bytes(self, key: str, max_bytes: int = 32 << 20) -> bytes | None:
        """A small object's bytes, or None when the bucket holds no such key.

        Raises R2Error for anything else (a missing bucket included), so a read
        that failed is never taken for an object that does not exist."""
        url = f"{self._base()}/{quote(key, safe='/')}"
        try:
            resp = self.http.get(url, headers=self._headers(), timeout=self.timeout, stream=True)
        except Exception as exc:
            raise self._fail(f"the download of {key}", exc) from None
        try:
            status = _status_code(resp)
            # 10006 is "the bucket does not exist"; 10007 (or no code) is the key.
            if status == 404 and 10006 not in _api_codes(resp):
                return None
            if status != 200:
                raise self._fail(f"the download of {key}", resp=resp)
            parts: list[bytes] = []
            size = 0
            for chunk in resp.iter_content(1 << 16):
                if chunk:
                    parts.append(chunk)
                    size += len(chunk)
                    if size > max_bytes:
                        raise R2Error(f"{key} is larger than {max_bytes} bytes")
            return b"".join(parts)
        except R2Error:
            raise
        except Exception as exc:
            raise self._fail(f"the download of {key}", exc) from None
        finally:
            close = getattr(resp, "close", None)
            if callable(close):
                close()

    def upload(self, key: str, data: bytes, content_type: str) -> None:
        """Put one small object (the path Wrangler's own r2 object put takes)."""
        url = f"{self._base()}/{quote(key, safe='/')}"
        try:
            resp = self.http.put(url, data=data, headers={**self._headers(), "Content-Type": content_type},
                                 timeout=self.timeout)
        except Exception as exc:
            raise self._fail(f"the upload of {key}", exc) from None
        if _status_code(resp) not in (200, 201):
            raise self._fail(f"the upload of {key}", resp=resp)


def r2_from_env(bucket: str | None = None) -> R2Rest | None:
    """The bucket through the run's token, when CLOUDFLARE_API_TOKEN and
    CLOUDFLARE_ACCOUNT_ID are in the environment (always in the workflow);
    None otherwise. The bucket is BUCKET from the environment, else the site's."""
    import os

    import requests

    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    account = (os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    if not token or not account:
        return None
    return R2Rest(requests.Session(), account, token, bucket or (os.environ.get("BUCKET") or "").strip() or DATA_BUCKET)


# -- nightly and monthly checks -----------------------------------------------

EXPIRY_WARN_DAYS = 30
CHECK_TIMEOUT_S = 30.0


def checks_due(today: date) -> bool:
    """The first run of a month is the one on its first day (UTC): the midnight
    run, or a retry the same day when that one did not finish."""
    return today.day == 1


def _days_left(when: datetime, now: datetime) -> int:
    return int((when - now).total_seconds() // 86_400)


def verify_token(http: Any, token: str, account: str | None, now: datetime, label: str) -> dict[str, Any]:
    """The token's own status and expiry. A user token answers at
    /user/tokens/verify and an account-owned one at the account's address, so
    both are tried. Any answer other than a readable result is "unknown":
    a token the API rejects outright already fails the steps that use it."""
    urls = [f"{API}/user/tokens/verify"]
    if account:
        urls.append(f"{API}/accounts/{quote(account, safe='')}/tokens/verify")
    notes: list[str] = []
    for url in urls:
        try:
            resp = http.get(url, headers={"Authorization": f"Bearer {token}", "User-Agent": config.USER_AGENT},
                            timeout=CHECK_TIMEOUT_S)
        except Exception as exc:
            notes.append(f"request failed ({type(exc).__name__})")
            continue
        status = _status_code(resp)
        try:
            payload = resp.json()
        except Exception:
            payload = None
        result = payload.get("result") if isinstance(payload, dict) else None
        if status == 200 and isinstance(result, dict) and isinstance(result.get("status"), str):
            return _token_state(result, now, label)
        notes.append(f"HTTP {status}{_api_errors(resp)}")
    return {"state": "unknown", "detail": _scrub("; ".join(notes), token, account)[:200]}


def _token_state(result: dict[str, Any], now: datetime, label: str) -> dict[str, Any]:
    token_status = result["status"]
    expires = _parse_iso(result.get("expires_on"))
    out: dict[str, Any] = {"status": token_status, "expires_on": expires.isoformat(timespec="seconds") if expires else None}
    if expires:
        out["days_left"] = _days_left(expires, now)
    if token_status != "active":
        out["state"] = "inactive"
        out["item"] = f"The {label} is {token_status}, not active"
    elif expires and expires - now < timedelta(days=EXPIRY_WARN_DAYS):
        out["state"] = "expiring"
        out["item"] = (f"The {label} expires {expires.date()} ({max(out['days_left'], 0)} days): "
                       f"make a new one and replace the secret")
    else:
        out["state"] = "ok"
    return out


def domain_record(http: Any, token: str, account: str, domain: str, now: datetime) -> dict[str, Any]:
    """The registrar's expiry date and auto-renew flag. A token without the
    Registrar read permission gets 403: "unknown", nothing more."""
    if not account or not domain:
        return {"state": "unknown", "detail": "no account or domain configured"}
    url = f"{API}/accounts/{quote(account, safe='')}/registrar/domains/{quote(domain, safe='')}"
    try:
        resp = http.get(url, headers={"Authorization": f"Bearer {token}", "User-Agent": config.USER_AGENT},
                        timeout=CHECK_TIMEOUT_S)
    except Exception as exc:
        return {"state": "unknown", "detail": f"request failed ({type(exc).__name__})"}
    status = _status_code(resp)
    try:
        payload = resp.json()
    except Exception:
        payload = None
    result = payload.get("result") if isinstance(payload, dict) else None
    if status in (401, 403) or 10000 in _api_codes(resp):
        return {"state": "unknown", "detail": f"HTTP {status}: the token lacks the permission to read the registrar"}
    if status != 200 or not isinstance(result, dict):
        return {"state": "unknown", "detail": _scrub(f"HTTP {status}{_api_errors(resp)}", token, account)[:200]}
    expires = _parse_iso(result.get("expires_at"))
    auto = result.get("auto_renew")
    out: dict[str, Any] = {"expires_at": expires.isoformat(timespec="seconds") if expires else None,
                           "auto_renew": auto if isinstance(auto, bool) else None}
    if expires is None:
        out.update(state="unknown", detail="the registrar record has no expiry date")
        return out
    out["days_left"] = _days_left(expires, now)
    if expires - now < timedelta(days=EXPIRY_WARN_DAYS):
        renew = {True: "on", False: "off"}.get(out["auto_renew"], "unknown")
        out.update(state="expiring",
                   item=f"The domain {domain} expires {expires.date()} ({max(out['days_left'], 0)} days); auto-renew is {renew}")
    else:
        out["state"] = "ok"
    return out


def domain_of(site_url: str) -> str:
    host = urlsplit(site_url or "").hostname or ""
    return "" if not host or host.endswith(".example") else host


# Cloudflare rewrites an HTML page on its way to a browser-like request when
# a zone feature injects into it. Web Analytics' automatic setup did, and the
# rewrite dropped the ETag the Worker sets (site/src/conditional.ts), so
# crawlers got no 304s. The beacon now sits in the page template and the Web
# Analytics site is on the manual snippet setting; a switch back, or Email
# Obfuscation, Automatic HTTPS Rewrites or Replace insecure JavaScript turned
# on, shows here as a home page without its ETag or with a second beacon. The
# request looks like a browser's (an Accept naming text/html), because the
# edge rewrites only those.
HTML_CHECK_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
HTML_CHECK_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/130.0.0.0 Safari/537.36")
BEACON_MARK = "data-cf-beacon"
REWRITE_ITEM_START = "Cloudflare is rewriting the site's HTML again"


def check_html_rewrite(http: Any, site_url: str, now: datetime) -> dict[str, Any]:
    """The home page as a browser receives it. "ok": 200 with an ETag and
    exactly one Web Analytics beacon. "rewritten", with an item: the ETag is
    gone or the beacon appears more than once. "unknown", no item: any other
    answer, a challenge, or no answer (an unreachable site is the smoke test's
    to report). Never raises."""
    host = domain_of(site_url)
    if not host:
        return {"state": "unknown", "detail": "no site address configured"}
    out: dict[str, Any] = {"checked_at": now.isoformat(timespec="seconds")}
    url = site_url.rstrip("/") + "/"
    try:
        resp = http.get(url, headers={"Accept": HTML_CHECK_ACCEPT, "User-Agent": HTML_CHECK_AGENT,
                                      "Accept-Encoding": "gzip"}, timeout=CHECK_TIMEOUT_S)
    except Exception as exc:
        out.update(state="unknown", detail=f"request failed ({type(exc).__name__})")
        return out
    status = _status_code(resp)
    try:
        headers = {str(k).lower(): str(v) for k, v in (getattr(resp, "headers", None) or {}).items()}
    except Exception:
        headers = {}
    try:
        body = str(resp.text)[:MAX_BODY]
    except Exception:
        body = ""
    out.update(status=status, etag="etag" in headers, beacons=body.count(BEACON_MARK),
               content_encoding=headers.get("content-encoding"))
    if status != 200:
        out.update(state="unknown", detail=f"HTTP {status}")
        return out
    if _challenge(resp, body):
        out.update(state="unknown", detail="the edge answered with a challenge")
        return out
    wrong = []
    if not out["etag"]:
        wrong.append("no ETag")
    if out["beacons"] > 1:
        wrong.append(f"{out['beacons']} beacons")
    if wrong:
        out.update(state="rewritten", item=(
            f"{REWRITE_ITEM_START} (home page for a browser-like request: {' and '.join(wrong)}). "
            f"In the dashboard, Web Analytics, {host}, Manage site must be 'Enable with JS Snippet installation', "
            f"and Email Obfuscation, Automatic HTTPS Rewrites and Replace insecure JavaScript must be off."))
    elif out["beacons"] == 0:
        # Not the edge: the template lost its beacon. The site's tests catch that.
        out.update(state="unknown", detail="200 with an ETag but no beacon in the page")
    else:
        out["state"] = "ok"
    return out


def run_checks(today: date, env: Mapping[str, str], http: Any, *, domain: str, site_url: str = "",
               now: datetime | None = None) -> dict[str, Any]:
    """Tonight's checks: the HTML check every night and, on the first of a
    month (monthly: true), the expiry checks of the two tokens and the
    domain. Never raises."""
    current = now or datetime.now(timezone.utc)
    monthly = checks_due(today)
    out: dict[str, Any] = {"due": True, "monthly": monthly, "date": today.isoformat()}
    jobs: list[tuple[str, Callable[[], dict[str, Any]]]] = [
        ("html_rewrite", lambda: check_html_rewrite(http, site_url, current)),
    ]
    if monthly:
        deploy = (env.get("CLOUDFLARE_API_TOKEN") or "").strip()
        analytics = (env.get("CLOUDFLARE_ANALYTICS_TOKEN") or "").strip()
        account = (env.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
        jobs += [
            ("deploy_token", lambda: verify_token(http, deploy, account, current, "deploy token (CLOUDFLARE_API_TOKEN)")
             if deploy else {"state": "not set"}),
            ("analytics_token", lambda: verify_token(http, analytics, account, current,
                                                     "analytics token (CLOUDFLARE_ANALYTICS_TOKEN)")
             if analytics else {"state": "not set"}),
            ("domain", lambda: domain_record(http, deploy, account, domain, current) if deploy
             else {"state": "unknown", "detail": "no token"}),
        ]
    for name, job in jobs:
        try:
            out[name] = job()
        except Exception as exc:
            out[name] = {"state": "unknown", "detail": f"the check failed ({type(exc).__name__})"}
    out["items"] = [out[name].pop("item") for name, _ in jobs if "item" in out[name]]
    return out


# -- attention items and the issue --------------------------------------------

ISSUE_TITLE = "Nightly run needs attention"
ISSUE_LABEL = "run-attention"


def attention_items(status: Any) -> list[str]:
    """What the run's last step lists. An empty list means a clean run."""
    if not isinstance(status, dict):
        return ["no run status was written"]
    items = [f"{x.get('source')}: {x.get('detail', '')}" for x in status.get("stages") or []
             if isinstance(x, dict) and not x.get("ok")]
    if status.get("x_post") in ("failed", "no credentials"):
        items.append(f"X post: {status['x_post']}")
    elif status.get("x_post") == "unverified":
        # Recorded as posted so no run repeats it, but X never confirmed it.
        items.append("X post: unverified after an error from X; check the account")
    if status.get("bluesky_post") in ("failed", "no credentials"):
        items.append(f"Bluesky post: {status['bluesky_post']}")
    if status.get("zenodo_deposit") == "failed":
        items.append("Zenodo deposit: failed (tried again next run)")
    if status.get("search_sync") == "failed":
        items.append("Search database sync: failed (sent again next run)")
    if status.get("views_rollup") == "failed":
        items.append("Audience roll-up: failed (caught up next run)")
    if status.get("search_console") == "failed":
        items.append("Search Console import: failed (caught up next run)")
    if status.get("views_report") == "failed":
        items.append("Monthly audience report: failed (tried again next run)")
    # Only a rejection: the key file or the payload is wrong and stays wrong
    # until fixed. A rate limit or a failed request clears by itself, and the
    # sitemap still carries every page meanwhile.
    indexnow_outcome = status.get("indexnow")
    if isinstance(indexnow_outcome, str) and indexnow_outcome.startswith("rejected"):
        items.append("IndexNow: rejected; check the key file")
    if status.get("smoke") == "broken":
        detail = status.get("smoke_detail") or "server errors"
        if status.get("deploy_rolled_back") is True:
            items.append(f"Deploy rolled back: the site answered with server errors after the deploy ({detail}); "
                         f"the Worker is back on version {status.get('version_before') or 'unknown'}, "
                         f"with the previous data, and a later run tries again")
        else:
            items.append(f"Deploy broken: the site answered with server errors after the deploy ({detail}) "
                         f"and was not rolled back ({status.get('rollback') or 'not run'})")
    restore = status.get("restore")
    if isinstance(restore, dict) and restore.get("source") == "weekly":
        items.append(f"Restored from the weekly snapshot {restore.get('weekly_key')} "
                     f"(uploaded {restore.get('weekly_uploaded')}): both nightly backups were missing or damaged, "
                     f"so the Job Bank observations since that snapshot are lost")
    checks = status.get("checks")
    if isinstance(checks, dict):
        # The HTML check's item names itself; the others come from the monthly expiry checks.
        items.extend(i if i.startswith(REWRITE_ITEM_START) else f"Expiry check: {i}"
                     for i in checks.get("items") or [] if isinstance(i, str))
    # A designated-employer list loaded by hand whose publisher has a newer
    # edition: someone has to load it by hand, so it is an item, not a notice.
    registers = status.get("registers")
    attention = registers.get("attention") if isinstance(registers, dict) else None
    if isinstance(attention, list):
        items.extend(i for i in attention if isinstance(i, str) and i)
    # The run's notices (notice_items) are not here: they never fail the step
    # or open the issue.
    return items


def notice_items(status: Any) -> list[str]:
    """The run's notices, one line each: a government notice first listed, IRCC's
    high-wage list adopted or unreadable, a designated-employer list or a news
    feed that changed state. Information, never an item needing attention: they
    go to LAST_RUN.md and the daily check's email, and the run stays ok."""
    if not isinstance(status, dict):
        return []
    return [f"{n.get('source') or 'notice'}: {n['detail']}" for n in status.get("notices") or []
            if isinstance(n, dict) and isinstance(n.get("detail"), str) and n["detail"]]


def issue_texts(items: list[str], run_url: str, day: str) -> dict[str, str]:
    """The issue body, the comment for a later run, and the closing comment."""
    numbered = "\n".join(f"{n}. {item}" for n, item in enumerate(items, 1))
    body = (f"The nightly run of {day} found {len(items)} item{'s' if len(items) != 1 else ''} needing attention:\n\n"
            f"{numbered}\n\nRun: {run_url}\n\n"
            "Each run updates this issue while an item remains, and the first run with none closes it.\n")
    comment = f"The run of {day} still finds:\n\n{numbered}\n\nRun: {run_url}\n"
    close = f"The run of {day} finished with nothing needing attention: {run_url}\n"
    return {"title": ISSUE_TITLE, "body": body, "comment": comment, "close": close}
