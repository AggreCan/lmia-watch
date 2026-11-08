"""Continuation rows and carried cells in the 2016 to 2019 Q2 ESDC files.

An employer with several occupations is printed as one row per occupation,
and only the first row of the group names the employer, address and province;
from 2017 Q1 the stream is printed once at the top of each stream block. The
parser before PARSER_VERSION 1 dropped every later row of a group (7,755
positive and 490 negative rows) and left almost every 2017 Q1 to 2019 Q2 row
without a stream.
"""

import hashlib
import json
from collections import Counter

from lmia_pipeline import config, export_static, status
from lmia_pipeline.db import upsert_employer
from lmia_pipeline.normalize import NORMALIZE_VERSION, province_code
from lmia_pipeline.sources import esdc
from lmia_pipeline.sources.esdc import (
    PARSER_VERSION, is_header_row, is_summary_row, load_resource, map_headers, normalize_row, parse_resource,
    read_records, row_hash,
)

NOW = "2026-10-19T00:00:00Z"
LATER = "2026-10-20T00:00:00Z"
POS_LISTING = config.CKAN_PACKAGE_SHOW.format(dataset=config.ESDC_DATASETS["positive"])
NEG_LISTING = config.CKAN_PACKAGE_SHOW.format(dataset=config.ESDC_DATASETS["negative"])

# The 2016 layout: no stream column, the province on the first row of its block.
FILE_2016 = (
    '"Employers who were issued a positive Labour Market Impact Assessment (LMIA) by National Occupational '
    'Classification (NOC) 2011 and business location in 2016",,,,\r\r\n'
    "Province/Territory,Employer,Address,Occupations under NOC 2011,Positions Approved\r\r\n"
    'Newfoundland and Labrador,10565 NFLD. Inc.,"Goose Bay, NL A0P 1C0",6312-Executive housekeepers,1\r\r\n'
    ',,"Happy Valley Goose Bay, NL A0P 1C0",6312-Executive housekeepers,2\r\r\n'
    ",,,6322-Cooks,3\r\r\n"
    ',Arup Canada Inc.,"St. John\'s, NL A1B 4M7",0711-Construction managers,1\r\r\n'
    ",,,2153-Urban and land use planners,1\r\r\n"
    'Nunavut,Qikiqtani General Hospital,"Iqaluit, NU X0A 0H0",3111-Specialist physicians,2\r\r\n'
    ',Qikiqtani Inuit Association,"Iqaluit, X0A 0H0",4164-Social policy researchers,4\r\r\n'
    ",,,1111-Financial auditors and accountants,2\r\r\n"
    "Notes:,,,,\r\r\n"
    '"1. The source for all information in this report is Employment and Social Development Canada\'s (ESDC) '
    'Foreign Worker System (FWS).",,,,\r\r\n'
    ",,,6322-Cooks,9\r\r\n"
).encode("cp1252")
RES_2016 = {"id": "res-2016", "name": "2016 positive employers", "created": "2017-03-01T00:00:00",
            "url": "https://example.invalid/2016_positive_employer_en.csv"}

