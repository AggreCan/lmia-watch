"""The monthly audience report, from summary rows and Search Console rows written here."""

from __future__ import annotations

import json
from datetime import date

from lmia_pipeline import cli, nightly, resilience, search_console as sc, views_report as vrep, views_rollup as vr
from lmia_pipeline import worker_metrics as wm


def summary_row(day: str, **values) -> dict:
    row = dict.fromkeys(vr.SUMMARY_HEADER, "")
    row.update(date=day, responses=1000, pages=500, api=0, downloads=0, forms=0, feeds=0, other=0, feed_subscribers=0,
               top_routes="")
    row.update(values)
    return row


def people(human: int, ca: int, us: int, desktop: int, mobile: int, routes: dict, uniques: int | str, visits: int | str):
    return dict(
        human_pages=human, bot_pages=900,
        human_by_country=json.dumps({"CA": ca, "US": us, "other": human - ca - us}),
        human_by_device=json.dumps({"desktop": desktop, "mobile": mobile, "tablet": human - desktop - mobile}),
        human_by_lang=json.dumps({"en": human}), human_by_route=json.dumps(routes),
        unique_visitors=uniques, human_visits=visits,
    )


ROWS = [
    # September: before the bot flag, the people columns blank.
    summary_row("2026-09-29", feed_subscribers=10, bluesky_followers=40),
    summary_row("2026-09-30", feed_subscribers=12, employers=165000, records=470000),
    # October: the 29th before the visitor code was set, then two full days.
    summary_row("2026-10-29", **people(100, 80, 10, 60, 30, {"/employers/:id": 70, "/": 30}, "", ""),
                feed_subscribers=15, bluesky_followers=50),
    summary_row("2026-10-30", **people(200, 150, 30, 120, 70, {"/employers/:id": 150, "/search": 50}, 120, 110),
                feed_subscribers=14, employers=166000, records=474000),
    summary_row("2026-10-31", **people(300, 240, 40, 150, 130, {"/employers/:id": 200, "/": 60, "/search": 40}, 180, 170),
                feed_subscribers=13, bluesky_followers=57, x_followers=31, employers=166497, records=474402),
]
SEARCH = [
    {"date": "2026-10-28", "clicks": "10", "impressions": "100", "ctr": "0.1", "position": "8.0", "top_queries": "[]"},
    {"date": "2026-10-29", "clicks": "20", "impressions": "300", "ctr": "0.066", "position": "4.0", "top_queries": "[]"},
    {"date": "2026-09-15", "clicks": "5", "impressions": "50", "ctr": "0.1", "position": "10.0", "top_queries": "[]"},
]


def write_files(tmp_path, rows=ROWS, search=SEARCH):
    summary = tmp_path / "summary.csv"
    vr._write_csv(summary, vr.SUMMARY_HEADER, rows)
    search_path = tmp_path / "search_console.csv"
    sc.write_file(search_path, search)
    return summary, search_path


def table_row(text: str, label: str) -> list[str]:
    line = next(ln for ln in text.splitlines() if ln.startswith(f"| {label} |"))
    return [cell.strip() for cell in line.strip("|").split("|")][1:]


def test_months():
    assert vrep.month_bounds("2026-02") == (date(2026, 2, 1), date(2026, 2, 28))
    assert vrep.month_bounds("2026-12") == (date(2026, 12, 1), date(2026, 12, 31))
    assert vrep.previous_months("2026-02") == ["2025-11", "2025-12", "2026-01", "2026-02"]
    assert vrep.report_month(date(2026, 11, 1)) == "2026-10"
    assert vrep.report_month(date(2027, 1, 31)) == "2026-12"


