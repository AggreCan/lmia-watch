"""Paths, hosts and identifiers shared by every stage."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

from . import __version__

# pipeline/lmia_pipeline/config.py -> repo root is two levels up from the package
REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
CACHE_DIR = RAW_DIR / "cache"
OUT_DIR = DATA_DIR / "out"
DEFAULT_DB = DATA_DIR / "lmia.sqlite"
SCHEMA_PATH = REPO_ROOT / "pipeline" / "schema.sql"
# The hosted search database (D1 lmia-watch-search) has its own schema; see search_db.py.
SEARCH_SCHEMA_PATH = REPO_ROOT / "pipeline" / "search_schema.sql"
PACKAGE_DATA = Path(__file__).resolve().parent / "data"

# The contact in the user agent is a URL (the site's corrections form), so the
# project needs no mailbox; set both from the workflow's variables.
SITE_URL = os.environ.get("LMIAWATCH_SITE_URL", "https://lmiawatch.example")
CONTACT = os.environ.get("LMIAWATCH_CONTACT", f"{SITE_URL}/corrections")
USER_AGENT = f"LMIAWatch/{__version__} (+{SITE_URL}; {CONTACT})"

# The zone's WAF challenges every request it cannot vouch for, the run's own
# checks of the live site included, unless the request carries this header
# with the key the first rule names (pipeline/scripts/edge_rules.py,
# CHECK_HEADER, kept equal by a test). The key is the repository secret
# EDGE_CHECK_KEY. Anyone holding it skips the challenge, so it goes to the
# site's own host over HTTPS and nowhere else, and is never logged.
EDGE_CHECK_HEADER = "x-lmiawatch-check"
EDGE_CHECK_ENV = "EDGE_CHECK_KEY"
EDGE_CHECK_KEY_RE = re.compile(r"[0-9a-f]{64}")


def edge_check_key(env: Mapping[str, str] | None = None) -> str | None:
    """The check key, or None when it is not set or is not 64 lower-case hex
    characters (a malformed secret is never sent)."""
    raw = ((os.environ if env is None else env).get(EDGE_CHECK_ENV) or "").strip()
    return raw if EDGE_CHECK_KEY_RE.fullmatch(raw) else None


def edge_check_headers(url: str, site_url: str | None = None, env: Mapping[str, str] | None = None) -> dict[str, str]:
    """{EDGE_CHECK_HEADER: key} for an https URL on the site's host (that of
    site_url, else SITE_URL, or www. of it) when the key is set; {} for any
    other URL, so a request to another host never carries it."""
    key = edge_check_key(env)
    if key is None:
        return {}
    try:
        site = (urlsplit(site_url or SITE_URL).hostname or "").lower()
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except (TypeError, ValueError):
        return {}
    if not site or parts.scheme != "https" or host not in (site, f"www.{site}"):
        return {}
    return {EDGE_CHECK_HEADER: key}

# robots.txt on jobbank.gc.ca sets Crawl-delay: 5. Everything else gets one
# request per second, which is well under what the open-data hosts expect.
# Job Bank's robots.txt asks for 5 seconds between requests. The crawler waits
# 8: from a cloud runner the site's firewall stopped answering partway through
# a sweep at the published pace (2026-10-20), and a slower one asks less of it.
CRAWL_DELAY: dict[str, float] = {"www.jobbank.gc.ca": 8.0, "jobbank.gc.ca": 8.0}
# Hosts where a refused or timed-out connection means the host has stopped
# taking requests from this address: each request is tried twice, and this
# many requests in a row failing that way end the run for the host (AbortRun)
# instead of retrying for twenty minutes.
CONNECT_FAIL_FAST: dict[str, int] = {"www.jobbank.gc.ca": 2, "jobbank.gc.ca": 2}
DEFAULT_DELAY = 1.0

JOBBANK_BASE = "https://www.jobbank.gc.ca"
CKAN_PACKAGE_SHOW = "https://open.canada.ca/data/api/action/package_show?id={dataset}"
ESDC_DATASETS = {
    "positive": "90fed587-1364-4f33-a9ee-208181dc0b97",
    "negative": "f82f66f2-a22b-4511-bccf-e1d74db39ae5",
}
IRCC_NONCOMPLIANT_URL = (
    "https://www.canada.ca/en/immigration-refugees-citizenship/services/"
    "work-canada/employers-non-compliant.html"
)
ORGBOOK_SEARCH = "https://orgbook.gov.bc.ca/api/v4/search/topic"
