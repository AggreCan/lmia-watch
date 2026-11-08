"""The ESDC and IRCC loaders against an open-data portal that changed or failed."""

import json

import requests

from conftest import FakeResponse
from lmia_pipeline import config
from lmia_pipeline.db import get_meta
from lmia_pipeline.http import AbortRun, FetchError
from lmia_pipeline.sources import esdc, ircc

POS_LISTING = config.CKAN_PACKAGE_SHOW.format(dataset=config.ESDC_DATASETS["positive"])
NEG_LISTING = config.CKAN_PACKAGE_SHOW.format(dataset=config.ESDC_DATASETS["negative"])
HEADER = "Province/Territory,Stream,Employer,Address,Occupation,Approved LMIAs,Approved Positions\n"
ROWS = (
    'Manitoba,High Wage,Acme Farms Ltd,"Winnipeg, MB R3C 1A1",72600-Electricians,1,2\n'
    'Ontario,Low Wage,Sample Hotels Corp,"Toronto, ON M5V 1A1",65201-Food counter attendants,2,5\n'
)


def res(rid: str, period: str, created: str, ext: str = "csv") -> dict:
    return {"id": rid, "name": f"{period} employers with a positive LMIA", "url": f"https://example.invalid/{rid}.{ext}",
            "language": ["en"], "created": created}


def listing(*resources) -> bytes:
    return json.dumps({"success": True, "result": {"resources": list(resources)}}).encode()


# A healthy negative list for the tests about the positive one.
NEG = res("neg-q1", "2026Q1", "2026-07-01T00:00:00")
NEG_ROW = 'Alberta,High Wage,Other Co,"Calgary, AB T2P 1A1",72600-Electricians,1,1'
NEG_OK = {NEG_LISTING: listing(NEG), NEG["url"]: (HEADER + NEG_ROW + "\n").encode()}


def esdc_log(conn):
    return conn.execute(
        "SELECT ok, detail, notice FROM sources_log WHERE source = 'esdc' ORDER BY id DESC LIMIT 1").fetchone()


# Three runs on three UTC dates, as the nightly schedule makes them.
NIGHTS = ("2026-11-08T00:23:00Z", "2026-11-09T00:21:00Z", "2026-11-10T00:19:00Z")
LISTING_NOTICE = ("ESDC portal: the positive listing could not be read tonight ({reason}); the quarters already "
                  f"loaded stand; read again next run (an item needing attention after {esdc.PORTAL_MISS_NIGHTS} nights)")


def outage(fake_client):
    """A client for a night the portal answers the positive listing with a 503."""
    return fake_client({POS_LISTING: FakeResponse(503), **NEG_OK}, max_attempts=1)


def test_a_portal_outage_costs_one_list_one_night(conn, fake_client):
    a = res("q1", "2026Q1", "2026-07-01T00:00:00")
    client = fake_client({
        POS_LISTING: FakeResponse(503),
        NEG_LISTING: listing(a),
        a["url"]: (HEADER + ROWS).encode(),
    }, max_attempts=1)
    totals = esdc.run(conn, client)
    assert totals == {"positive": 0, "negative": 2}
    ok, detail, notice = esdc_log(conn)
    # A notice the first night, not a failed stage: the quarters already loaded stand.
    assert ok == 1 and "portal=positive night 1 (HTTP 503)" in detail and "failures=" not in detail
    assert notice == LISTING_NOTICE.format(reason="HTTP 503")


def test_a_maintenance_page_served_as_the_listing_is_not_kept_in_the_cache(conn, fake_client):
    client = fake_client({POS_LISTING: b"<html>Down for maintenance</html>", **NEG_OK})
    assert esdc.run(conn, client) == {"positive": 0, "negative": 1}
    ok, detail, notice = esdc_log(conn)
    assert ok == 1 and "portal=positive night 1 (not the expected JSON)" in detail
    assert notice == LISTING_NOTICE.format(reason="not the expected JSON")
    assert client._cache_entry(POS_LISTING) is None


