"""pipeline/scripts/edge_rules.py, the zone's WAF custom rules built from
site/src/edge_agents.json: the rules' shape, the check key kept out of
everything printed, the comparison with the zone, the API calls through a
fake session, and the refused crawlers kept equal to robots.txt's last group.
No test touches the network."""

import copy
import importlib.util
import json
from pathlib import Path

import pytest
import requests

from lmia_pipeline import config

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "pipeline" / "scripts" / "edge_rules.py"
ROBOTS = ROOT / "site" / "public" / "robots.txt"

spec = importlib.util.spec_from_file_location("edge_rules", SCRIPT)
er = importlib.util.module_from_spec(spec)
spec.loader.exec_module(er)

# Made-up secrets of the right form.
KEY = "0ddba11" + "13579bdf02468ace" * 3 + "123456789"
OTHER_KEY = "f" * 64
TOKEN = "waf-token-never-printed-0123456789"
ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353"
ENTRYPOINT = f"{er.API}/zones/{ZONE_ID}/rulesets/phases/{er.PHASE}/entrypoint"
ROBOTS_ONLY = {"google-extended", "applebot-extended"}


def rules(key=KEY, **kwargs):
    return er.build_rules(er.load_agents(), key, **kwargs)


# -- the rules --------------------------------------------------------------------


def test_the_header_and_the_key_form_are_the_pipelines():
    assert er.CHECK_HEADER == config.EDGE_CHECK_HEADER
    for sample in (KEY, KEY.upper(), KEY[:-1], KEY + "0", "g" * 64, "", KEY + "\n"):
        assert (er.KEY_RE.fullmatch(sample) is not None) == (config.EDGE_CHECK_KEY_RE.fullmatch(sample) is not None)


@pytest.mark.parametrize("key", ["", KEY[:-1], KEY + "a", KEY.upper(), "z" * 64, KEY[:-1] + '"', KEY + "\n",
                                 " " + KEY, KEY[:32] + " or true " + KEY[32:]])
def test_build_rules_rejects_a_key_that_is_not_64_hex(key):
    with pytest.raises(ValueError, match="64 lower-case hex characters"):
        rules(key)


def test_four_rules_in_order_and_three_without_the_challenge():
    built = rules()
    assert [r["ref"] for r in built] == ["check_key", "refused", "welcome", "challenge"]
    assert [r["action"] for r in built] == ["skip", "block", "skip", "managed_challenge"]
    assert all(r["enabled"] is True and r["description"] for r in built)
    assert [r["ref"] for r in rules(challenge=False)] == ["check_key", "refused", "welcome"]
    for rule in built + rules(challenge=False):
        assert 0 < len(rule["expression"]) <= er.MAX_EXPRESSION, rule["ref"]
    # The skips skip what follows in this phase; the Worker's own cache host is never refused or challenged.
    assert built[0]["action_parameters"] == built[2]["action_parameters"] == {"ruleset": "current"}
    assert f'http.host ne "{er.CACHE_HOST}"' in built[1]["expression"]
    assert built[3]["expression"] == f'(http.host ne "{er.CACHE_HOST}")'


def test_a_preview_name_opens_pages_only():
    # The files under /data/ are served before the Worker runs, so its
    # head-only answer never applies to them; a preview name that opened them
    # would open the records (seen live on 2026-11-25, then closed).
    welcome = {r["ref"]: r for r in rules()}["welcome"]["expression"]
    start = welcome.index('http.request.method in {"GET" "HEAD"} and not cf.client.bot')
    clause = welcome[start:]
    for prefix in er.PREVIEW_CLOSED_PREFIXES:
        assert f'not starts_with(http.request.uri.path, "{prefix}")' in clause
    assert set(er.PREVIEW_CLOSED_PREFIXES) == {"/data/", "/api/"}
    # The clause closes them before it names any fetcher.
    assert clause.index('"/api/"') < clause.index('contains "')


