"""The zone's WAF custom rules, kept as code and applied through Cloudflare's API.

Why: in November 2026 about 99 percent of the page requests Cloudflare could
not verify came from scrapers (an SEO backlink crawler, two crawlers gathering
pages for AI training, a headless browser, and a fleet of rented addresses
with rotating browser agent strings), some 400,000 pages a week against about
2,600 page loads by people. The data they take is in the bulk files under
/downloads/, which stay open to anyone. These rules run at Cloudflare's edge,
before the Worker, so a refused request costs the site nothing.

Who gets through, in rule order (the Free plan allows five custom rules):

1. check_key (skip). The project's own runs (the nightly's smoke test and
   checks, the site deploy) send a header carrying a key; this rule lets them
   past the rules below. The key is the repository secret EDGE_CHECK_KEY and
   is never in the repository.
2. refused (block). Crawlers the site refuses by name, verified or not: the
   robots.txt group for AI training and large-scale scraping, on every path
   but /robots.txt, which they must be able to read. And, when Cloudflare has
   not verified the sender, scripting tools and self-declared headless
   browsers on everything but the open paths.
3. welcome (skip). Crawlers Cloudflare has verified in the categories the
   site wants (search engines, AI search and assistants, page previews,
   archivers, feed fetchers, monitors); the open paths (the downloads, the
   feeds, robots.txt, llms.txt, the sitemaps, the payment webhook, the
   stylesheet, scripts, fonts and images); and link-preview fetchers that run
   on a person's own device or server and so cannot be verified (WhatsApp,
   iMessage, Mastodon and the like), on pages only, which the Worker answers
   with the page's head (site/src/limits.ts), so the name is worth nothing to
   a scraper; the data files and the API stay behind the check for them.
4. challenge (managed challenge). Everyone else: a browser passes Cloudflare's
   check, usually without a click, and keeps a clearance cookie; a script or
   a crawler nobody vouches for does not get the page.

The lists are in site/src/edge_agents.json, which the Worker also reads.

Usage, from the repository root, with a token that may edit the zone's WAF:

    python pipeline/scripts/edge_rules.py --token-file <path> --key-file <path> --dry-run
    python pipeline/scripts/edge_rules.py --token-file <path> --key-file <path> --apply
    python pipeline/scripts/edge_rules.py --token-file <path> --key-file <path> --check

--check exits 1 when the rules on the zone differ from these. --apply replaces
the zone's custom rules with these four, so a rule added by hand in the
dashboard must be added here or it is removed. The token and the key are read
from the files (or from CLOUDFLARE_WAF_TOKEN and EDGE_CHECK_KEY) and never
printed. docs/traffic-limits.md describes the rules for the operator.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

API = "https://api.cloudflare.com/client/v4"
PHASE = "http_request_firewall_custom"
ZONE_NAME = "lmiawatch.ca"
# The header the project's own runs send (lmia_pipeline.config.EDGE_CHECK_HEADER).
CHECK_HEADER = "x-lmiawatch-check"
KEY_RE = re.compile(r"^[0-9a-f]{64}$")
# The Worker's page cache reads and writes the Cache API under this host
# (site/src/pagecache.ts). Those operations are the Worker's own and must
# never be refused or challenged.
CACHE_HOST = "pages.lmiawatch.invalid"
# Cloudflare's limit for one rule's expression.
MAX_EXPRESSION = 4096

AGENTS_FILE = Path(__file__).resolve().parents[2] / "site" / "src" / "edge_agents.json"

PATH = "http.request.uri.path"
UA = "lower(http.user_agent)"

# Paths open to any client: the bulk files and the feeds (the channel the site
# offers to machines), the payment webhook (verified by the Worker), files
# Cloudflare or a standard asks for, and the files a page is drawn with, which
# hold no records. The extensions cover robots.txt, llms.txt, the IndexNow key
# file and the sitemaps. The records are in the pages, /data/*.json and /api/.
OPEN_PREFIXES = ("/downloads/", "/data/feeds/", "/fonts/", "/hooks/", "/.well-known/", "/cdn-cgi/")
OPEN_EXTENSIONS = ("txt", "xml", "css", "js", "png", "svg", "ico", "woff2", "webmanifest", "jpg", "jpeg", "webp", "gif")
# What a link-preview name never opens (rule welcome): the data files and the
# JSON API. The feeds under /data/feeds/ are open to any client through
# OPEN_PREFIXES, whatever its name.
PREVIEW_CLOSED_PREFIXES = ("/data/", "/api/")


def load_agents(path: Path = AGENTS_FILE) -> dict[str, list[str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, list[str]] = {}
    for name in ("refused", "tools", "preview", "verified_categories"):
        values = data.get(name)
        if not isinstance(values, list) or not values or not all(isinstance(v, str) and v for v in values):
            raise ValueError(f"{path.name}: {name} must be a list of names")
        out[name] = values
    for name in ("refused", "tools", "preview"):
        for value in out[name]:
            # Matched against the lowered agent string, inside a quoted literal.
            if value != value.lower() or '"' in value or "\\" in value:
                raise ValueError(f"{path.name}: {name} entry {value!r} must be lower case without quotes")
    return out


def _quoted(values: tuple[str, ...] | list[str]) -> str:
    return " ".join(f'"{v}"' for v in values)


def _any_agent(names: list[str]) -> str:
    return "(" + " or ".join(f'{UA} contains "{n}"' for n in names) + ")"


def open_paths() -> str:
    prefixes = " or ".join(f'starts_with({PATH}, "{p}")' for p in OPEN_PREFIXES)
    return f"({prefixes} or {PATH}.extension in {{{_quoted(OPEN_EXTENSIONS)}}})"


def build_rules(agents: dict[str, list[str]], key: str, *, challenge: bool = True) -> list[dict[str, Any]]:
    """The rules in order. challenge=False leaves the last rule out (the first
    stage of a rollout: the refusals without the check for everyone else)."""
    # fullmatch: with match, "$" also matches before a final line break, which
    # would then sit inside the rule's quoted literal.
    if not KEY_RE.fullmatch(key):
        raise ValueError("the check key must be 64 lower-case hex characters")
    not_cache = f'http.host ne "{CACHE_HOST}"'
    refused = f'({_any_agent(agents["refused"])} and {PATH} ne "/robots.txt")'
    tools = (f'(not cf.client.bot and ({_any_agent(agents["tools"])} or http.user_agent eq "") '
             f"and not {open_paths()})")
    verified = f'(cf.client.bot and cf.verified_bot_category in {{{_quoted(agents["verified_categories"])}}})'
    # Pages only: the Worker answers these names with a page's head, but the
    # files under /data/ are served before the Worker runs and /api/ answers
    # with data, so under either a preview name would be a way to the records.
    closed = " and ".join(f'not starts_with({PATH}, "{p}")' for p in PREVIEW_CLOSED_PREFIXES)
    preview = (f'(http.request.method in {{"GET" "HEAD"}} and not cf.client.bot and {closed} '
               f'and {_any_agent(agents["preview"])})')
    skip = {"action": "skip", "action_parameters": {"ruleset": "current"}, "logging": {"enabled": True}}
    rules: list[dict[str, Any]] = [
        {"ref": "check_key", "description": "The project's own runs (check key)", **skip,
         "expression": f'(any(http.request.headers["{CHECK_HEADER}"][*] eq "{key}"))'},
        {"ref": "refused", "description": "Refused crawlers by name; scripting tools on pages", "action": "block",
         "expression": f"({not_cache} and ({refused} or {tools}))"},
        {"ref": "welcome", "description": "Verified crawlers, open paths, link previews", **skip,
         "expression": f'(http.host eq "{CACHE_HOST}" or {verified} or {open_paths()} or {preview})'},
    ]
    if challenge:
        rules.append({"ref": "challenge", "description": "Everyone else: managed challenge",
                      "action": "managed_challenge", "expression": f"({not_cache})"})
    for rule in rules:
        rule["enabled"] = True
        if len(rule["expression"]) > MAX_EXPRESSION:
            raise ValueError(f"rule {rule['ref']}: expression is {len(rule['expression'])} characters, over {MAX_EXPRESSION}")
    return rules


def redact(text: str, *secrets: str) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "<redacted>")
    return text


def _comparable(rule: dict[str, Any]) -> dict[str, Any]:
    return {"ref": rule.get("ref"), "action": rule.get("action"), "expression": rule.get("expression"),
            "enabled": rule.get("enabled", True),
            "action_parameters": rule.get("action_parameters") or {}}


def differences(wanted: list[dict[str, Any]], live: list[dict[str, Any]]) -> list[str]:
    """What differs between the rules wanted and the rules on the zone, in words (no expression text)."""
    out: list[str] = []
    if [r.get("ref") for r in live] != [r["ref"] for r in wanted]:
        out.append(f"the zone has rules {[r.get('ref') for r in live]}, wanted {[r['ref'] for r in wanted]}")
        return out
    for want, have in zip(wanted, live):
        a, b = _comparable(want), _comparable(have)
        for field in ("action", "expression", "enabled", "action_parameters"):
            if a[field] != b[field]:
                out.append(f"rule {want['ref']}: {field} differs")
    return out


class Zone:
    def __init__(self, http: Any, token: str, zone_name: str = ZONE_NAME) -> None:
        self.http = http
        self.token = token
        self.zone_name = zone_name
        self._id: str | None = None

    def _call(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = self.http.request(method, f"{API}{path}", headers={"Authorization": f"Bearer {self.token}"},
                                 timeout=60, **kwargs)
        try:
            payload = resp.json()
        except Exception:
            payload = {}
        if resp.status_code >= 400 or not payload.get("success", False):
            errors = "; ".join(str(e.get("message")) for e in payload.get("errors") or [])[:400]
            raise RuntimeError(redact(f"{method} {path}: HTTP {resp.status_code} {errors}", self.token))
        return payload.get("result")

    def zone_id(self) -> str:
        if self._id is None:
            zones = self._call("GET", f"/zones?name={self.zone_name}") or []
            if len(zones) != 1:
                raise RuntimeError(f"the token sees {len(zones)} zones named {self.zone_name}")
            self._id = zones[0]["id"]
        return self._id

    def live_rules(self) -> list[dict[str, Any]]:
        result = self._call("GET", f"/zones/{self.zone_id()}/rulesets/phases/{PHASE}/entrypoint") or {}
        return result.get("rules") or []

    def put_rules(self, rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result = self._call("PUT", f"/zones/{self.zone_id()}/rulesets/phases/{PHASE}/entrypoint",
                            json={"rules": rules}) or {}
        return result.get("rules") or []


def _secret(file_arg: str | None, env_name: str) -> str:
    if file_arg:
        text = Path(file_arg).read_text(encoding="utf-8")
        return (text.strip().splitlines() or [""])[0].strip()
    return (os.environ.get(env_name) or "").strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="The zone's WAF custom rules: show, apply or check them.")
    parser.add_argument("--token-file", help="a file whose first line is a Cloudflare token with Zone WAF Edit (else CLOUDFLARE_WAF_TOKEN)")
    parser.add_argument("--key-file", help="a file whose first line is the check key (else EDGE_CHECK_KEY)")
    parser.add_argument("--zone", default=ZONE_NAME, help="the zone's name")
    parser.add_argument("--without-challenge", action="store_true",
                        help="leave the managed challenge out (the refusals only)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="print the rules, the key redacted")
    mode.add_argument("--apply", action="store_true", help="replace the zone's custom rules with these")
    mode.add_argument("--check", action="store_true", help="exit 1 when the zone's rules differ from these")
    args = parser.parse_args(argv)

    key = _secret(args.key_file, "EDGE_CHECK_KEY")
    try:
        rules = build_rules(load_agents(), key, challenge=not args.without_challenge)
    except ValueError as exc:
        print(f"edge rules: {exc}", file=sys.stderr)
        return 2
    if args.dry_run:
        for rule in rules:
            print(f"{rule['ref']}: {rule['action']} ({len(rule['expression'])} characters)")
            print("   " + redact(rule["expression"], key))
        return 0

    token = _secret(args.token_file, "CLOUDFLARE_WAF_TOKEN")
    if not token:
        print("edge rules: no token (use --token-file or CLOUDFLARE_WAF_TOKEN)", file=sys.stderr)
        return 2
    import requests

    zone = Zone(requests.Session(), token, args.zone)
    try:
        if args.apply:
            before = [r.get("description") or r.get("ref") for r in zone.live_rules()]
            live = zone.put_rules(rules)
            print(f"edge rules: replaced {len(before)} rule(s) {before} with {len(live)}: "
                  f"{[r.get('ref') for r in live]}")
        else:
            live = zone.live_rules()
        problems = differences(rules, live)
    except RuntimeError as exc:
        print(f"edge rules: {redact(str(exc), token, key)}", file=sys.stderr)
        return 1
    if problems:
        print("edge rules: the zone differs from this file: " + "; ".join(problems), file=sys.stderr)
        return 1
    print(f"edge rules: the zone carries these {len(rules)} rules")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
