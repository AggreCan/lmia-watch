"""The site-only deploy: the bundle check that proves R2's static.tar.gz is
what the site serves, and the guard on .github/workflows/deploy-site.yml that
keeps that workflow from ever writing data.

The workflow checks are textual: PyYAML is not a dependency of the pipeline
(pyproject.toml), so the file is read line by line. Comment lines are left
out of every check; anything on a line that runs is in."""

import json
import re
from pathlib import Path

import pytest

from lmia_pipeline import nightly, resilience

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy-site.yml"
NIGHTLY = ROOT / ".github" / "workflows" / "nightly.yml"
BASE = "https://lmiawatch.example"
# A made-up edge check key of the right form.
KEY = "c0ffee" + "fedcba9876543210" * 3 + "beefcafe00"

STATS = {"data_as_of": "2026-10-22", "counts": {"employers": 166497}, "top_approvals": [{"employer_id": "emp-a000000005"}]}
FACETS = {"province": {"BC": 10, "ON": 12}, "status": {"approved": 20, "pending": 2}}
FIRST = {"rows": [{"key": 2, "name": "Example Farms Ltd", "positions": 4}], "total": 1}


class Resp:
    def __init__(self, status, content=b""):
        self.status_code = status
        self.content = content


class FakeHttp:
    """Answers by exact URL from a queue (the last answer repeats); an
    exception in the queue is raised. Records every call."""

    def __init__(self, routes):
        self.routes = {url: list(v) if isinstance(v, list) else [v] for url, v in routes.items()}
        self.calls = []

    def get(self, url, headers=None, timeout=None, **kwargs):
        self.calls.append((url, dict(headers or {})))
        queue = self.routes.get(url)
        if queue is None:
            return Resp(404)
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def close(self):
        pass


def body(data, **dump):
    return Resp(200, json.dumps(data, **dump).encode("utf-8"))


def make_bundle(folder, stats=STATS, facets=FACETS, first=FIRST):
    (folder / "search").mkdir(parents=True, exist_ok=True)
    for rel, data in (("stats.json", stats), ("search/facets.json", facets), ("search/first.json", first)):
        if data is not None:
            (folder / rel).write_text(json.dumps(data), encoding="utf-8")
    return folder


def live(**overrides):
    routes = {f"{BASE}/data/stats.json": body(STATS, indent=2),
              f"{BASE}/data/search/facets.json": body(FACETS),
              f"{BASE}/data/search/first.json": body(FIRST)}
    routes.update({f"{BASE}/data/{k.replace('__', '/')}": v for k, v in overrides.items()})
    return FakeHttp(routes)


def check(http, bundle, saved=None):
    waits = []
    record, live_stats = resilience.bundle_check(http, BASE, bundle, saved, sleep=waits.append, retry_after=10)
    return record, live_stats, waits


def results(record):
    return {(f["file"], f["against"]): f["result"] for f in record["files"]}


# -- the bundle check ----------------------------------------------------------


def test_an_archive_equal_to_the_live_files_passes(tmp_path):
    bundle = make_bundle(tmp_path / "static")
    # The live stats.json is laid out differently and its keys come in
    # another order; as parsed JSON it is the same value.
    http = live(**{"stats.json": Resp(200, json.dumps(dict(reversed(list(STATS.items()))), indent=4).encode())})
    record, live_stats, waits = check(http, bundle)
    assert record["ok"] is True and waits == []
    assert [f["result"] for f in record["files"]] == ["same", "same", "same"]
    assert [u for u, _ in http.calls] == [f"{BASE}/data/{rel}" for rel in resilience.BUNDLE_FILES]
    assert all(h["User-Agent"].startswith("LMIAWatch/") and h["Cache-Control"] == "no-cache" for _, h in http.calls)
    assert json.loads(live_stats) == STATS


@pytest.mark.parametrize("rel, changed", [
    ("stats.json", dict(STATS, data_as_of="2026-10-23")),
    ("search/facets.json", dict(FACETS, province={"BC": 10, "ON": 13})),
    # A change of type is a difference even where Python would call it equal.
    ("search/first.json", dict(FIRST, total=True)),
    ("search/first.json", dict(FIRST, total=1.0)),
])
def test_a_file_that_differs_fails_and_is_named(tmp_path, rel, changed):
    bundle = make_bundle(tmp_path / "static")
    http = live(**{rel.replace("/", "__"): body(changed)})
    record, _, _ = check(http, bundle)
    assert record["ok"] is False
    bad = [f for f in record["files"] if f["result"] != "same"]
    assert [(f["file"], f["result"]) for f in bad] == [(rel, "differs")]
    assert bad[0]["note"] == f"{rel}: the archive and {BASE}/data/{rel} differ"