def test_the_key_is_in_the_first_rule_only():
    built = rules()
    assert built[0]["expression"] == f'(any(http.request.headers["{config.EDGE_CHECK_HEADER}"][*] eq "{KEY}"))'
    assert [KEY in json.dumps(r) for r in built] == [True, False, False, False]


def test_redact_removes_the_key():
    expression = rules()[0]["expression"]
    redacted = er.redact(expression, KEY)
    assert KEY not in redacted and '"<redacted>"' in redacted
    assert er.redact(expression, "") == expression
    assert er.redact(f"{TOKEN} and {KEY}", TOKEN, KEY) == "<redacted> and <redacted>"


def test_a_dry_run_never_prints_the_key(tmp_path, capsys, monkeypatch):
    key_file = tmp_path / "key.txt"
    key_file.write_text(KEY + "\n", encoding="utf-8")
    assert er.main(["--key-file", str(key_file), "--dry-run"]) == 0
    out, err = capsys.readouterr()
    assert KEY not in out + err
    assert [line.split(":")[0] for line in out.splitlines() if not line.startswith(" ")] == [
        "check_key", "refused", "welcome", "challenge"]
    assert "<redacted>" in out
    assert er.main(["--key-file", str(key_file), "--dry-run", "--without-challenge"]) == 0
    out, err = capsys.readouterr()
    assert KEY not in out + err and "challenge: managed_challenge" not in out
    # From the environment, as the workflow's secret would come.
    monkeypatch.setenv("EDGE_CHECK_KEY", KEY)
    assert er.main(["--dry-run"]) == 0
    out, err = capsys.readouterr()
    assert KEY not in out + err and out.startswith("check_key: skip")


def test_a_malformed_key_stops_before_anything_is_built(tmp_path, capsys):
    key_file = tmp_path / "key.txt"
    key_file.write_text(KEY.upper() + "\n", encoding="utf-8")
    assert er.main(["--key-file", str(key_file), "--dry-run"]) == 2
    out, err = capsys.readouterr()
    assert out == "" and err == "edge rules: the check key must be 64 lower-case hex characters\n"


# -- the lists ----------------------------------------------------------------------


def agents_file(tmp_path, **changes):
    data = json.loads(er.AGENTS_FILE.read_text(encoding="utf-8"))
    data.update(changes)
    path = tmp_path / "edge_agents.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_the_lists_load():
    agents = er.load_agents()
    assert set(agents) == {"refused", "tools", "preview", "verified_categories"}
    assert "lightpanda" in agents["tools"] and "Search Engine Crawler" in agents["verified_categories"]


@pytest.mark.parametrize("name, value", [
    ("refused", ["claudebot", "BadBot"]),
    ("tools", ["curl/", 'x" or true or "']),
    ("preview", ["slackbot", "back\\slash"]),
    ("refused", []),
    ("tools", ["curl/", ""]),
    ("preview", ["slackbot", 7]),
    ("verified_categories", "Search Engine Crawler"),
])
def test_load_agents_rejects_an_upper_case_quoted_or_malformed_entry(tmp_path, name, value):
    with pytest.raises(ValueError, match=name):
        er.load_agents(agents_file(tmp_path, **{name: value}))


def test_load_agents_rejects_a_missing_list(tmp_path):
    data = json.loads(er.AGENTS_FILE.read_text(encoding="utf-8"))
    del data["preview"]
    path = tmp_path / "edge_agents.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="preview"):
        er.load_agents(path)


def robots_groups(text):
    """(user agents, rules) for each group of a robots.txt, rules as
    (field, value) with the field lower-cased; comments and Sitemap lines
    left out."""
    groups, agents, rules_ = [], [], []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        field, value = (part.strip() for part in line.split(":", 1))
        field = field.lower()
        if field == "sitemap":
            continue
        if field == "user-agent":
            if rules_:
                groups.append((agents, rules_))
                agents, rules_ = [], []
            agents.append(value)
        elif agents:
            rules_.append((field, value))
    if agents:
        groups.append((agents, rules_))
    return groups