def test_a_connect_timeout_is_named_by_its_class(conn, fake_client):
    # The run of 2026-11-08: package_show for the positive list timed out connecting.
    client = fake_client(NEG_OK, max_attempts=1)
    served = client.session.get

    def get(url, **kwargs):
        if url == POS_LISTING:
            raise requests.ConnectTimeout("HTTPSConnectionPool(host='open.canada.ca', port=443): Max retries exceeded")
        return served(url, **kwargs)

    client.session.get = get
    esdc.run(conn, client, now=NIGHTS[0])
    ok, detail, notice = esdc_log(conn)
    assert ok == 1 and "portal=positive night 1 (ConnectTimeout)" in detail
    assert notice == LISTING_NOTICE.format(reason="ConnectTimeout")


def test_a_listing_the_portal_refuses_fails_the_first_night(conn, fake_client):
    # A 404 is an address that moved or a dataset withdrawn; waiting will not fix it.
    esdc.run(conn, fake_client(NEG_OK, max_attempts=1), now=NIGHTS[0])  # the positive listing answers 404
    ok, detail, notice = esdc_log(conn)
    assert ok == 0 and "positive listing: HTTP 404" in detail and "portal=" not in detail
    assert notice is None


def test_the_third_night_in_a_row_without_the_listing_is_a_failure(conn, fake_client):
    esdc.run(conn, outage(fake_client), now=NIGHTS[0])
    assert esdc_log(conn)["ok"] == 1
    # A retry run the same UTC day does not count a second night.
    esdc.run(conn, outage(fake_client), now="2026-11-08T06:04:00Z")
    ok, detail, notice = esdc_log(conn)
    assert ok == 1 and "portal=positive night 1 (HTTP 503)" in detail
    esdc.run(conn, outage(fake_client), now=NIGHTS[1])
    ok, detail, notice = esdc_log(conn)
    assert ok == 1 and "portal=positive night 2 (HTTP 503)" in detail and notice == LISTING_NOTICE.format(reason="HTTP 503")
    esdc.run(conn, outage(fake_client), now=NIGHTS[2])
    ok, detail, notice = esdc_log(conn)
    assert ok == 0 and "3 nights" in detail
    assert "failures=positive listing: the portal has not been readable for 3 nights (HTTP 503)" in detail
    assert notice is None


def test_a_night_the_listing_reads_sets_the_count_back(conn, fake_client):
    a = res("q1", "2026Q1", "2026-07-01T00:00:00")
    healthy = {POS_LISTING: listing(a), a["url"]: (HEADER + ROWS).encode(), **NEG_OK}
    esdc.run(conn, outage(fake_client), now=NIGHTS[0])
    assert get_meta(conn, "esdc_listing_read_at_positive") is None
    esdc.run(conn, fake_client(healthy), now=NIGHTS[1])
    ok, detail, notice = esdc_log(conn)
    assert ok == 1 and "portal=" not in detail and notice is None
    assert get_meta(conn, "esdc_listing_read_at_positive") == NIGHTS[1]
    esdc.run(conn, outage(fake_client), now=NIGHTS[2])
    ok, detail, notice = esdc_log(conn)
    assert ok == 1 and "portal=positive night 1 (HTTP 503)" in detail
    assert get_meta(conn, "esdc_listing_read_at_positive") == NIGHTS[1]


def test_a_file_the_portal_does_not_serve_tonight_is_a_notice_until_the_third_night(conn, fake_client):
    a = res("q1", "2026Q1", "2026-07-01T00:00:00")
    for night in NIGHTS[:2]:
        client = fake_client({POS_LISTING: listing(a), a["url"]: FakeResponse(503), **NEG_OK}, max_attempts=1)
        assert esdc.run(conn, client, now=night)["positive"] == 0
        ok, detail, notice = esdc_log(conn)
        assert ok == 1 and "portal=positive night" in detail and "(download: HTTP 503)" in detail
        assert notice == f"ESDC portal: {a['name']} could not be downloaded tonight (HTTP 503); tried again next run"
    client = fake_client({POS_LISTING: listing(a), a["url"]: FakeResponse(503), **NEG_OK}, max_attempts=1)
    esdc.run(conn, client, now=NIGHTS[2])
    ok, detail, notice = esdc_log(conn)
    assert ok == 0 and f"{a['name']}: the portal has not been readable for 3 nights (HTTP 503)" in detail
    assert notice is None


