import pytest
from pydantic import ValidationError

from app.services import get_file_service
from app.services.config import Settings


@pytest.mark.parametrize("secret", ["", "short-secret"])
def test_jwt_secret_must_be_at_least_32_bytes(secret):
    with pytest.raises(ValidationError, match="at least 32 bytes"):
        Settings(jwt_secret=secret)


def test_metadata_api_sends_security_headers(anon_client):
    response = anon_client.get("/health")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache, no-store, must-revalidate"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["cross-origin-resource-policy"] == "same-origin"


def test_cors_allows_only_configured_browser_origins(anon_client):
    allowed = anon_client.options(
        "/api/v1/files",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization",
        },
    )
    denied = anon_client.options(
        "/api/v1/files",
        headers={
            "Origin": "https://attacker.example",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "access-control-allow-credentials" not in allowed.headers
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers


def test_internal_exception_text_is_not_returned(client, monkeypatch):
    async def fail(*args, **kwargs):
        raise RuntimeError("database path and secret details")

    monkeypatch.setattr(get_file_service(), "list_files", fail)

    response = client.get("/api/v1/files")

    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error"}
    assert "database path" not in response.text