def test_a_file_missing_from_the_archive_fails_without_asking_the_site(tmp_path):
    bundle = make_bundle(tmp_path / "static", facets=None)
    http = live()
    record, _, _ = check(http, bundle)
    assert record["ok"] is False
    assert results(record)[("search/facets.json", f"{BASE}/data/search/facets.json")] == "missing"
    assert [f["note"] for f in record["files"] if f["result"] == "missing"] == ["search/facets.json: not in the archive"]
    assert f"{BASE}/data/search/facets.json" not in [u for u, _ in http.calls]


def test_a_file_the_site_does_not_serve_fails(tmp_path):
    bundle = make_bundle(tmp_path / "static")
    record, _, waits = check(FakeHttp({f"{BASE}/data/stats.json": body(STATS),
                                       f"{BASE}/data/search/facets.json": body(FACETS)}), bundle)
    assert record["ok"] is False
    first = [f for f in record["files"] if f["file"] == "search/first.json"][0]
    assert first["result"] == "unreachable" and first["note"] == f"search/first.json: {BASE}/data/search/first.json answered 404"
    assert waits == [10]


@pytest.mark.parametrize("answer, note", [
    (Resp(503, b"busy"), "answered 503"),
    (Resp(403, b"<title>Attention Required! | Cloudflare</title>"), "answered 403"),
    (ConnectionError("no route to host"), "no answer (ConnectionError)"),
])
def test_an_http_error_fails_after_one_more_try(tmp_path, answer, note):
    bundle = make_bundle(tmp_path / "static")
    http = live(**{"stats.json": answer})
    record, live_stats, waits = check(http, bundle)
    assert record["ok"] is False and live_stats is None
    stats = [f for f in record["files"] if f["file"] == "stats.json"][0]
    assert stats["result"] == "unreachable" and stats["note"].endswith(note)
    assert waits == [10] and [u for u, _ in http.calls].count(f"{BASE}/data/stats.json") == 2


def test_an_error_that_clears_on_the_second_try_passes(tmp_path):
    bundle = make_bundle(tmp_path / "static")
    http = live(**{"search__first.json": [Resp(502, b"bad gateway"), body(FIRST)]})
    record, _, waits = check(http, bundle)
    assert record["ok"] is True and waits == [10]


def test_a_body_that_is_not_json_fails(tmp_path):
    bundle = make_bundle(tmp_path / "static")
    (bundle / "search" / "first.json").write_text("{not json", encoding="utf-8")
    http = live(**{"stats.json": Resp(200, b"<html>a page, not the file</html>")})
    record, _, _ = check(http, bundle)
    notes = {f["file"]: f["note"] for f in record["files"] if f["result"] == "unreadable"}
    assert record["ok"] is False
    assert notes == {"stats.json": f"stats.json: {BASE}/data/stats.json is not JSON",
                     "search/first.json": "search/first.json: the archive's copy is not JSON"}


def test_the_saved_stats_are_compared_as_well(tmp_path):
    bundle = make_bundle(tmp_path / "static")
    saved = tmp_path / "stats.before.json"
    saved.write_bytes(json.dumps(STATS, indent=2).encode())
    record, _, _ = check(live(), bundle, saved)
    assert record["ok"] is True
    assert results(record)[("stats.json", resilience.SAVED_LABEL)] == "same"
    saved.write_bytes(json.dumps(dict(STATS, data_as_of="2026-10-21")).encode())
    record, _, _ = check(live(), bundle, saved)
    assert record["ok"] is False
    assert results(record)[("stats.json", resilience.SAVED_LABEL)] == "differs"
    record, _, _ = check(live(), bundle, tmp_path / "never-written.json")
    assert record["ok"] is False
    assert results(record)[("stats.json", resilience.SAVED_LABEL)] == "unreachable"