# The 2017 Q1 to 2019 Q2 layout: the stream on the first row of each stream block.
FILE_2017 = (
    '"List of employers who were issued a positive Labour Market Impact Assessment (LMIA) by Stream, National '
    'Occupational Classification (NOC) 2011 and business location in 2017 (July-September)",,,,,\r\r\n'
    "Province/Territory,Stream,Employer,Address,Occupations under NOC 2011,Positions Approved\r\r\n"
    'Newfoundland and Labrador,    High Wage,Kiewit-Kvaerner Contractors,"St. John\'s, NL A1E 1E2",2131-Civil engineers,1\r\r\n'
    ",,,,2232-Mechanical engineering technologists and technicians,1\r\r\n"
    ',,Subsea 7 Canada Inc.,"St. John\'s, NL A1E 3Y3",0711-Construction managers,2\r\r\n'
    ',    Low Wage,Green Food Industries Inc.,"St. John\'s, NL A1B 1W3",6322-Cooks,1\r\r\n'
    ',,Subsea 7 Canada Inc.,"St. John\'s, NL A1E 3Y3",0711-Construction managers,2\r\r\n'
    ",,,,7532-Water transport deck and engine room crew,4\r\r\n"
    'Prince Edward Island,    Low Wage,D&D Brothers Investment Group Limited,"CHARLOTTETOWN, PE C1A 4N4",6322-Cooks,1\r\r\n'
    ',,Total,,,"5,000"\r\r\n'
    ",,,,6322-Cooks,5\r\r\n"
    'Employers carrying on business in Canada with Head Office outside of Canada,    High Wage,Tool of North America LLC,'
    '"Santa Monica, 90404","5131-Producers, directors, choreographers and related occupations",3\r\r\n'
    ",,,,5241-Graphic designers and illustrators,1\r\r\n"
    ',,Supply and Demand Inc,"New York, 10013","5131-Producers, directors, choreographers and related occupations",1\r\r\n'
    "Employers carrying on business in Canada with Head Office outside of Canada,    High Wage,,,6332-Bakers,1\r\r\n"
    "Notes:,,,,,\r\r\n"
    '"1. The source for all information in this report is Employment and Social Development Canada\'s (ESDC) '
    'Foreign Worker System (FWS).",,,,,\r\r\n'
).encode("cp1252")
RES_2017 = {"id": "res-2017q3", "name": "2017Q3 employers with a positive LMIA, by stream", "created": "2017-11-01T00:00:00",
            "url": "https://example.invalid/2017q3_positive_employer_stream_en.csv"}
# A healthy negative list, so the run reports no failure.
RES_NEG = {"id": "res-neg", "name": "2026Q1 employers with a negative LMIA", "created": "2026-07-01T00:00:00",
           "url": "https://example.invalid/2026q1_neg.csv"}
FILE_NEG = (b"Province/Territory,Stream,Employer,Address,Occupation,Approved LMIAs,Approved Positions\n"
            b'Alberta,High Wage,Other Co,"Calgary, AB T2P 1A1",72600-Electricians,1,1\n')


def listing(*resources) -> bytes:
    return json.dumps({"success": True, "result": {"resources": [{**r, "language": ["en"]} for r in resources]}}).encode()


def records(conn, resource_id):
    return conn.execute("SELECT * FROM esdc_records WHERE resource_id = ? ORDER BY id", (resource_id,)).fetchall()


def _old_is_header_row(row):
    fields = map_headers(row)
    return "employer" in fields and ("occupation" in fields or "positions" in fields)


def _load_like_the_old_parser(conn, list_name, res, data):
    """What the parser before PARSER_VERSION 1 stored: only rows that name an
    employer and do not read like a header, each with its own stream cell and
    the hash of its raw cells, the first of two identical rows only. The
    resource row leaves parser_version to the column default, as on a
    database from before the column."""
    headers, rows = parse_resource(data, res["url"].rsplit(".", 1)[-1])
    fields = map_headers(headers)
    period = esdc.resource_period(res)
    section = None
    n = 0
    for row in rows:
        if _old_is_header_row(row):
            continue
        codes = {province_code(str(v)) for v in row if v not in (None, "")}
        if len(codes) == 1 and None not in codes:
            section = codes.pop()
            continue
        rec = normalize_row(fields, row)
        if rec is None or is_summary_row(rec):
            continue
        rec["province"] = rec["province"] or section
        h = row_hash(list_name, res["id"], row)
        if conn.execute("SELECT 1 FROM esdc_records WHERE row_hash = ?", (h,)).fetchone():
            continue
        eid = upsert_employer(conn, rec["employer_raw"], rec["province"], source=f"esdc_{list_name}",
                              city=rec["city"], postal_code=rec["postal_code"], now=NOW)
        conn.execute(
            "INSERT INTO esdc_records (list, period, employer_id, employer_raw, province, province_raw, stream, address_raw, "
            "city, postal_code, noc_code, noc_title, incorporate_status, lmias, positions, resource_id, row_hash) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (list_name, period, eid, rec["employer_raw"], rec["province"], rec["province_raw"], rec["stream"],
             rec["address_raw"], rec["city"], rec["postal_code"], rec["noc_code"], rec["noc_title"],
             rec["incorporate_status"], rec["lmias"], rec["positions"], res["id"], h),
        )
        n += 1
    conn.execute(
        "INSERT INTO esdc_resources (resource_id, dataset, period, name, url, published, sha256, bytes, rows_loaded, loaded_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (res["id"], list_name, period, res["name"], res["url"], res["created"][:10],
         hashlib.sha256(data).hexdigest(), len(data), n, NOW),
    )
    conn.commit()
    return n