def test_a_file_the_portal_refuses_is_a_failure(conn, fake_client):
    a = res("q1", "2026Q1", "2026-07-01T00:00:00")
    client = fake_client({POS_LISTING: listing(a), **NEG_OK}, max_attempts=1)  # the file answers 404
    esdc.run(conn, client, now=NIGHTS[0])
    ok, detail, notice = esdc_log(conn)
    assert ok == 0 and f"{a['name']}: HTTP 404" in detail and "portal=" not in detail
    assert notice is None


def test_the_short_reason_for_a_notice():
    assert esdc.short_reason(FetchError("HTTP 404 for https://example.invalid/a.csv", status=404)) == "HTTP 404"
    timed_out = FetchError(
        "https://open.canada.ca/data/api/action/package_show?id=x: ReadTimeout(ReadTimeoutError(\"HTTPSConnectionPool("
        "host='open.canada.ca', port=443): Read timed out. (read timeout=60)\")) after 4 attempts", transient=True)
    assert esdc.short_reason(timed_out) == "ReadTimeout"
    assert esdc.short_reason(FetchError("x" * 100, transient=True)) == "x" * 60
    assert esdc.abort_reason(AbortRun("5 requests failed in a row; last HTTP 503 (https://open.canada.ca/x)")) == (
        "the portal stopped answering after 5 failed requests in a row")
    assert esdc.abort_reason(AbortRun(
        "open.canada.ca stopped accepting connections: 2 requests in a row could not connect; last ConnectTimeout(...)"
    )) == "the portal stopped answering after 2 failed requests in a row"
    assert esdc.abort_reason(AbortRun("something else")) == "the portal stopped answering"


def test_the_breaker_tripping_on_a_file_stops_every_esdc_request_for_the_night(conn, fake_client):
    files = [res(f"f{i}", f"2025Q{i}", f"2025-0{i + 1}-01T00:00:00") for i in (1, 2, 3)]
    trip = "the portal stopped answering after 2 failed requests in a row"
    for i, night in enumerate(NIGHTS, 1):
        client = fake_client({POS_LISTING: listing(*files), **{f["url"]: FakeResponse(503) for f in files}, **NEG_OK},
                             max_attempts=1, max_consecutive_failures=2)
        assert esdc.run(conn, client, now=night) == {"positive": 0, "negative": 0}
        # The listing, the first file (the breaker's first count) and the second (its trip); then
        # nothing: not the third file, not the negative listing.
        assert [url for url, _ in client.fake_session.calls] == [POS_LISTING, files[0]["url"], files[1]["url"]]
        ok, detail, notice = esdc_log(conn)
        if i < 3:
            assert ok == 1 and f"portal=positive night {i} (download: {trip}), negative not read" in detail
            assert notice.split(" | ") == [
                f"ESDC portal: {files[0]['name']} could not be downloaded tonight (HTTP 503); tried again next run",
                f"ESDC portal: {files[1]['name']} could not be downloaded tonight ({trip}); tried again next run",
            ]
    assert ok == 0 and f"{files[1]['name']}: the portal has not been readable for 3 nights ({trip})" in detail
    assert notice is None
    # Never reached: the negative list has no count of its own.
    assert get_meta(conn, "esdc_portal_misses_negative") is None


def test_the_breaker_tripping_on_the_listing_skips_the_other_listing(conn, fake_client):
    client = fake_client({POS_LISTING: FakeResponse(503), **NEG_OK}, max_attempts=1, max_consecutive_failures=1)
    esdc.run(conn, client, now=NIGHTS[0])
    assert [url for url, _ in client.fake_session.calls] == [POS_LISTING]
    trip = "the portal stopped answering after 1 failed request in a row"
    ok, detail, notice = esdc_log(conn)
    assert ok == 1 and f"portal=positive night 1 ({trip}), negative not read" in detail
    assert notice == LISTING_NOTICE.format(reason=trip)
    assert client._cache_entry(POS_LISTING) is None