def test_site_bundle_check_command(tmp_path, monkeypatch, caplog):
    bundle = make_bundle(tmp_path / "static")
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    kept = tmp_path / "work" / "stats.before.json"
    monkeypatch.setattr(nightly, "_session", lambda: live())
    args = ["site-bundle-check", "--bundle", str(bundle), "--base-url", BASE, "--retry-after", "0"]
    assert nightly.main(args + ["--keep-live-stats", str(kept), "--title", "Before the deploy"]) == 0
    assert json.loads(kept.read_bytes()) == STATS
    text = summary.read_text(encoding="utf-8")
    assert text.startswith("#### Before the deploy\n") and text.count("| same |") == 3

    # After the deploy: the live facets changed, so the command fails, names
    # the file in the log and the summary, and keeps nothing.
    monkeypatch.setattr(nightly, "_session", lambda: live(**{"search__facets.json": body({"province": {}})}))
    kept.unlink()
    assert nightly.main(args + ["--saved-stats", str(tmp_path / "work" / "missing.json"),
                                "--keep-live-stats", str(kept)]) == 1
    assert not kept.exists()
    assert f"search/facets.json: the archive and {BASE}/data/search/facets.json differ" in caplog.text
    text = summary.read_text(encoding="utf-8")
    assert "| search/facets.json | https://lmiawatch.example/data/search/facets.json | differs |" in text
    assert "| stats.json | the copy saved before the deploy | unreachable |" in text
    assert "2 of 4 comparisons failed" in text


# -- the workflow guard ----------------------------------------------------------