def test_robots_groups_reads_a_small_file():
    text = "# x\nUser-agent: *\nAllow: /\n\nUser-agent: A\nUser-agent: B # two\nDisallow: /\n\nSitemap: https://e/s.xml\n"
    assert robots_groups(text) == [(["*"], [("allow", "/")]), (["A", "B"], [("disallow", "/")])]


def test_the_refused_list_is_robots_txts_last_group():
    """The crawlers robots.txt refuses for AI training and large-scale
    scraping are the ones the edge blocks by name, apart from the two
    robots.txt-only tokens (Google-Extended and Applebot-Extended name no
    crawler; Google and Apple read them as a choice about training)."""
    agents, group_rules = robots_groups(ROBOTS.read_text(encoding="utf-8"))[-1]
    assert ("disallow", "/") in group_rules and [f for f, _ in group_rules] == ["disallow"]
    in_robots = {a.lower() for a in agents} - ROBOTS_ONLY
    refused = set(er.load_agents()["refused"])
    assert sorted(refused - in_robots) == [], "refused at the edge but missing from robots.txt's last group"
    assert sorted(in_robots - refused) == [], "in robots.txt's last group but not refused at the edge"


# -- the comparison with the zone ------------------------------------------------------


def as_live(built):
    """The rules as the API lists them: with the fields the zone adds."""
    live = copy.deepcopy(built)
    for n, rule in enumerate(live):
        rule.update(id=f"rule{n}", version="1", last_updated="2001-01-01T00:00:00Z")
    return live


def test_the_same_rules_show_no_difference():
    assert er.differences(rules(), as_live(rules())) == []


def test_differences_name_the_rule_and_field_without_the_expression():
    wanted = rules()
    changed = as_live(wanted)
    changed[1]["expression"] += ' or http.user_agent contains "x"'
    changed[3]["action"] = "block"
    problems = er.differences(wanted, changed)
    assert problems == ["rule refused: expression differs", "rule challenge: action differs"]
    # Another key in the zone's first rule: named, neither key printed.
    other = er.differences(wanted, as_live(rules(OTHER_KEY)))
    assert other == ["rule check_key: expression differs"]
    text = " ".join(problems + other)
    assert KEY not in text and OTHER_KEY not in text and "user_agent" not in text


def test_a_missing_or_extra_rule_is_named():
    wanted = rules()
    assert er.differences(wanted, as_live(wanted[:3])) == [
        "the zone has rules ['check_key', 'refused', 'welcome'], wanted ['check_key', 'refused', 'welcome', 'challenge']"]
    extra = as_live(wanted) + [{"ref": "by_hand", "action": "block", "expression": "(true)"}]
    assert er.differences(wanted, extra)[0].startswith("the zone has rules ['check_key', 'refused', 'welcome', "
                                                       "'challenge', 'by_hand']")


# -- the API ------------------------------------------------------------------------


class ApiResp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("not JSON")
        return self._payload