def outdated(conn, *resources) -> None:
    """Load each resource under an older parser, with no copy in the download cache, so the reload asks the portal."""
    bodies = (HEADER + ROWS, HEADER + NEG_ROW + "\n")
    for r, body in zip(resources, bodies):
        esdc.load_resource(conn, "positive", r, body.encode())
    conn.execute("UPDATE esdc_resources SET parser_version = 0")
    conn.commit()


def test_a_reload_the_portal_does_not_serve_tonight_is_a_notice(conn, fake_client):
    q3 = res("q3", "2025Q3", "2026-01-01T00:00:00")
    outdated(conn, q3)
    client = fake_client({POS_LISTING: listing(q3), q3["url"]: FakeResponse(503), **NEG_OK}, max_attempts=1)
    esdc.run(conn, client, now=NIGHTS[0])
    ok, detail, notice = esdc_log(conn)
    assert ok == 1 and "portal=positive night 1 (download: HTTP 503)" in detail and "failures=" not in detail
    # The reload and the listing both asked for the file: one notice.
    assert notice == f"ESDC portal: {q3['name']} could not be downloaded tonight (HTTP 503); tried again next run"
    assert conn.execute("SELECT parser_version FROM esdc_resources").fetchone()[0] == 0


def test_a_reload_the_portal_refuses_is_a_failure(conn, fake_client):
    q3 = res("q3", "2025Q3", "2026-01-01T00:00:00")
    outdated(conn, q3)
    esdc.run(conn, fake_client({POS_LISTING: listing(q3), **NEG_OK}, max_attempts=1), now=NIGHTS[0])  # the file answers 404
    ok, detail, notice = esdc_log(conn)
    assert ok == 0 and "reload 2025Q3 positive: HTTP 404" in detail and "portal=" not in detail
    assert notice is None


def test_the_breaker_tripping_while_reloading_stops_the_stage_the_same_way(conn, fake_client):
    q3 = res("q3", "2025Q3", "2026-01-01T00:00:00")
    q4 = res("q4", "2025Q4", "2026-04-01T00:00:00")
    outdated(conn, q3, q4)
    trip = "the portal stopped answering after 2 failed requests in a row"
    for i, night in enumerate(NIGHTS, 1):
        client = fake_client({POS_LISTING: listing(q3, q4), q3["url"]: FakeResponse(503), q4["url"]: FakeResponse(503),
                              **NEG_OK}, max_attempts=1, max_consecutive_failures=2)
        esdc.run(conn, client, now=night)
        # The first outdated file is the breaker's first count, the second its trip: then neither listing.
        assert [url for url, _ in client.fake_session.calls] == [q3["url"], q4["url"]]
        ok, detail, notice = esdc_log(conn)
        if i < 3:
            assert ok == 1 and f"portal=positive night {i} (download: {trip}), negative not read" in detail
            assert notice.split(" | ") == [
                f"ESDC portal: {q3['name']} could not be downloaded tonight (HTTP 503); tried again next run",
                f"ESDC portal: {q4['name']} could not be downloaded tonight ({trip}); tried again next run",
            ]
    assert ok == 0 and f"{q4['name']}: the portal has not been readable for 3 nights ({trip})" in detail
    assert notice is None
    # Both keep their rows and their old version for a later night.
    assert {r[0] for r in conn.execute("SELECT parser_version FROM esdc_resources")} == {0}
    assert conn.execute("SELECT COUNT(*) FROM esdc_records").fetchone()[0] == 3


def test_a_pdf_behind_an_xlsx_link_fails_that_quarter_and_is_fetched_again_next_time(conn, fake_client):
    pdf = res("pdf", "2026Q1", "2026-07-01T00:00:00", ext="xlsx")
    good = res("q4", "2025Q4", "2026-04-01T00:00:00")
    client = fake_client({
        POS_LISTING: listing(pdf, good),
        NEG_LISTING: listing(),
        pdf["url"]: b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Type /Catalog >> endobj\n",
        good["url"]: (HEADER + ROWS).encode(),
    })
    totals = esdc.run(conn, client)
    assert totals["positive"] == 2
    ok, detail, _ = esdc_log(conn)
    assert ok == 0 and "no header row found" in detail
    assert client._cache_entry(pdf["url"]) is None