def test_the_report_puts_the_month_beside_the_three_before_it(tmp_path):
    summary, search = write_files(tmp_path)
    out = tmp_path / "out"
    assert vrep.run(out, "2026-10", date(2026, 11, 1), summary, search) == "written"
    text = (out / "report-2026-10.md").read_text(encoding="utf-8")
    assert text.startswith("# LMIA Watch audience report, 2026-10\n")
    assert "| Figure | 2026-07 | 2026-08 | 2026-09 | 2026-10 |" in text
    assert table_row(text, "Days in the roll-up") == ["0 of 31", "0 of 31", "2 of 30", "3 of 31"]
    assert table_row(text, "Days with people counted") == ["0 of 31", "0 of 31", "0 of 30", "3 of 31"]
    assert table_row(text, "Page views by people") == ["n/a", "n/a", "n/a", "600"]
    assert table_row(text, "Days with visitor counts") == ["0 of 31", "0 of 31", "0 of 30", "2 of 31"]
    assert table_row(text, "Unique visitors (visitor-days)") == ["n/a", "n/a", "n/a", "300"]
    assert table_row(text, "Visits") == ["n/a", "n/a", "n/a", "280"]
    assert table_row(text, "Canada share of people's page views")[-1] == "78.3%"  # 470 of 600
    assert table_row(text, "Desktop share")[-1] == "55.0%"  # 330 of 600
    assert table_row(text, "Mobile share")[-1] == "38.3%"  # 230 of 600
    assert table_row(text, "Tablet share")[-1] == "6.7%"
    assert table_row(text, "Days with search figures") == ["0 of 31", "0 of 31", "1 of 30", "2 of 31"]
    assert table_row(text, "Search clicks") == ["n/a", "n/a", "5", "30"]
    assert table_row(text, "Search impressions") == ["n/a", "n/a", "50", "400"]
    assert table_row(text, "Average search position") == ["n/a", "n/a", "10.0", "5.0"]  # (8x100 + 4x300) / 400
    assert table_row(text, "Feed subscribers (largest daily figure)") == ["n/a", "n/a", "12", "15"]
    assert table_row(text, "Bluesky followers (last reading)") == ["n/a", "n/a", "40", "57"]
    assert table_row(text, "X followers (last reading)") == ["n/a", "n/a", "n/a", "31"]
    assert table_row(text, "Employers (last reading)") == ["n/a", "n/a", "165,000", "166,497"]
    assert table_row(text, "Records (last reading)") == ["n/a", "n/a", "470,000", "474,402"]
    pages = text.split("## Top pages by people, 2026-10", 1)[1]
    assert "| `/employers/:id` | 420 | 70.0% |" in pages
    assert pages.index("`/employers/:id`") < pages.index("`/` ") < pages.index("`/search`")
    assert "## Definitions" in text
    for dash in (chr(0x2014), chr(0x2013)):  # no em or en dash in the report's prose
        assert dash not in text
    line = (out / "summary_line.txt").read_text(encoding="utf-8")
    assert line == ("2026-10: 600 page views by people; 300 visitor-days; 280 visits; Canada 78.3%; "
                    "search clicks 30, impressions 400 (views/report-2026-10.md)\n")


def test_the_report_waits_a_week_for_the_months_last_day(tmp_path):
    summary, search = write_files(tmp_path, rows=ROWS[:-1])
    out = tmp_path / "out"
    assert vrep.run(out, "2026-10", date(2026, 11, 1), summary, search) == "waiting"
    assert vrep.run(out, "2026-10", date(2026, 11, 7), summary, search) == "waiting"
    assert not (out / "report-2026-10.md").exists()
    assert vrep.run(out, "2026-10", date(2026, 11, 8), summary, search) == "written"
    assert table_row((out / "report-2026-10.md").read_text(encoding="utf-8"), "Days in the roll-up")[-1] == "2 of 31"


def test_no_rows_for_the_month_is_no_data_and_a_bad_summary_or_month_is_failed(tmp_path):
    summary, search = write_files(tmp_path, rows=ROWS[:2])
    out = tmp_path / "out"
    assert vrep.run(out, "2026-10", date(2026, 11, 1), summary, search) == "no data"
    assert vrep.run(out, "2026-10", date(2026, 11, 1), tmp_path / "missing.csv", None) == "no data"
    assert vrep.run(out, "2026-10", date(2026, 10, 31), summary, search) == "failed"  # not over
    assert vrep.run(out, "2026-13", date(2026, 11, 1), summary, search) == "failed"
    summary.write_text("date,visitors_ip\n2026-10-01,1\n", encoding="utf-8")
    assert vrep.run(out, "2026-10", date(2026, 11, 1), summary, search) == "failed"
    assert not list(out.glob("report-*.md"))


def test_without_search_console_the_search_rows_read_not_counted(tmp_path):
    summary, _ = write_files(tmp_path)
    out = tmp_path / "out"
    assert vrep.run(out, "2026-10", date(2026, 11, 1), summary, tmp_path / "absent.csv") == "written"
    text = (out / "report-2026-10.md").read_text(encoding="utf-8")
    assert table_row(text, "Search clicks") == ["n/a"] * 4
    assert "search clicks" not in (out / "summary_line.txt").read_text(encoding="utf-8")


def test_the_command_writes_its_outcome_and_exits_1_only_when_failed(tmp_path):
    summary, search = write_files(tmp_path)
    out = tmp_path / "out"
    args = ["views-report", "--summary", str(summary), "--search", str(search), "--out", str(out)]
    assert cli.main(args + ["--today", "2026-11-01"]) == 0
    assert (out / "outcome.txt").read_text(encoding="utf-8") == "written\n"
    assert (out / "report-2026-10.md").exists()
    assert cli.main(args + ["--today", "2026-10-31", "--month", "2026-10"]) == 1
    assert (out / "outcome.txt").read_text(encoding="utf-8") == "failed\n"
    assert cli.main(["views-report", "--summary", str(tmp_path / "none.csv"), "--out", str(out),
                     "--today", "2026-11-01"]) == 0
    assert (out / "outcome.txt").read_text(encoding="utf-8") == "no data\n"


