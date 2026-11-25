from __future__ import annotations

from pathlib import Path

import pytest

from lmia_pipeline.db import connect
from lmia_pipeline.http import PoliteClient

FIXTURES = Path(__file__).resolve().parent / "fixtures"


class FakeResponse:
    def __init__(self, status: int, content: bytes = b"", headers: dict | None = None) -> None:
        self.status_code = status
        self.content = content
        self.headers = headers or {}


class FakeSession:
    """Serves bytes by exact URL; anything else is a 404. Records every call."""

    def __init__(self, mapping: dict[str, bytes | FakeResponse]) -> None:
        self.mapping = mapping
        self.calls: list[tuple[str, dict]] = []

    def get(self, url: str, headers: dict | None = None, timeout: float | None = None, stream: bool = False) -> FakeResponse:
        self.calls.append((url, headers or {}))
        value = self.mapping.get(url)
        if value is None:
            return FakeResponse(404)
        if isinstance(value, FakeResponse):
            return value
        return FakeResponse(200, value)


@pytest.fixture(autouse=True)
def _no_edge_check_key(monkeypatch):
    # A shell that holds the real key (to run edge_rules.py) must not lend it
    # to the tests: a test that wants a key sets its own.
    monkeypatch.delenv("EDGE_CHECK_KEY", raising=False)


@pytest.fixture
def conn():
    c = connect(memory=True)
    yield c
    c.close()


@pytest.fixture
def fixtures() -> Path:
    return FIXTURES


@pytest.fixture
def fake_client(tmp_path):
    def make(mapping: dict[str, bytes | FakeResponse], **kwargs) -> PoliteClient:
        session = FakeSession(mapping)
        client = PoliteClient(
            session=session, cache_dir=tmp_path / "cache", sleep=lambda s: None,
            clock=lambda: 0.0, **kwargs,
        )
        client.fake_session = session  # type: ignore[attr-defined]
        return client

    return make