# EDGE_CHECK_KEY writes nothing anywhere: it only lets the checks of the live
# site past the edge's challenge.
ALLOWED_SECRETS = {"CLOUDFLARE_SITE_DEPLOY_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "EDGE_CHECK_KEY"}
KEY_LINE = "EDGE_CHECK_KEY: ${{ secrets.EDGE_CHECK_KEY }}"
ALLOWED_ACTIONS = {"actions/checkout@v4", "actions/setup-python@v5", "actions/setup-node@v4"}
TOKEN_LINE = "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_SITE_DEPLOY_TOKEN }}"
WRANGLER_ENV = "WRANGLER: ${{ github.workspace }}/site/node_modules/.bin/wrangler"
# Every form a Wrangler call may take, matched against what follows "$WRANGLER".
ALLOWED_WRANGLER = {
    "r2 object get": re.compile(r'r2 object get --remote "\$BUCKET/static\.tar\.gz" --file "\$WORK/static\.tar\.gz" '),
    "deployments status": re.compile(r"deployments status --json "),
    "deploy": re.compile(r"deploy; "),
    "rollback": re.compile(r'rollback "\$VERSION_ID" --message "[^"$`\\]*" --yes; '),
}
ALLOWED_NIGHTLY = {"live-version", "smoke", "site-bundle-check"}
FORBIDDEN = [
    ("r2 object put", re.compile(r"r2\s+object\s+put")),
    ("r2 object delete", re.compile(r"r2\s+object\s+delete")),
    ("r2 bucket", re.compile(r"r2\s+bucket")),
    ("a d1 command", re.compile(r"(?<![\w-])d1\s")),
    ("the pipeline's main command line", re.compile(r"lmia_pipeline\.cli|python3?\s+-m\s+lmia_pipeline(?![.\w])")),
    ("a nightly command that writes state", re.compile(r"lmia_pipeline\.nightly\s+(pack|status|attention|gate|restore|verify|checks)\b")),
    ("git push", re.compile(r"git\s+push")),
    ("git commit", re.compile(r"git\s+commit")),
    ("any git command", re.compile(r"(?<![\w/-])git\s")),
    ("the nightly's token", re.compile(r"secrets\.CLOUDFLARE_API_TOKEN|CF_API_TOKEN")),
    ("the GitHub token", re.compile(r"github\.token|GITHUB_TOKEN|GH_TOKEN")),
    ("the Cloudflare API called directly", re.compile(r"api\.cloudflare\.com")),
    ("curl or wget", re.compile(r"(?<![\w-])(curl|wget)\s")),
    ("npx", re.compile(r"(?<![\w-])npx\s")),
    ("an npm command other than npm ci", re.compile(r"(?<![\w-])npm\s+(?!ci\s*$)")),
    ("a pip command other than the pipeline install", re.compile(r"(?<![\w-])pip3?\s+(?!install -e \./pipeline\s*$)")),
    ("python other than the allowed nightly commands",
     re.compile(r"(?<![\w-])python3?\s+(?!-m lmia_pipeline\.nightly (?:live-version|smoke|site-bundle-check)\s)")),
    ("node", re.compile(r"(?<![\w-])node\s")),
    ("the gh command", re.compile(r"(?<![\w-])gh\s")),
    ("LAST_RUN.md", re.compile(r"LAST_RUN")),
    ("status.json", re.compile(r"status\.json")),
    ("a reusable workflow", re.compile(r"workflow_call|secrets:\s*inherit")),
]


def code_lines(text):
    """The lines that do something: blank lines and comment lines dropped."""
    return [line.rstrip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def top_block(text, key):
    """(header line, the indented lines under it) for a top-level key."""
    header, block, inside = None, [], False
    for line in code_lines(text):
        if not line[0].isspace():
            inside = line.split(":", 1)[0].strip() == key
            if inside:
                header = line
            continue
        if inside:
            block.append(line)
    return header, block


def child_keys(block):
    if not block:
        return []
    indent = min(len(line) - len(line.lstrip()) for line in block)
    return [line.strip().split(":", 1)[0] for line in block if len(line) - len(line.lstrip()) == indent]


def wrangler_calls(line):
    """What follows each "$WRANGLER" on the line, with a space after it so a
    form ending the line still matches."""
    return [part.strip() + " " for part in re.split(r'"\$WRANGLER"|\$\{WRANGLER\}|\$WRANGLER\b', line)[1:]]


def workflow_problems(text, nightly_text=None):
    problems = []
    lines = code_lines(text)

    header, block = top_block(text, "on")
    if header != "on:" or child_keys(block) != ["workflow_dispatch"]:
        problems.append(f"the only trigger must be workflow_dispatch (found {header!r} {child_keys(block)})")
    header, block = top_block(text, "permissions")
    if header != "permissions:" or [line.strip() for line in block] != ["contents: read"]:
        problems.append("permissions must be contents: read and nothing else")
    if sum(1 for line in lines if re.match(r"\s*permissions\s*:", line)) != 1:
        problems.append("permissions must be set once, at the top")
    header, block = top_block(text, "concurrency")
    if [line.strip() for line in block] != ["group: nightly", "cancel-in-progress: false"]:
        problems.append("concurrency must be the nightly's group, never cancelling")
    if nightly_text is not None:
        _, nblock = top_block(nightly_text, "concurrency")
        if "group: nightly" not in [line.strip() for line in nblock]:
            problems.append("nightly.yml no longer uses the group nightly, so the two could overlap")

    for line in lines:
        for label, pattern in FORBIDDEN:
            if pattern.search(line):
                problems.append(f"{label}: {line.strip()}")
        for name in re.findall(r"secrets\.([A-Za-z0-9_]+)", line):
            if name not in ALLOWED_SECRETS:
                problems.append(f"secret {name} is not one this workflow may read: {line.strip()}")
        if "CLOUDFLARE_API_TOKEN" in line and line.strip() != TOKEN_LINE:
            problems.append(f"CLOUDFLARE_API_TOKEN may only be set from the site deploy token: {line.strip()}")
        used = re.match(r"\s*(?:-\s+)?uses:\s*(\S+)", line)
        if used and used.group(1) not in ALLOWED_ACTIONS:
            problems.append(f"action {used.group(1)} is not allowed")
        if "wrangler" in line.lower() and line.strip() != WRANGLER_ENV:
            calls = wrangler_calls(line)
            if not calls:
                problems.append(f"a Wrangler call not through the pinned $WRANGLER: {line.strip()}")
            for call in calls:
                if not any(form.match(call) for form in ALLOWED_WRANGLER.values()):
                    problems.append(f"a Wrangler command outside the allowed forms: {call.strip()}")
        for sub in re.findall(r"lmia_pipeline\.nightly\s+(\S+)", line):
            if sub not in ALLOWED_NIGHTLY:
                problems.append(f"nightly command {sub} is not allowed")
        if "EDGE_CHECK_KEY" in line and line.strip() != KEY_LINE:
            problems.append(f"EDGE_CHECK_KEY may only be set from its secret: {line.strip()}")
    # The check key goes to the steps that fetch the live site and to no other.
    head, _, body = text.partition("\n    steps:\n")
    if any("EDGE_CHECK_KEY" in line for line in code_lines(head)):
        problems.append("EDGE_CHECK_KEY must not be in the job's environment")
    for step in re.split(r"\n      - ", body):
        code = "\n".join(code_lines(step))
        reads_site = re.search(r"lmia_pipeline\.nightly (smoke|site-bundle-check)\s", code) is not None
        if ("EDGE_CHECK_KEY" in code) != reads_site:
            problems.append("the check key must reach exactly the steps that fetch the live site: "
                            + (step.splitlines() or [""])[0])
    if sum(1 for line in lines if line.strip() == WRANGLER_ENV) != 1:
        problems.append("WRANGLER must be defined once, as the site's pinned binary")
    if [line.strip() for line in lines if line.strip().startswith("BUCKET:")] != ["BUCKET: lmia-watch-data"]:
        problems.append("BUCKET must be lmia-watch-data, defined once")
    return problems


def test_the_site_deploy_workflow_cannot_write_data():
    text = WORKFLOW.read_text(encoding="utf-8")
    assert workflow_problems(text, NIGHTLY.read_text(encoding="utf-8")) == []


def test_the_workflow_uses_every_allowed_wrangler_form_and_the_three_helpers():
    calls = [call for line in code_lines(WORKFLOW.read_text(encoding="utf-8")) for call in wrangler_calls(line)]
    found = {name for call in calls for name, form in ALLOWED_WRANGLER.items() if form.match(call)}
    assert found == set(ALLOWED_WRANGLER)
    assert len(calls) == 5  # get, status before, deploy, rollback, status after
    subs = set(re.findall(r"lmia_pipeline\.nightly\s+(\S+)", WORKFLOW.read_text(encoding="utf-8")))
    assert subs == ALLOWED_NIGHTLY


def test_the_deploy_token_reaches_only_the_steps_that_call_wrangler():
    text = WORKFLOW.read_text(encoding="utf-8")
    steps = re.split(r"\n      - ", text.split("\n    steps:\n", 1)[1])
    for step in steps:
        has_token = TOKEN_LINE in step
        calls_wrangler = '"$WRANGLER"' in step
        assert has_token == calls_wrangler, step.splitlines()[0]
    # The job's own environment carries no token, so npm ci and pip never see it.
    job_env = text.split("\n    env:\n", 1)[1].split("\n    steps:\n", 1)[0]
    assert "CLOUDFLARE_API_TOKEN" not in job_env


def test_the_check_key_reaches_only_the_steps_that_read_the_live_site():
    text = WORKFLOW.read_text(encoding="utf-8")
    steps = re.split(r"\n      - ", text.split("\n    steps:\n", 1)[1])
    readers = 0
    for step in steps:
        code = "\n".join(code_lines(step))
        reads_site = re.search(r"lmia_pipeline\.nightly (smoke|site-bundle-check)\s", code) is not None
        readers += reads_site
        assert (KEY_LINE in code) == reads_site, step.splitlines()[0]
    assert readers == 4
    assert sum(1 for line in code_lines(text) if "EDGE_CHECK_KEY" in line) == 4
    assert all(line.strip() == KEY_LINE for line in code_lines(text) if "EDGE_CHECK_KEY" in line)


def test_the_bundle_check_sends_the_check_key_to_the_site_only(tmp_path):
    bundle = make_bundle(tmp_path / "static")
    http = live()
    record, _ = resilience.bundle_check(http, BASE, bundle, sleep=lambda s: None, env={"EDGE_CHECK_KEY": KEY})
    assert record["ok"] is True and len(http.calls) == 3
    assert all(h["x-lmiawatch-check"] == KEY for _, h in http.calls)
    assert KEY not in json.dumps(record)
    # Without the key, or with one that is not 64 lower-case hex characters, nothing is sent.
    for env in ({}, {"EDGE_CHECK_KEY": KEY.upper()}):
        http = live()
        resilience.bundle_check(http, BASE, bundle, sleep=lambda s: None, env=env)
        assert all("x-lmiawatch-check" not in h for _, h in http.calls)


def test_site_bundle_check_command_never_prints_the_key(tmp_path, monkeypatch, caplog, capsys):
    bundle = make_bundle(tmp_path / "static")
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    monkeypatch.setenv("EDGE_CHECK_KEY", KEY)
    http = live(**{"search__facets.json": body({"province": {}})})
    monkeypatch.setattr(nightly, "_session", lambda: http)
    assert nightly.main(["site-bundle-check", "--bundle", str(bundle), "--base-url", BASE, "--retry-after", "0"]) == 1
    assert all(h["x-lmiawatch-check"] == KEY for _, h in http.calls)
    for text in (caplog.text, capsys.readouterr().out, summary.read_text(encoding="utf-8")):
        assert KEY not in text


def test_the_workflow_text_has_no_em_dashes():
    assert "\u2014" not in WORKFLOW.read_text(encoding="utf-8")


PLANTED = [
    ("a push trigger", "on:\n  workflow_dispatch:", "on:\n  push:\n  workflow_dispatch:"),
    ("a schedule", "on:\n  workflow_dispatch:", "on:\n  schedule:\n    - cron: \"0 3 * * *\"\n  workflow_dispatch:"),
    ("write permission", "  contents: read", "  contents: write"),
    ("another group", "  group: nightly", "  group: site"),
    ("an R2 upload", '          ls -l "$WORK/static.tar.gz"',
     '          "$WRANGLER" r2 object put --remote "$BUCKET/static.tar.gz" --file "$WORK/static.tar.gz"'),
    ("an R2 delete through npx", "        run: npm ci", "        run: npx wrangler r2 object delete --remote lmia-watch-data/status.json"),
    ("a D1 command", '          ls -l "$WORK/static.tar.gz"',
     '          "$WRANGLER" d1 execute lmia-watch --remote --command "DELETE FROM corrections"'),
    ("a second command on a line", '            if "$WRANGLER" deploy; then exit 0; fi',
     '            if "$WRANGLER" deploy; then "$WRANGLER" r2 bucket delete lmia-watch-data; fi'),
    ("deploy flags", '            if "$WRANGLER" deploy; then exit 0; fi', '            if "$WRANGLER" deploy --assets ../other; then exit 0; fi'),
    ("the nightly's token", TOKEN_LINE, "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}"),
    ("a state-writing nightly command", "--out \"$WORK/version_before.txt\"",
     "--out \"$WORK/version_before.txt\"; python -m lmia_pipeline.nightly status --db x --out y"),
    ("the pipeline run", "        run: pip install -e ./pipeline",
     "        run: pip install -e ./pipeline && python -m lmia_pipeline run --db data/lmia.sqlite"),
    ("a commit", "          test -s \"$WORK/stats.before.json\"", "          git commit -am x && git push"),
    ("a direct API call", "          test -s \"$WORK/stats.before.json\"",
     "          curl -X PUT https://api.cloudflare.com/client/v4/accounts/x/r2/buckets/lmia-watch-data/objects/x"),
    ("another secret", "REASON: ${{ inputs.reason }}", "REASON: ${{ secrets.ZENODO_TOKEN }}"),
    ("the check key on a step that does not read the site", "        working-directory: site\n        run: npm ci",
     "        working-directory: site\n        env:\n          EDGE_CHECK_KEY: ${{ secrets.EDGE_CHECK_KEY }}\n        run: npm ci"),
    ("the check key in the job's environment", "      BUCKET: lmia-watch-data\n",
     "      BUCKET: lmia-watch-data\n      EDGE_CHECK_KEY: ${{ secrets.EDGE_CHECK_KEY }}\n"),
    ("the check key from somewhere else", "          EDGE_CHECK_KEY: ${{ secrets.EDGE_CHECK_KEY }}",
     "          EDGE_CHECK_KEY: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"),
    ("another action", "      - uses: actions/checkout@v4", "      - uses: ./.github/workflows/nightly.yml"),
]


@pytest.mark.parametrize("label, old, new", PLANTED, ids=[p[0] for p in PLANTED])
def test_the_guard_catches_a_planted_change(label, old, new):
    text = WORKFLOW.read_text(encoding="utf-8")
    assert old in text, f"the anchor for {label} is gone from the workflow"
    assert workflow_problems(text.replace(old, new, 1)) != []