def test_continuation_rows_belong_to_the_employer_above(conn):
    assert load_resource(conn, "positive", RES_2016, FILE_2016, now=NOW) == 8
    got = [(r["employer_raw"], r["noc_code"], r["positions"], r["city"], r["province"]) for r in records(conn, "res-2016")]
    assert got == [
        ("10565 NFLD. Inc.", "6312", 1, "Goose Bay", "NL"),
        # A continuation row with an address of its own is a second location,
        # and the row below it follows that address.
        ("10565 NFLD. Inc.", "6312", 2, "Happy Valley Goose Bay", "NL"),
        ("10565 NFLD. Inc.", "6322", 3, "Happy Valley Goose Bay", "NL"),
        ("Arup Canada Inc.", "0711", 1, "St. John's", "NL"),
        ("Arup Canada Inc.", "2153", 1, "St. John's", "NL"),
        ("Qikiqtani General Hospital", "3111", 2, "Iqaluit", "NU"),
        # The address names no province; the first row of the block does.
        ("Qikiqtani Inuit Association", "4164", 4, "Iqaluit", "NU"),
        ("Qikiqtani Inuit Association", "1111", 2, "Iqaluit", "NU"),
    ]
    # The cook row under the footnotes belongs to nobody.
    assert conn.execute("SELECT COUNT(*) FROM esdc_records WHERE positions = 9").fetchone()[0] == 0
    # Each group is one employer.
    ids = conn.execute("SELECT employer_raw, COUNT(DISTINCT employer_id) FROM esdc_records GROUP BY employer_raw").fetchall()
    assert {r[1] for r in ids} == {1}
    assert tuple(conn.execute("SELECT rows_loaded, parser_version FROM esdc_resources").fetchone()) == (8, PARSER_VERSION)


def test_the_stream_is_carried_down_its_block(conn):
    assert load_resource(conn, "positive", RES_2017, FILE_2017, now=NOW) == 10
    got = [(r["employer_raw"], r["stream"], r["noc_code"], r["positions"], r["province"]) for r in records(conn, "res-2017q3")]
    assert got == [
        ("Kiewit-Kvaerner Contractors", "High Wage", "2131", 1, "NL"),
        ("Kiewit-Kvaerner Contractors", "High Wage", "2232", 1, "NL"),
        ("Subsea 7 Canada Inc.", "High Wage", "0711", 2, "NL"),
        ("Green Food Industries Inc.", "Low Wage", "6322", 1, "NL"),
        # The same raw row under a second stream is a second record.
        ("Subsea 7 Canada Inc.", "Low Wage", "0711", 2, "NL"),
        ("Subsea 7 Canada Inc.", "Low Wage", "7532", 4, "NL"),
        ("D&D Brothers Investment Group Limited", "Low Wage", "6322", 1, "PE"),
        ("Tool of North America LLC", "High Wage", "5131", 3, "XX"),
        ("Tool of North America LLC", "High Wage", "5241", 1, "XX"),
        ("Supply and Demand Inc", "High Wage", "5131", 1, "XX"),
    ]
    # Not loaded: the "Total" line, the cook row under it, and the baker row
    # that restates its block but names no employer.
    assert "Total" not in {r["employer_raw"] for r in records(conn, "res-2017q3")}
    assert conn.execute("SELECT COUNT(*) FROM esdc_records WHERE noc_code = '6332' OR positions = 5").fetchone()[0] == 0