class FakeApi:
    """Answers each call from a queue, in order. Records every call."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def request(self, method, url, headers=None, timeout=None, **kwargs):
        self.calls.append({"method": method, "url": url, "headers": dict(headers or {}), **kwargs})
        return self.answers.pop(0)


def ok(result):
    return ApiResp(200, {"success": True, "errors": [], "result": result})


ZONES = ok([{"id": ZONE_ID, "name": "lmiawatch.ca"}])


def test_the_zone_id_is_looked_up_once_with_the_token_in_the_header_only():
    api = FakeApi(ZONES)
    zone = er.Zone(api, TOKEN)
    assert zone.zone_id() == ZONE_ID and zone.zone_id() == ZONE_ID
    assert len(api.calls) == 1
    call = api.calls[0]
    assert (call["method"], call["url"]) == ("GET", f"{er.API}/zones?name=lmiawatch.ca")
    assert call["headers"] == {"Authorization": f"Bearer {TOKEN}"} and TOKEN not in call["url"]


@pytest.mark.parametrize("zones", [[], [{"id": "a"}, {"id": "b"}]])
def test_a_token_that_sees_no_zone_or_two_raises(zones):
    with pytest.raises(RuntimeError, match=f"the token sees {len(zones)} zones named lmiawatch.ca"):
        er.Zone(FakeApi(ok(zones)), TOKEN).zone_id()


def test_put_rules_sends_the_rules_as_the_entrypoints_body():
    built = rules()
    api = FakeApi(ZONES, ok({"id": "rs", "rules": as_live(built)}))
    live = er.Zone(api, TOKEN).put_rules(built)
    assert [r["ref"] for r in live] == ["check_key", "refused", "welcome", "challenge"]
    put = api.calls[1]
    assert (put["method"], put["url"]) == ("PUT", ENTRYPOINT)
    assert put["json"] == {"rules": built}


def test_live_rules_reads_the_entrypoint():
    api = FakeApi(ZONES, ok({"id": "rs", "rules": as_live(rules())}))
    assert len(er.Zone(api, TOKEN).live_rules()) == 4
    assert (api.calls[1]["method"], api.calls[1]["url"]) == ("GET", ENTRYPOINT)


@pytest.mark.parametrize("answer, shown", [
    (ApiResp(403, {"success": False, "errors": [{"code": 10000, "message": f"Authentication error ({TOKEN})"}]}),
     "HTTP 403 Authentication error (<redacted>)"),
    (ApiResp(200, {"success": False, "errors": [{"code": 1, "message": "rule invalid"}]}), "HTTP 200 rule invalid"),
    (ApiResp(502), "HTTP 502"),
])
def test_an_api_error_raises_with_the_token_redacted(answer, shown):
    with pytest.raises(RuntimeError) as caught:
        er.Zone(FakeApi(answer), TOKEN).zone_id()
    assert shown in str(caught.value) and TOKEN not in str(caught.value)


def test_check_through_main_reports_without_the_secrets(tmp_path, monkeypatch, capsys):
    key_file, token_file = tmp_path / "key.txt", tmp_path / "token.txt"
    key_file.write_text(KEY + "\n", encoding="utf-8")
    token_file.write_text(TOKEN + "\n", encoding="utf-8")
    args = ["--key-file", str(key_file), "--token-file", str(token_file), "--check"]

    monkeypatch.setattr(requests, "Session", lambda: FakeApi(ZONES, ok({"rules": as_live(rules())})))
    assert er.main(args) == 0
    assert capsys.readouterr().out == "edge rules: the zone carries these 4 rules\n"

    # The zone still holds the first stage (no challenge): exit 1, the difference named.
    monkeypatch.setattr(requests, "Session", lambda: FakeApi(ZONES, ok({"rules": as_live(rules(challenge=False))})))
    assert er.main(args) == 1
    out, err = capsys.readouterr()
    assert "the zone differs from this file" in err and "wanted ['check_key', 'refused', 'welcome', 'challenge']" in err

    refusal = ApiResp(403, {"success": False, "errors": [{"code": 10000, "message": f"bad token {TOKEN} {KEY}"}]})
    monkeypatch.setattr(requests, "Session", lambda: FakeApi(refusal))
    assert er.main(args) == 1
    out, err = capsys.readouterr()
    assert "HTTP 403" in err and TOKEN not in out + err and KEY not in out + err


def test_without_a_token_nothing_is_asked(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("CLOUDFLARE_WAF_TOKEN", raising=False)
    monkeypatch.setenv("EDGE_CHECK_KEY", KEY)
    monkeypatch.setattr(requests, "Session", lambda: pytest.fail("no request without a token"))
    assert er.main(["--check"]) == 2
    assert "no token" in capsys.readouterr().err