def test_the_run_status_carries_the_report_and_only_failed_needs_attention(tmp_path):
    db = tmp_path / "none.sqlite"
    assert nightly.run_status(db, None, None, None, {}, views_report="written")["views_report"] == "written"
    assert nightly.run_status(db, None, None, None, {})["views_report"] == "not run"
    clean = {"stages": []}
    for quiet in ("written", "not due", "waiting", "no data", "not run"):
        assert resilience.attention_items({**clean, "views_report": quiet}) == [], quiet
    assert resilience.attention_items({**clean, "views_report": "failed"}) == [
        "Monthly audience report: failed (tried again next run)"]
    (tmp_path / "report.txt").write_text("not due\n", encoding="utf-8")
    out = tmp_path / "status.json"
    assert nightly.main(["status", "--db", str(db), "--views-report-outcome", str(tmp_path / "report.txt"),
                         "--out", str(out)]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["views_report"] == "not due"


# -- the Worker CPU table ---------------------------------------------------------


def worker_row(day: str, requests: int, cpu_ms: int, startup_ms: int) -> dict:
    row = dict.fromkeys(wm.HEADER, "")
    row.update(date=day, requests=str(requests), errors="0", subrequests="0", cpu_ms=str(cpu_ms),
               startup_cpu_ms=str(startup_ms))
    return row


WORKER = [
    worker_row("2026-09-30", 50_000, 400_000, 100_000),
    # October's even share of 30,000,000 ms is 967,742 a day: the 29th and 31st are above it.
    worker_row("2026-10-29", 100_000, 1_200_000, 300_000),
    worker_row("2026-10-30", 100_000, 900_000, 270_000),
    worker_row("2026-10-31", 200_000, 1_000_000, 250_000),
]


def write_worker(tmp_path, rows=WORKER):
    path = tmp_path / "worker_cpu.csv"
    wm.write_file(path, wm.derive(wm.merge([], rows)))
    return path


def with_cache(rows):
    # The page cache's columns on the 30th and 31st only, as if it was deployed on the 30th.
    cache = {"2026-10-30": (60, 40), "2026-10-31": (90, 10)}
    return [dict(r, page_cache_hits=cache[r["date"]][0], page_cache_misses=cache[r["date"]][1])
            if r["date"] in cache else r for r in rows]


def test_the_worker_cpu_table_sums_the_month_and_counts_the_days_against_the_pace(tmp_path):
    summary, search = write_files(tmp_path, rows=with_cache(ROWS))
    worker = write_worker(tmp_path)
    out = tmp_path / "out"
    assert vrep.run(out, "2026-10", date(2026, 11, 1), summary, search, worker) == "written"
    text = (out / "report-2026-10.md").read_text(encoding="utf-8")
    section = text.split("## Worker CPU\n\n", 1)[1].split("## Definitions", 1)[0]
    assert section.startswith("| Figure | 2026-07 | 2026-08 | 2026-09 | 2026-10 |")
    assert table_row(section, "Days with CPU figures") == ["0 of 31", "0 of 31", "1 of 30", "3 of 31"]
    assert table_row(section, "Worker requests") == ["n/a", "n/a", "50,000", "400,000"]
    assert table_row(section, "CPU time (ms)") == ["n/a", "n/a", "400,000", "3,100,000"]
    assert table_row(section, "Mean CPU time per request (ms)") == ["n/a", "n/a", "8.00", "7.75"]
    assert table_row(section, "Start-up share of CPU time")[-1] == "26.5%"  # 820,000 of 3,100,000
    assert table_row(section, "Included CPU time (ms)") == ["n/a", "n/a", "30,000,000", "30,000,000"]
    assert table_row(section, "Days above the included pace")[-1] == "2"
    assert table_row(section, "Days at or below the included pace")[-1] == "1"
    assert table_row(section, "Days with page cache figures") == ["0 of 31", "0 of 31", "0 of 30", "2 of 31"]
    assert table_row(section, "Page cache hit rate") == ["n/a", "n/a", "n/a", "75.0%"]  # 150 of 200
    assert "- Page cache hit rate:" in text and "- Included CPU time:" in text
    for dash in (chr(0x2014), chr(0x2013)):
        assert dash not in text


def test_without_the_worker_file_or_with_a_bad_one_the_cpu_rows_read_not_counted(tmp_path):
    summary, search = write_files(tmp_path)
    bad = tmp_path / "bad.csv"
    bad.write_text("date,visitor_ip\n2026-10-01,x\n", encoding="utf-8")
    for worker in (None, tmp_path / "absent.csv", bad):
        out = tmp_path / "out"
        assert vrep.run(out, "2026-10", date(2026, 11, 1), summary, search, worker) == "written", worker
        text = (out / "report-2026-10.md").read_text(encoding="utf-8")
        assert table_row(text, "CPU time (ms)") == ["n/a"] * 4
        assert table_row(text, "Page cache hit rate") == ["n/a"] * 4


def test_the_command_takes_the_worker_file(tmp_path):
    summary, search = write_files(tmp_path)
    worker = write_worker(tmp_path)
    out = tmp_path / "out"
    assert cli.main(["views-report", "--summary", str(summary), "--search", str(search), "--worker-cpu", str(worker),
                     "--out", str(out), "--today", "2026-11-01"]) == 0
    assert table_row((out / "report-2026-10.md").read_text(encoding="utf-8"), "CPU time (ms)")[-1] == "3,100,000"