def test_nothing_carries_past_a_header_heading_summary_or_footnote():
    headers = ["Province/Territory", "Stream", "Employer", "Address", "Occupation", "Positions Approved"]
    first = ["Alberta", "Low Wage", "Prairie Farms Ltd", "Brooks, AB T1R 0N9", "8431-General farm workers", "3"]
    orphan = ["", "", "", "", "8611-Harvesting labourers", "1"]
    breaks = [
        headers,                                                            # a repeated header
        ["Saskatchewan", "", "", "", "", ""],                               # a province heading line
        ["", "", "Total", "", "", "40"],                                    # a summary line
        ["1. This list excludes all personal names.", "", "", "", "", ""],  # a footnote
        ["Alberta", "Low Wage", "", "", "8431-General farm workers", "2"],  # a blank name that restates its block
        ["", "", "", "", "8431-General farm workers", ""],                  # an occupation with no count
    ]
    for line in breaks:
        got = [rec["employer_raw"] for rec, _ in read_records("positive", "r", headers, [first, line, orphan])]
        assert got == ["Prairie Farms Ltd"], line
    # Without a break the row belongs to the employer, and a second identical
    # line is a duplicate, as identical rows always were.
    got = [(rec["employer_raw"], rec["noc_code"]) for rec, _ in read_records("positive", "r", headers, [first, orphan, orphan])]
    assert got == [("Prairie Farms Ltd", "8431"), ("Prairie Farms Ltd", "8611")]


def test_a_data_row_that_reads_like_a_header_is_data():
    assert is_header_row(["Province/Territory", "Stream", "Employer", "Address", "Occupation", "Approved Positions"])
    assert is_header_row(["Employer ", "Address", "Positions"])
    assert not is_header_row([
        "Employers carrying on business in Canada with Head Office outside of Canada", "High Wage",
        "Bourbon Offshore DNT", "Ravenna, 48123", "7384-Other trades and related occupations, n.e.c.", "6",
    ])
    assert not is_header_row(["British Columbia", "High Wage", "Waterfront Employers of BC", "VANCOUVER, BC V6A 1A4",
                              "1121-Human resources professionals", "Unknown", 3, 3])


def test_rows_the_earlier_parser_loaded_keep_their_hashes(conn):
    # 2016: four continuation rows are new. 2017: three continuation rows,
    # the copy under a second stream, and the Tool of North America row the
    # earlier parser took for a header.
    for res, data, added, raw_added in ((RES_2016, FILE_2016, 4, 0), (RES_2017, FILE_2017, 5, 1)):
        _load_like_the_old_parser(conn, "positive", res, data)
        old = {r[0] for r in conn.execute("SELECT row_hash FROM esdc_records WHERE resource_id = ?", (res["id"],))}
        headers, rows = parse_resource(data, "csv")
        new = [h for _, h in read_records("positive", res["id"], headers, rows)]
        assert len(new) == len(set(new))
        assert old <= set(new)
        # Rows with something carried into them get hashes no raw row has.
        raw = {row_hash("positive", res["id"], r) for r in rows}
        assert len(set(new) - old) == added
        assert len((set(new) - old) & raw) == raw_added


