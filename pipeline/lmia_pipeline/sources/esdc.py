"""ESDC quarterly lists of employers with positive and negative LMIAs.

Resources are discovered through the CKAN API so a new quarter loads itself.
File shapes changed over the years: CSV with varying headers up to 2020 Q3,
XLSX with a title row and footnotes from 2020 Q4 on. Headers are matched by
keyword rather than exact text, and the file type comes from the URL because
the CKAN format field is wrong on some rows. The 2016 to 2019 Q2 files print a
group's shared cells once (see read_records).

Reading the portal: each night the stage asks CKAN for both listings and
fetches each English file (a cached copy serves for a week, then is
revalidated). A listing or file that times out, cannot connect or answers
5xx or 429, and a listing that is not the expected JSON (a maintenance page
served with HTTP 200), is portal trouble. So is the client's circuit breaker
tripping (AbortRun, once several requests in a row have failed, here or in
reload_outdated): the stage then sends no further ESDC request that night,
counts the trouble against the list it was reading, and leaves a list it
never reached as it was ("not read" in the detail line, no count change and
no notice of its own). ESDC publishes a new quarter a few times a year, so a
night without the listing changes nothing and the quarters already loaded
stand: portal trouble is a notice, and the stage stays ok, until a list has
had it on PORTAL_MISS_NIGHTS nights in a row, when it becomes a failed
stage, since a portal that stays unreadable needs someone. Nights are
counted per list in meta, once per UTC date (a retry the same day adds
none), and a night without portal trouble for the list sets its count back
to 0. A refusal (404, 403, 400), a listing with no English resources and a
file that does not parse fail the stage the first night, as before.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import re
import sqlite3
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator, Mapping

import openpyxl

from .. import config
from ..db import get_meta, log_run, now_iso, set_meta, upsert_employer
from ..household import is_household_row, remove_household_rows
from ..http import AbortRun, FetchError, PoliteClient
from ..normalize import (
    NORMALIZE_VERSION, iso_date, norm_name, parse_address, parse_noc, period_from_text, province_code, to_int,
)

log = logging.getLogger(__name__)

# Recorded per resource in esdc_resources.parser_version. Bump it when a parser
# change alters what is read from a file already loaded: the esdc stage then
# parses every resource recorded under an older version again, once
# (reload_outdated). 0: loaded before versions were recorded. 1: continuation
# rows, the stream and province carried down their blocks, and data rows no
# longer taken for headers.
PARSER_VERSION = 1

# Portal trouble (see the module docstring) on this many nights in a row for
# one list turns from a notice into a failed stage.
PORTAL_MISS_NIGHTS = 3
# The run status splits a log row's notice into one notice per part (nightly._notices).
NOTICE_SEP = " | "

# Order matters: a header such as "Approved LMIA Positions" must land on
# positions, so positions is tested before lmias.
HEADER_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("province", ("province", "territor")),
    ("stream", ("stream",)),
    ("employer", ("employer", "employeur")),
    ("address", ("address", "adresse")),
    ("occupation", ("occupation", "noc", "cnp", "profession")),
    ("incorporate", ("incorporat",)),
    ("positions", ("position", "poste")),
    ("lmias", ("lmia", "eimt")),
]


def map_headers(headers: list[object]) -> dict[str, int]:
    out: dict[str, int] = {}
    for idx, raw in enumerate(headers):
        if raw is None:
            continue
        key = str(raw).strip().lower()
        if not key:
            continue
        for field, words in HEADER_KEYWORDS:
            if field in out:
                continue
            if any(w in key for w in words):
                out[field] = idx
                break
    return out


def is_header_row(row: list[object]) -> bool:
    fields = map_headers(row)
    if "employer" not in fields or ("occupation" not in fields and "positions" not in fields):
        return False
    # A data row can match the keywords as well: "Employers carrying on
    # business in Canada with Head Office outside of Canada" beside "Other
    # trades and related occupations" took 473 rows for headers. A header
    # never holds a count.
    return not any(to_int(v) is not None for v in row if v not in (None, ""))


def _rows_from_iter(rows: list[list[object]]) -> tuple[list[object], list[list[object]]]:
    for i, row in enumerate(rows):
        if is_header_row(row):
            data = [r for r in rows[i + 1:] if any(v not in (None, "") for v in r)]
            return list(row), data
    raise ValueError("no header row found")


def parse_xlsx(data: bytes) -> tuple[list[object], list[list[object]]]:
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    return _rows_from_iter(rows)


def decode_csv_bytes(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def parse_csv(data: bytes) -> tuple[list[object], list[list[object]]]:
    text = decode_csv_bytes(data)
    # Some files end lines with \r\r\n; collapse every variant to \n first.
    text = text.replace("\r\r\n", "\n").replace("\r\n", "\n").replace("\r", "\n")
    rows = [list(r) for r in csv.reader(io.StringIO(text))]
    return _rows_from_iter(rows)


def parse_resource(data: bytes, ext: str) -> tuple[list[object], list[list[object]]]:
    if ext in ("xlsx", "xls", "xlsm"):
        try:
            return parse_xlsx(data)
        except Exception as exc:  # some .xls URLs serve CSV text
            if data[:2] == b"PK":
                raise
            log.info("falling back to csv parser: %s", exc)
    return parse_csv(data)


def normalize_row(fields: dict[str, int], row: list[object]) -> dict | None:
    def get(key: str) -> str | None:
        idx = fields.get(key)
        if idx is None or idx >= len(row):
            return None
        value = row[idx]
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    employer = get("employer")
    if not employer:
        return None
    province_raw = get("province")
    address = get("address")
    city, prov_from_addr, postal = parse_address(address)
    province = province_code(province_raw) or prov_from_addr
    noc_code, noc_title = parse_noc(get("occupation"))
    return {
        "employer_raw": employer,
        "province": province,
        "province_raw": province_raw,
        "stream": get("stream"),
        "address_raw": address,
        "city": city,
        "postal_code": postal,
        "noc_code": noc_code,
        "noc_title": noc_title,
        "incorporate_status": get("incorporate"),
        "lmias": to_int(get("lmias")),
        "positions": to_int(get("positions")),
    }


# Names of lines that sum up or annotate a list, compared with the whole name
# after case folding and trimming of punctuation. The 2014 positive file ends
# with "Other employers" and "Total"; the 2014 and 2015 files end with "Notes:".
SUMMARY_NAME_RE = re.compile(
    r"(?:grand |sub-?)?totals?|total général|(?:all )?other employers?|autres employeurs|notes?|remarques?"
)


def _summary_name(name: str) -> bool:
    key = re.sub(r"\s+", " ", name).strip(" .:;*").casefold()
    return SUMMARY_NAME_RE.fullmatch(key) is not None


def is_summary_row(rec: Mapping) -> bool:
    """True for a parsed row that describes the list rather than an employer.

    Every employer row carries an occupation or a place, and a count. A row
    with no occupation is a summary when it also has no address and either
    no count (a footnote such as "1. This list excludes...") or a summary
    name ("Total", "Other employers"); or when its name is a province, it
    has no count and any address is the same province (the 2015 negative
    file repeats a heading as "Alberta,Alberta,"). Loading such rows as
    employers put 36,363 positions under "Total" and "Other employers" in
    2014. Takes a normalize_row() dict or an esdc_records row.
    """
    if rec["noc_code"] or rec["noc_title"]:
        return False
    name = rec["employer_raw"] or ""
    address = rec["address_raw"]
    no_count = rec["positions"] is None and rec["lmias"] is None
    heading = province_code(name)
    if heading and no_count and (not address or province_code(address) == heading):
        return True
    if address:
        return False
    return no_count or _summary_name(name)


def remove_summary_rows(conn: sqlite3.Connection) -> dict[str, int]:
    """Delete summary and footnote rows an earlier parser loaded as employers.

    Idempotent: the esdc stage runs it every night, and once the rows are gone
    it finds nothing. Employers left with no list row, posting or finding are
    deleted with their names, registry matches and indicators; the loaded-row
    count of each touched resource is recounted. status.recompute, which runs
    after the sources, recounts everything else.
    """
    candidates = conn.execute(
        "SELECT id, employer_id, resource_id, employer_raw, address_raw, noc_code, noc_title, positions, lmias "
        "FROM esdc_records WHERE noc_code IS NULL AND noc_title IS NULL "
        "AND (address_raw IS NULL OR (positions IS NULL AND lmias IS NULL))"
    ).fetchall()
    doomed = [r for r in candidates if is_summary_row(r)]
    if not doomed:
        return {"rows": 0, "employers": 0}
    conn.executemany("DELETE FROM esdc_records WHERE id = ?", [(r["id"],) for r in doomed])
    for rid in sorted({r["resource_id"] for r in doomed}):
        conn.execute(
            "UPDATE esdc_resources SET rows_loaded = (SELECT COUNT(*) FROM esdc_records WHERE resource_id = ?) "
            "WHERE resource_id = ?",
            (rid, rid),
        )
    dropped = drop_orphans(conn, {r["employer_id"] for r in doomed})
    conn.commit()
    return {"rows": len(doomed), "employers": dropped}


def drop_orphans(conn: sqlite3.Connection, employer_ids: Iterable[str]) -> int:
    """Delete the employers among these left with no list row, posting or finding.

    Their names, registry matches, registry checks and indicators go with
    them. Does not commit. Returns the number deleted.
    """
    orphans = [
        (eid,) for eid in sorted(set(employer_ids))
        if not conn.execute(
            "SELECT 1 FROM esdc_records WHERE employer_id = ? UNION ALL SELECT 1 FROM jobbank_postings WHERE employer_id = ? "
            "UNION ALL SELECT 1 FROM findings WHERE employer_id = ? LIMIT 1",
            (eid, eid, eid),
        ).fetchone()
    ]
    for table in ("employer_names", "registry_matches", "registry_checks", "indicators"):
        conn.executemany(f"DELETE FROM {table} WHERE employer_id = ?", orphans)
    conn.executemany("DELETE FROM employers WHERE id = ?", orphans)
    return len(orphans)


def record_aliases(conn: sqlite3.Connection, moved: Mapping[str, Counter], stamp: str) -> int:
    """Send each employer id a reload retired on to the id that took its rows.

    moved maps an old employer id to the new ids its rows were filed under,
    with the number of rows each took. An old id that still exists (it keeps
    a row elsewhere) is not retired and gets nothing. Otherwise it points at
    the new id that took most of its rows, the lowest id on a tie, as
    migrate.py does for a normalization change; export_static follows any
    chain to the live id. Does not commit. Returns the aliases written.
    """
    rows = []
    for old, sent in sorted(moved.items()):
        if not sent or conn.execute("SELECT 1 FROM employers WHERE id = ?", (old,)).fetchone():
            continue
        new = max(sorted(sent), key=lambda n: sent[n])
        rows.append((old, new, NORMALIZE_VERSION, stamp))
    conn.executemany(
        "INSERT OR REPLACE INTO employer_aliases (old_id, new_id, normalize_version, created_at) VALUES (?, ?, ?, ?)",
        rows,
    )
    return len(rows)


def row_hash(list_name: str, resource_id: str, row: list[object]) -> str:
    payload = json.dumps(["" if v is None else str(v) for v in row], ensure_ascii=False)
    return hashlib.sha1(f"{list_name}|{resource_id}|{payload}".encode("utf-8")).hexdigest()


def _cell(fields: dict[str, int], row: list[object], key: str) -> str | None:
    idx = fields.get(key)
    if idx is None or idx >= len(row) or row[idx] is None:
        return None
    return str(row[idx]).strip() or None


def _filled(fields: dict[str, int], row: list[object], cells: dict[str, str | None]) -> list[object]:
    """A copy of row with the given cells written in, padded when the row is short."""
    out = list(row)
    for key, value in cells.items():
        idx = fields.get(key)
        if idx is None or value is None:
            continue
        if idx >= len(out):
            out.extend([None] * (idx + 1 - len(out)))
        out[idx] = value
    return out


def read_records(
    list_name: str, resource_id: str, headers: list[object], rows: list[list[object]]
) -> Iterator[tuple[dict, str]]:
    """Each employer row of one file, normalized, with its row hash, in file order.

    The 2016 to 2019 Q2 files print a group's shared cells once. An employer
    with several occupations takes one row per occupation, and only the first
    carries the employer, address and province; the rest (continuation rows)
    hold an occupation and a count, now and then an address of their own. The
    province is printed on the first row of its block and, from 2017 Q1, the
    stream on the first row of each stream block within it. A continuation row
    belongs to the employer row above it; a row that leaves the stream or
    province blank takes its block's. Nothing carries past a header, a
    province heading line, a summary or footnote line, or a row that names a
    province or stream of its own: a blank employer there (the 2019 Q3
    negative file has one) is a name ESDC left out, and the row is skipped.

    A row keeps the hash of its raw cells, so rows an earlier parser loaded
    keep theirs. A continuation row, and a raw row repeated under a second
    stream (the earlier parser kept only the first), are hashed with the
    carried cells written in. A row equal to an earlier one after filling is
    a duplicate and is skipped, as identical rows always were.
    """
    fields = map_headers(headers)
    section: str | None = None   # province from a heading line (2014) or a block's first row (2016 on)
    stream: str | None = None    # stream of the current block
    parent: dict | None = None   # the employer row the next continuation row belongs to
    hashes: set[str] = set()     # hashes handed out in this file
    filled_seen: set[str] = set()
    for row in rows:
        # The 2014 file repeats its header under each province and names the
        # province on a line of its own instead of in a column.
        if is_header_row(row):
            parent = None
            continue
        non_empty = [v for v in row if v not in (None, "")]
        # A heading line names one province in every filled cell: usually
        # once, but the 2015 negative file writes "Alberta,Alberta,".
        codes = {province_code(str(v)) for v in non_empty}
        if len(codes) == 1 and None not in codes:
            section, stream, parent = codes.pop(), None, None
            continue
        own_province = _cell(fields, row, "province")
        own_stream = _cell(fields, row, "stream")
        block_province = province_code(own_province) if own_province else section
        block_stream = own_stream or (None if own_province else stream)
        employer = _cell(fields, row, "employer")
        if employer:
            filled = _filled(fields, row, {"stream": None if own_stream else block_stream})
            rec = normalize_row(fields, filled)
            if rec is None or is_summary_row(rec):
                parent = None
                continue
            if rec["province"] is None:
                rec["province"] = block_province
            parent = {"employer": employer, "address": rec["address_raw"], "province": own_province,
                      "rec_province": rec["province"], "province_raw": rec["province_raw"]}
        elif (
            parent is not None and not own_province and not own_stream
            and _cell(fields, row, "occupation")
            and (to_int(_cell(fields, row, "positions")) is not None or to_int(_cell(fields, row, "lmias")) is not None)
        ):
            if address := _cell(fields, row, "address"):
                parent["address"] = address  # a second location; the rows below it follow it
            filled = _filled(fields, row, {"employer": parent["employer"], "address": parent["address"],
                                           "province": parent["province"], "stream": block_stream})
            rec = normalize_row(fields, filled)
            if rec is None:
                continue
            # The employer's province, so the row joins the employer above it.
            rec["province"], rec["province_raw"] = parent["rec_province"], parent["province_raw"]
        else:
            parent = None
            continue
        section, stream = block_province, block_stream
        full = row_hash(list_name, resource_id, filled)
        if full in filled_seen:
            continue
        filled_seen.add(full)
        raw = row_hash(list_name, resource_id, row)
        h = raw if employer and raw not in hashes else full
        if h in hashes:
            continue
        hashes.add(h)
        yield rec, h


# esdc_records columns written from a parsed row, in insert order (row_hash follows).
RECORD_COLUMNS = (
    "list", "period", "employer_id", "employer_raw", "province", "province_raw", "stream", "address_raw", "city",
    "postal_code", "noc_code", "noc_title", "incorporate_status", "lmias", "positions", "resource_id",
)
_INSERT_RECORD = (
    f"INSERT INTO esdc_records ({', '.join(RECORD_COLUMNS)}, row_hash) "
    f"VALUES ({', '.join('?' * (len(RECORD_COLUMNS) + 1))})"
)
_UPDATE_RECORD = f"UPDATE esdc_records SET {', '.join(f'{c} = ?' for c in RECORD_COLUMNS)} WHERE id = ?"


def english_resources(package: dict) -> list[dict]:
    resources = package.get("result", {}).get("resources", [])
    out = [r for r in resources if "en" in (r.get("language") or [])]
    out.sort(key=lambda r: (r.get("created") or "", r.get("name") or ""))
    return out


def resource_period(res: dict) -> str | None:
    return period_from_text(res.get("name") or "") or period_from_text(res.get("url") or "")


class DuplicateFile(Exception):
    """A resource whose file is byte for byte one published earlier under another resource."""


def _earlier_twin(conn: sqlite3.Connection, res: dict, sha: str) -> sqlite3.Row | None:
    """The loaded resource with the same file that was published first, when that is not this one."""
    mine = (iso_date(res.get("created")) or "9999-12-31", res["id"])
    for row in conn.execute(
        "SELECT resource_id, period, published FROM esdc_resources WHERE sha256 = ? AND resource_id != ?",
        (sha, res["id"]),
    ):
        if (row["published"] or "9999-12-31", row["resource_id"]) < mine:
            return row
    return None


def load_resource(
    conn: sqlite3.Connection,
    list_name: str,
    res: dict,
    data: bytes,
    *,
    now: str | None = None,
) -> int:
    """Parse one resource file into esdc_records. Returns rows inserted."""
    stamp = now or now_iso()
    url = res["url"]
    ext = url.lower().rsplit(".", 1)[-1]
    period = resource_period(res) or "unknown"
    sha = hashlib.sha256(data).hexdigest()
    twin = _earlier_twin(conn, res, sha)
    if twin is not None:
        # The same bytes were published earlier under another resource: a
        # second copy, not a second quarter. Loading it would count every row
        # twice and date the copy to the later period, so its rows are kept
        # out (and removed if an earlier run loaded them).
        conn.execute("DELETE FROM esdc_records WHERE resource_id = ?", (res["id"],))
        conn.execute("DELETE FROM esdc_resources WHERE resource_id = ?", (res["id"],))
        conn.commit()
        raise DuplicateFile(f"same file as {twin['period']} (resource {twin['resource_id']})")
    existing = conn.execute(
        "SELECT sha256, parser_version FROM esdc_resources WHERE resource_id = ?", (res["id"],)
    ).fetchone()
    if existing and existing["sha256"] == sha and existing["parser_version"] >= PARSER_VERSION:
        return 0
    # Parsed before anything is deleted, so a file that fails to parse leaves
    # the rows already loaded as they were.
    headers, rows = parse_resource(data, ext)
    records = list(read_records(list_name, res["id"], headers, rows))

    kept: dict[str, sqlite3.Row] = {}
    touched: set[str] = set()  # employers that may have lost their last row
    # Old employer id -> new ids its rows moved to. A row matched on its hash
    # is the same line of the same file, so when the parser now files it
    # under another id (a province carried down from its block), the two ids
    # are the same employer and a link to the old profile can be sent on.
    moved: dict[str, Counter] = defaultdict(Counter)
    if existing:
        prior = conn.execute("SELECT * FROM esdc_records WHERE resource_id = ?", (res["id"],)).fetchall()
        touched = {r["employer_id"] for r in prior}
        if existing["sha256"] == sha:
            # Same file, older parser: rows are matched on their hash, so a row
            # read correctly before keeps its id and is updated only where the
            # parser now reads it differently (a stream, a province).
            kept = {r["row_hash"]: r for r in prior}
        else:
            # ESDC revises files in place; reload the resource from scratch.
            conn.execute("DELETE FROM esdc_records WHERE resource_id = ?", (res["id"],))

    inserted = 0
    for rec, h in records:
        if is_household_row(rec):
            continue
        eid = upsert_employer(
            conn, rec["employer_raw"], rec["province"], source=f"esdc_{list_name}",
            city=rec["city"], postal_code=rec["postal_code"], now=stamp,
        )
        values = (
            list_name, period, eid, rec["employer_raw"], rec["province"], rec["province_raw"],
            rec["stream"], rec["address_raw"], rec["city"], rec["postal_code"], rec["noc_code"],
            rec["noc_title"], rec["incorporate_status"], rec["lmias"], rec["positions"], res["id"],
        )
        old = kept.pop(h, None)
        if old is None:
            conn.execute(_INSERT_RECORD, (*values, h))
            inserted += 1
        elif tuple(old[c] for c in RECORD_COLUMNS) != values:
            conn.execute(_UPDATE_RECORD, (*values, old["id"]))
            # Only when the name reads the same: a row whose name the earlier
            # parser read differently was filed under another employer, not
            # under this one's earlier id.
            if old["employer_id"] != eid and norm_name(old["employer_raw"]) == norm_name(rec["employer_raw"]):
                moved[old["employer_id"]][eid] += 1
    # Rows the older parser loaded that this one does not read.
    conn.executemany("DELETE FROM esdc_records WHERE id = ?", [(r["id"],) for r in kept.values()])
    loaded = conn.execute("SELECT COUNT(*) FROM esdc_records WHERE resource_id = ?", (res["id"],)).fetchone()[0]
    conn.execute(
        """
        INSERT INTO esdc_resources (resource_id, dataset, period, name, url, published, sha256, bytes,
          rows_loaded, loaded_at, parser_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource_id) DO UPDATE SET
          period = excluded.period, name = excluded.name, url = excluded.url,
          published = excluded.published, sha256 = excluded.sha256, bytes = excluded.bytes,
          rows_loaded = excluded.rows_loaded, loaded_at = excluded.loaded_at,
          parser_version = excluded.parser_version
        """,
        (
            res["id"], list_name, period, res.get("name") or "", url,
            iso_date(res.get("created")), sha, len(data), loaded, stamp, PARSER_VERSION,
        ),
    )
    drop_orphans(conn, touched)
    aliased = record_aliases(conn, moved, stamp)
    if aliased:
        log.info("%s %s: %d employer ids retired, each sent on to the id that took its rows", list_name, period, aliased)
    conn.commit()
    return inserted


def reload_outdated(conn: sqlite3.Connection, client: PoliteClient, *, now: str | None = None) -> dict:
    """Parse again, once, every loaded resource recorded under an older parser.

    Runs before the listings are read, so a portal outage does not hold it
    back. The file comes from the download cache whatever its age (the
    recorded checksum tells load_resource whether it is the file that was
    loaded) and is downloaded only when the cache lacks it. A resource whose
    file cannot be had keeps its rows and its old version and is tried again
    on the next run; once every resource carries PARSER_VERSION this finds
    nothing. Returns the resources reloaded, the rows they gained, any
    failures and duplicate files, and under misses each file the portal did
    not serve (a transient failure or the circuit breaker's trip) as (list,
    file name, reason): portal trouble, which run() counts with the rest,
    since the file is tried again next run and nothing is lost meanwhile. A
    refusal (404, 403) is a failure. When the breaker trips, reloading stops
    and aborted holds the reason, so run() asks the portal for nothing more
    that night; else aborted is None.
    """
    stamp = now or now_iso()
    out: dict = {"resources": 0, "rows": 0, "failures": [], "duplicates": [], "misses": [], "aborted": None}
    outdated = conn.execute(
        "SELECT resource_id, dataset, period, name, url, published FROM esdc_resources "
        "WHERE parser_version < ? ORDER BY dataset, period, resource_id",
        (PARSER_VERSION,),
    ).fetchall()
    for r in outdated:
        res = {"id": r["resource_id"], "name": r["name"], "url": r["url"], "created": r["published"]}
        label = f"{r['period']} {r['dataset']}"
        try:
            data = client.get(r["url"], cache=True, max_age_s=float("inf"))
        except AbortRun as exc:
            log.warning("esdc: the portal stopped answering during the reload of %s; no more ESDC requests "
                        "tonight: %s", label, exc)
            out["aborted"] = abort_reason(exc)
            out["misses"].append((r["dataset"], r["name"] or label, out["aborted"]))
            break
        except FetchError as exc:
            if exc.transient:
                out["misses"].append((r["dataset"], r["name"] or label, short_reason(exc)))
            else:
                out["failures"].append(f"reload {label}: {exc}")
            continue
        try:
            out["rows"] += load_resource(conn, r["dataset"], res, data, now=stamp)
        except DuplicateFile as exc:
            out["duplicates"].append(f"{label}: {exc}")
            continue
        except Exception as exc:  # keep reloading the others
            # The cached copy is kept: an older parser read it without fault.
            conn.rollback()
            out["failures"].append(f"reload {label}: {exc}")
            log.warning("reload of %s failed: %s", label, exc)
            continue
        out["resources"] += 1
    return out


def short_reason(exc: FetchError) -> str:
    """A failed request in a few words, for a notice: the HTTP status, else the
    exception class the client recorded (ConnectTimeout, ReadTimeout,
    ConnectionError), else the start of the message. The message itself names
    the URL and the repr and runs to hundreds of characters."""
    if exc.status is not None:
        return f"HTTP {exc.status}"
    text = str(exc)
    # "<url>: ConnectTimeout(MaxRetryError(...)) after 4 attempts"; a URL holds no ": ".
    match = re.search(r"(?:^|: )([A-Za-z_]\w*)\(", text)
    return match.group(1) if match else text[:60]


def abort_reason(exc: AbortRun) -> str:
    """The circuit breaker's trip in a few words, with the count of failed
    requests taken from its message ("5 requests failed in a row; last ...")."""
    match = re.search(r"(\d+) requests (?:failed )?in a row", str(exc))
    if not match:
        return "the portal stopped answering"
    n = int(match.group(1))
    return f"the portal stopped answering after {n} failed request{'s' if n != 1 else ''} in a row"


def _portal_keys(list_name: str) -> tuple[str, str, str]:
    """The meta keys for one list: consecutive nights with portal trouble, the
    UTC date of the last night counted, and the stamp of the last listing read."""
    return (f"esdc_portal_misses_{list_name}", f"esdc_portal_miss_date_{list_name}",
            f"esdc_listing_read_at_{list_name}")


def portal_night(conn: sqlite3.Connection, list_name: str, *, missed: bool, read: bool, stamp: str) -> int:
    """Record tonight for one list and return its consecutive nights with portal
    trouble (0 when tonight had none).

    A night counts once per UTC date, so a same-day retry run does not count
    it twice. Committed here, so a file that fails to load later in the
    stage (and rolls back) cannot take the count with it."""
    misses_key, date_key, read_key = _portal_keys(list_name)
    if read:
        set_meta(conn, read_key, stamp)
    if not missed:
        set_meta(conn, misses_key, 0)
        conn.commit()
        return 0
    day = stamp[:10]  # stamps are UTC (db.now_iso)
    try:
        nights = int(get_meta(conn, misses_key) or 0)
    except ValueError:
        nights = 0
    # A count set back to 0 earlier the same day starts again at 1.
    if nights == 0 or get_meta(conn, date_key) != day:
        nights += 1
        set_meta(conn, misses_key, nights)
        set_meta(conn, date_key, day)
    conn.commit()
    return nights


def run(conn: sqlite3.Connection, client: PoliteClient, *, now: str | None = None) -> dict[str, int]:
    stamp = now or now_iso()
    totals: dict[str, int] = {}
    failures: list[str] = []
    duplicates: list[str] = []
    notices: list[str] = []
    portal: list[str] = []  # tonight's portal trouble per list, for the detail line
    # Before the listings, so a portal outage does not keep what an older
    # parser loaded. Summary rows go by rule; files loaded under an older
    # parser version are parsed again from the cache. Otherwise a loaded file
    # is parsed again only when ESDC revises it.
    removed = remove_summary_rows(conn)
    households = remove_household_rows(conn)
    reloaded = reload_outdated(conn, client, now=stamp)
    failures.extend(reloaded["failures"])
    duplicates.extend(reloaded["duplicates"])
    # Set once the circuit breaker trips (the reason): the breaker exists to
    # stop asking a failing host, so no further ESDC request goes out
    # tonight. The stage does not raise, since the later stages ask other hosts.
    stopped: str | None = reloaded["aborted"]
    # The reload's misses, counted against their lists with the listing's and the files'.
    carried: dict[str, list[tuple[str | None, str]]] = {}
    for miss_list, miss_name, miss_reason in reloaded["misses"]:
        carried.setdefault(miss_list, []).append((miss_name, miss_reason))
    for list_name, dataset_id in config.ESDC_DATASETS.items():
        listing = config.CKAN_PACKAGE_SHOW.format(dataset=dataset_id)
        # A portal outage, or a maintenance page served with HTTP 200, costs
        # this list the night and is a notice: ESDC publishes a few quarters a
        # year, so the quarters already loaded stand and the next run reads
        # the listing again. From the list's PORTAL_MISS_NIGHTS-th night in a
        # row it is a failure. A refusal (404, 403) fails the first night,
        # since waiting will not bring back a moved address or a withdrawn
        # dataset. Each miss: the file's name (None for the listing), the reason.
        missed: list[tuple[str | None, str]] = carried.pop(list_name, [])
        if stopped and not missed:
            # Never reached tonight: no count change and no notice of its own.
            portal.append(f"{list_name} not read")
            totals[list_name] = 0
            continue
        resources: list[dict] = []
        read = False
        # Skipped when the breaker tripped while reloading.
        if not stopped:
            try:
                package = client.get_json(listing, cache=True, max_age_s=0)
                resources = english_resources(package)
                read = True
            except AbortRun as exc:
                client.forget(listing)
                log.warning("esdc: the portal stopped answering at the %s listing; no more ESDC requests "
                            "tonight: %s", list_name, exc)
                stopped = abort_reason(exc)
                missed.append((None, stopped))
            except FetchError as exc:
                client.forget(listing)
                if exc.transient:
                    missed.append((None, short_reason(exc)))
                else:
                    failures.append(f"{list_name} listing: {exc}"[:300])
            except (ValueError, AttributeError):
                # Not the JSON CKAN sends: a maintenance page, never kept in the cache.
                client.forget(listing)
                missed.append((None, "not the expected JSON"))
        if read and not resources:
            failures.append(f"{list_name} listing: no English resources")
        loaded = 0
        for res in resources:
            url = res.get("url") or ""
            ext = url.lower().rsplit(".", 1)[-1]
            if ext not in ("csv", "xlsx", "xls", "xlsm"):
                log.info("skip %s (%s)", res.get("name"), ext)
                continue
            try:
                data = client.get(url, cache=True, max_age_s=7 * 86400)
            except AbortRun as exc:
                log.warning("esdc: the portal stopped answering at %s; no more ESDC requests tonight: %s",
                            res.get("name") or url, exc)
                stopped = abort_reason(exc)
                missed.append((res.get("name") or url, stopped))
                break
            except FetchError as exc:
                # A timeout or a 5xx counts against the list like a listing
                # the portal did not serve; a 404 is a moved file, a failure.
                if exc.transient:
                    missed.append((res.get("name") or url, short_reason(exc)))
                else:
                    failures.append(f"{res.get('name')}: {exc}")
                continue
            try:
                n = load_resource(conn, list_name, res, data, now=stamp)
            except DuplicateFile as exc:
                # An upstream copy, noted rather than failed: it would otherwise
                # raise an alert every night for a file nobody here can fix.
                duplicates.append(f"{resource_period(res) or res.get('id')} {list_name}: {exc}")
                log.warning("resource %s skipped: %s", res.get("name"), exc)
                continue
            except Exception as exc:  # keep loading the other quarters
                conn.rollback()
                # Fetch it again next time; the file may be fixed upstream.
                client.forget(url)
                failures.append(f"{res.get('name')}: {exc}")
                log.warning("resource %s failed: %s", res.get("name"), exc)
                continue
            loaded += n
            if n:
                log.info("%s %s: %d rows", list_name, resource_period(res), n)
        totals[list_name] = loaded
        nights = portal_night(conn, list_name, missed=bool(missed), read=read, stamp=stamp)
        if missed:
            # The last miss, which is the breaker's trip when it tripped.
            name, reason = missed[-1]
            portal.append(f"{list_name} night {nights} ({reason if name is None else 'download: ' + reason})")
        for name, reason in missed:
            if nights >= PORTAL_MISS_NIGHTS:
                what = f"{list_name} listing" if name is None else name
                failures.append(f"{what}: the portal has not been readable for {nights} nights ({reason})")
            elif name is None:
                notices.append(
                    f"ESDC portal: the {list_name} listing could not be read tonight ({reason}); the quarters "
                    f"already loaded stand; read again next run (an item needing attention after "
                    f"{PORTAL_MISS_NIGHTS} nights)")
            else:
                notices.append(f"ESDC portal: {name} could not be downloaded tonight ({reason}); tried again next run")
    detail = f"positive={totals.get('positive', 0)} negative={totals.get('negative', 0)}"
    if portal:
        detail += " portal=" + ", ".join(portal)
    if removed["rows"]:
        detail += f" summary_rows_removed={removed['rows']} employers_removed={removed['employers']}"
    if households["rows"]:
        detail += f" household_rows_removed={households['rows']} household_employers_removed={households['employers']}"
    if reloaded["resources"]:
        detail += f" reloaded={reloaded['resources']} reload_rows_added={reloaded['rows']} parser_version={PARSER_VERSION}"
    if duplicates:
        # The reload and the listing can both meet the same copy.
        detail += " duplicates=" + "; ".join(dict.fromkeys(duplicates))[:400]
    # The reload and the listing loop can both miss the same file: one line for it.
    if failures:
        detail += " failures=" + "; ".join(dict.fromkeys(failures))[:900]
    log_run(conn, "esdc", detail=detail, rows_new=sum(totals.values()) + reloaded["rows"], ok=not failures,
            notice=NOTICE_SEP.join(dict.fromkeys(notices)) if notices else None)
    return totals