def test_a_renamed_employer_column_fails_loudly(conn, fake_client):
    renamed = res("ren", "2026Q1", "2026-07-01T00:00:00")
    client = fake_client({
        POS_LISTING: listing(renamed),
        NEG_LISTING: listing(),
        renamed["url"]: (HEADER.replace("Employer", "Business operating name") + ROWS).encode(),
    })
    assert esdc.run(conn, client)["positive"] == 0
    assert "no header row found" in esdc_log(conn)[1]


def test_an_extra_header_row_and_a_zero_row_quarter_load(conn, fake_client):
    extra = res("x", "2026Q1", "2026-07-01T00:00:00")
    empty = res("e", "2025Q4", "2026-04-01T00:00:00")
    client = fake_client({
        POS_LISTING: listing(extra, empty),
        **NEG_OK,
        extra["url"]: ("Title line,,,,,,\n" + HEADER + HEADER + ROWS).encode(),
        empty["url"]: HEADER.encode(),
    })
    assert esdc.run(conn, client)["positive"] == 2
    assert esdc_log(conn)[0] == 1
    loaded = {r[0]: r[1] for r in conn.execute("SELECT resource_id, rows_loaded FROM esdc_resources WHERE dataset = 'positive'")}
    assert loaded == {"x": 2, "e": 0}


def test_a_file_published_twice_is_loaded_once(conn, fake_client):
    # ESDC published the 2020 Q2 negative file a second time as 2021 Q2 (same
    # bytes, resource 4f9a23d3-...); loading both counted every row twice.
    first = res("2020q2", "2020Q2", "2020-09-24T00:00:00")
    copy = res("2021q2", "2021Q2", "2021-09-03T00:00:00")
    body = (HEADER + ROWS).encode()
    client = fake_client({POS_LISTING: listing(copy, first), **NEG_OK, first["url"]: body, copy["url"]: body})
    assert esdc.run(conn, client)["positive"] == 2
    ok, detail, _ = esdc_log(conn)
    assert ok == 1 and "duplicates=2021Q2 positive: same file as 2020Q2" in detail
    assert [tuple(r) for r in conn.execute("SELECT DISTINCT period FROM esdc_records WHERE list = 'positive'")] == [("2020Q2",)]


def test_a_copy_loaded_by_an_earlier_version_is_removed(conn, monkeypatch):
    first = res("2020q2", "2020Q2", "2020-09-24T00:00:00")
    copy = res("2021q2", "2021Q2", "2021-09-03T00:00:00")
    body = (HEADER + ROWS).encode()
    esdc.load_resource(conn, "positive", first, body)
    # What the loader did before it knew about copies: load the second as a quarter of its own.
    with monkeypatch.context() as m:
        m.setattr(esdc, "_earlier_twin", lambda *a: None)
        esdc.load_resource(conn, "positive", copy, body)
    assert conn.execute("SELECT COUNT(*) FROM esdc_records").fetchone()[0] == 4
    try:
        esdc.load_resource(conn, "positive", copy, body)
    except esdc.DuplicateFile:
        pass
    assert [tuple(r) for r in conn.execute("SELECT resource_id, COUNT(*) FROM esdc_records GROUP BY resource_id")] == [("2020q2", 2)]
    assert [r[0] for r in conn.execute("SELECT resource_id FROM esdc_resources")] == ["2020q2"]


def test_ircc_json_with_changed_keys_loads_nothing_and_raises_nothing():
    # The loader is not ours to change here; this pins what it does today so a
    # change in the source is noticed: zero rows, no exception.
    changed = {"data": [{"operating_name": "Acme", "legal": "Acme Inc", "why": "1"}]}
    assert ircc.parse_rows(changed, {}) == []
    renamed_fields = {"list": [{"bn_operating_name": "Acme", "reason": "<a>1</a>"}]}
    rows = ircc.parse_rows(renamed_fields, {"1": "Did not pay"})
    assert len(rows) == 1 and rows[0]["operating_name"] is None