def test_an_older_parse_is_replaced_once_and_rows_read_right_keep_their_ids(conn, fake_client):
    assert _load_like_the_old_parser(conn, "positive", RES_2016, FILE_2016) == 4
    assert _load_like_the_old_parser(conn, "positive", RES_2017, FILE_2017) == 5
    before = {r["row_hash"]: dict(r) for r in conn.execute("SELECT * FROM esdc_records")}
    assert [r["stream"] for r in records(conn, "res-2017q3")].count(None) == 2
    # The earlier parser put the association under no province.
    lost = conn.execute("SELECT employer_id FROM esdc_records WHERE employer_raw = 'Qikiqtani Inuit Association'").fetchone()[0]
    conn.execute("INSERT INTO indicators (employer_id, indicator, state, basis, rule_version, computed_at) "
                 "VALUES (?, 'repeat_applicant', 'not_triggered', 'x', '0.2', ?)", (lost, NOW))
    conn.commit()
    status.recompute(conn, now=NOW)
    assert {r[0] for r in conn.execute("SELECT parser_version FROM esdc_resources")} == {0}

    client = fake_client({
        POS_LISTING: listing(RES_2016, RES_2017), NEG_LISTING: listing(RES_NEG),
        RES_2016["url"]: FILE_2016, RES_2017["url"]: FILE_2017, RES_NEG["url"]: FILE_NEG,
    })
    esdc.run(conn, client, now=LATER)
    status.recompute(conn, now=LATER)

    after = {r["row_hash"]: dict(r) for r in conn.execute("SELECT * FROM esdc_records WHERE list = 'positive'")}
    assert len(after) == 18
    for h, old in before.items():
        # Read right before: same id, same hash, same employer and counts.
        assert after[h]["id"] == old["id"]
        for col in ("employer_raw", "noc_code", "positions", "address_raw", "period"):
            assert after[h][col] == old[col], col
    assert [r["stream"] for r in records(conn, "res-2017q3")].count(None) == 0
    assert conn.execute("SELECT SUM(positions) FROM esdc_records WHERE list = 'positive'").fetchone()[0] == 16 + 17
    # The association moved to Nunavut; its province-less employer went with its indicator and names.
    provinces = conn.execute("SELECT DISTINCT province FROM esdc_records WHERE employer_raw = 'Qikiqtani Inuit Association'")
    assert [r[0] for r in provinces] == ["NU"]
    for table, col in (("employers", "id"), ("indicators", "employer_id"), ("employer_names", "employer_id")):
        assert conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {col} = ?", (lost,)).fetchone()[0] == 0, table
    assert conn.execute("SELECT approved_positions FROM employers WHERE display_name = 'Qikiqtani Inuit Association'"
                        ).fetchone()[0] == 6
    loaded = {r[0]: tuple(r)[1:] for r in conn.execute(
        "SELECT resource_id, rows_loaded, parser_version FROM esdc_resources WHERE dataset = 'positive'")}
    assert loaded == {"res-2016": (8, PARSER_VERSION), "res-2017q3": (10, PARSER_VERSION)}
    ok, detail = conn.execute("SELECT ok, detail FROM sources_log WHERE source = 'esdc' ORDER BY id DESC").fetchone()
    assert ok == 1 and "reloaded=2 reload_rows_added=9" in detail

    # The next run finds nothing to reload and fetches no file.
    snapshot = [tuple(r) for r in conn.execute("SELECT * FROM esdc_records ORDER BY id")]
    calls = len(client.fake_session.calls)
    assert esdc.reload_outdated(conn, client, now=LATER)["resources"] == 0
    esdc.run(conn, client, now="2026-10-21T00:00:00Z")
    assert [tuple(r) for r in conn.execute("SELECT * FROM esdc_records ORDER BY id")] == snapshot
    fetched = [url for url, _ in client.fake_session.calls[calls:]]
    assert RES_2016["url"] not in fetched and RES_2017["url"] not in fetched
    detail = conn.execute("SELECT detail FROM sources_log WHERE source = 'esdc' ORDER BY id DESC").fetchone()[0]
    assert "reloaded" not in detail


def test_a_file_without_carried_cells_is_left_as_it_was(conn, fake_client, fixtures):
    res = {"id": "res-pos", "name": "2026Q1 employers with a positive LMIA (English)", "created": "2026-07-21T14:00:00",
           "url": "https://example.invalid/tfwp_2026q1_pos_en.xlsx"}
    data = (fixtures / "esdc_2026q1_pos_trim.xlsx").read_bytes()
    assert _load_like_the_old_parser(conn, "positive", res, data) == 40
    snapshot = [tuple(r) for r in conn.execute("SELECT * FROM esdc_records ORDER BY id")]
    out = esdc.reload_outdated(conn, fake_client({res["url"]: data}), now=LATER)
    assert out == {"resources": 1, "rows": 0, "failures": [], "duplicates": [], "misses": [], "aborted": None}
    assert [tuple(r) for r in conn.execute("SELECT * FROM esdc_records ORDER BY id")] == snapshot


def test_the_reload_reads_the_cache_and_waits_while_the_file_cannot_be_had(conn, fake_client):
    _load_like_the_old_parser(conn, "positive", RES_2016, FILE_2016)
    # Nothing cached and the portal down: the rows and the version stay, and the run says so.
    esdc.run(conn, fake_client({}), now=LATER)
    assert len(records(conn, "res-2016")) == 4
    assert conn.execute("SELECT parser_version FROM esdc_resources").fetchone()[0] == 0
    ok, detail = conn.execute("SELECT ok, detail FROM sources_log WHERE source = 'esdc' ORDER BY id DESC").fetchone()
    assert ok == 0 and "reload 2016 positive: HTTP 404" in detail
    # Once cached, however long ago, the file is read from the cache without a request.
    fake_client({RES_2016["url"]: FILE_2016}).get(RES_2016["url"], cache=True)
    offline = fake_client({})
    out = esdc.reload_outdated(conn, offline, now=LATER)
    assert (out["resources"], out["rows"]) == (1, 4)
    assert offline.fake_session.calls == []
    assert conn.execute("SELECT parser_version FROM esdc_resources").fetchone()[0] == PARSER_VERSION




# -- ids the reload retires ---------------------------------------------------


def association_id(conn) -> str:
    rows = conn.execute("SELECT DISTINCT employer_id FROM esdc_records WHERE employer_raw = 'Qikiqtani Inuit Association'")
    (eid,) = [r[0] for r in rows]
    return eid


def test_an_id_the_reload_retires_is_sent_on_to_the_employer_that_took_its_rows(conn, fake_client):
    _load_like_the_old_parser(conn, "positive", RES_2016, FILE_2016)
    # The earlier parser filed the association under no province; the reload
    # reads Nunavut from its block, which is another employer id.
    lost = association_id(conn)
    # A row the earlier parser read under another name: the same line of the
    # file, but not the same employer, so its old id is not sent on.
    misread = upsert_employer(conn, "Arup Canada Misread", "NL", source="esdc_positive", now=NOW)
    conn.execute("UPDATE esdc_records SET employer_id = ?, employer_raw = 'Arup Canada Misread' "
                 "WHERE employer_raw = 'Arup Canada Inc.'", (misread,))
    conn.commit()

    out = esdc.reload_outdated(conn, fake_client({RES_2016["url"]: FILE_2016}), now=LATER)
    assert out["resources"] == 1 and out["failures"] == []
    taken = association_id(conn)
    assert taken != lost
    for gone in (lost, misread):
        assert conn.execute("SELECT 1 FROM employers WHERE id = ?", (gone,)).fetchone() is None
    rows = [tuple(r) for r in conn.execute("SELECT old_id, new_id, normalize_version, created_at FROM employer_aliases")]
    assert rows == [(lost, taken, NORMALIZE_VERSION, LATER)]
    # The static export sends a link to the old profile on.
    assert export_static.resolve_aliases(conn) == {lost: taken}


def test_an_id_that_keeps_a_record_elsewhere_is_not_retired(conn, fake_client):
    _load_like_the_old_parser(conn, "positive", RES_2016, FILE_2016)
    kept = association_id(conn)
    conn.execute("INSERT INTO jobbank_postings (posting_id, employer_id, employer_raw, first_seen, last_seen, flag_current, "
                 "flag_first, url, updated_at) VALUES (1, ?, 'Qikiqtani Inuit Association', ?, ?, 'requested', "
                 "'requested', 'u', ?)", (kept, NOW, NOW, NOW))
    conn.commit()
    esdc.reload_outdated(conn, fake_client({RES_2016["url"]: FILE_2016}), now=LATER)
    assert association_id(conn) != kept
    assert conn.execute("SELECT 1 FROM employers WHERE id = ?", (kept,)).fetchone() is not None
    assert conn.execute("SELECT COUNT(*) FROM employer_aliases").fetchone()[0] == 0


def test_a_retired_id_points_at_the_id_that_took_most_of_its_rows(conn):
    live = upsert_employer(conn, "Still Here Ltd", "BC", source="esdc_positive", now=NOW)
    written = esdc.record_aliases(conn, {
        "emp-gone000001": Counter({"emp-x000000002": 1, "emp-y000000003": 3}),
        "emp-gone000004": Counter({"emp-z000000009": 2, "emp-w000000005": 2}),  # a tie: the lowest id
        live: Counter({"emp-x000000002": 5}),                                   # not retired
        "emp-gone000006": Counter(),
    }, LATER)
    assert written == 2
    assert dict(conn.execute("SELECT old_id, new_id FROM employer_aliases").fetchall()) == {
        "emp-gone000001": "emp-y000000003", "emp-gone000004": "emp-w000000005"}
