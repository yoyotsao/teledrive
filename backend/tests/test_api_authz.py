"""Every endpoint, checked twice: is it authenticated, and is it scoped?

Feature suites check their own 401s and 404s, but a *new* endpoint is exactly
the thing no existing suite covers. The last test here enumerates the router at
runtime, so an endpoint added without an auth dependency fails this file even
though nobody wrote a test for it.
"""
import inspect

import pytest
from fastapi import params

from app.api.routes import router
from app.auth import get_current_user
from conftest import OWNER_B

# (route template, method, request path, json body) for every route that needs
# a token. The template is what the coverage test at the bottom matches against
# the router; the path is what the request actually goes to.
PROTECTED = [
    ("/api/v1/accounts", "GET", "/api/v1/accounts", None),
    ("/api/v1/accounts/challenge", "POST", "/api/v1/accounts/challenge", None),
    ("/api/v1/accounts/verify", "POST", "/api/v1/accounts/verify", {"nonce": "x"}),
    ("/api/v1/accounts/{tg_user_id}", "DELETE", "/api/v1/accounts/123", None),
    ("/api/v1/files/check-hash", "GET", "/api/v1/files/check-hash?hash=" + "a" * 64, None),
    ("/api/v1/files/check-hashes", "POST", "/api/v1/files/check-hashes", {"hashes": []}),
    ("/api/v1/files/register", "POST", "/api/v1/files/register", {
        "filename": "x.txt", "filesize": 1, "message_id": 1, "file_id": "x",
    }),
    ("/api/v1/files", "GET", "/api/v1/files", None),
    ("/api/v1/files", "DELETE", "/api/v1/files", None),
    ("/api/v1/files/{file_id}", "GET", "/api/v1/files/f1", None),
    ("/api/v1/files/{file_id}", "PATCH", "/api/v1/files/f1", {"filename": "y.txt"}),
    ("/api/v1/files/{file_id}", "DELETE", "/api/v1/files/f1", None),
    ("/api/v1/files/{file_id}/restore", "POST", "/api/v1/files/f1/restore", None),
    ("/api/v1/files/{file_id}/purge", "DELETE", "/api/v1/files/f1/purge", None),
    ("/api/v1/files/{file_id}/download", "GET", "/api/v1/files/f1/download", None),
    ("/api/v1/files/by-split-group/{split_group_id}", "GET", "/api/v1/files/by-split-group/grp", None),
    ("/api/v1/folders", "POST", "/api/v1/folders", {"name": "x"}),
    ("/api/v1/folders", "GET", "/api/v1/folders", None),
    ("/api/v1/folders/{folder_id}", "DELETE", "/api/v1/folders/f1", None),
]

# Deliberately reachable without a token: only the login handshake itself.
PUBLIC_PATHS = {
    "/api/v1/auth/challenge",
    "/api/v1/auth/verify",
    # Uses its own stricter guard: get_current_user deliberately rejects the
    # expired-but-still-signed token this endpoint must inspect.
    "/api/v1/auth/refresh",
}


@pytest.mark.parametrize(
    "template,method,path,body",
    PROTECTED,
    ids=["%s %s" % (m, t) for t, m, _, _ in PROTECTED],
)
def test_no_token_means_no_answer(anon_client, template, method, path, body):
    resp = anon_client.request(method, path, json=body)

    assert resp.status_code == 401, "%s %s answered %d" % (method, path, resp.status_code)


# Item endpoints, each hit against a file that belongs to the *other* drive.
CROSS_DRIVE = [
    ("GET", "/api/v1/files/b_file", None),
    ("PATCH", "/api/v1/files/b_file", {"filename": "mine.txt"}),
    ("DELETE", "/api/v1/files/b_file", None),
    ("POST", "/api/v1/files/b_file/restore", None),
    ("DELETE", "/api/v1/files/b_file/purge", None),
    ("GET", "/api/v1/files/b_file/download", None),
    ("DELETE", "/api/v1/folders/b_folder", None),
    ("GET", "/api/v1/files/by-split-group/b-grp", None),
]


@pytest.mark.parametrize(
    "method,path,body", CROSS_DRIVE, ids=["%s %s" % (m, p) for m, p, _ in CROSS_DRIVE]
)
def test_a_valid_token_still_stops_at_the_drive_boundary(client, make_file, method, path, body):
    """404 everywhere, never 403 or 200 — a status that varies by existence
    turns these endpoints into an oracle for probing other drives' file ids."""
    make_file("b_file", filename="theirs.txt", owner_id=OWNER_B, telegram_message_id=11,
              is_split_file=True, part_index=0, total_parts=1, split_group_id="b-grp")
    make_file("b_folder", is_dir=True, owner_id=OWNER_B)

    resp = client.request(method, path, json=body)

    assert resp.status_code == 404, "%s %s answered %d" % (method, path, resp.status_code)
    assert "theirs.txt" not in resp.text


def _requires_authentication(endpoint) -> bool:
    """True when one of the endpoint's parameters is Depends(get_current_user)."""
    for parameter in inspect.signature(endpoint).parameters.values():
        default = parameter.default
        if isinstance(default, params.Depends) and default.dependency is get_current_user:
            return True
    return False


def test_every_route_is_authenticated_unless_it_is_deliberately_public():
    """The guard for endpoints nobody has written a test for yet.

    Adding a route without `Depends(get_current_user)` fails here; making it
    public on purpose means adding it to PUBLIC_PATHS, which is a decision a
    reviewer can see in the diff.
    """
    unprotected = sorted(
        route.path
        for route in router.routes
        if route.path not in PUBLIC_PATHS and not _requires_authentication(route.endpoint)
    )

    assert unprotected == [], "routes reachable without a token: %s" % unprotected


def test_the_protected_list_above_covers_every_protected_route():
    """Keeps this file honest as routes are added: a new authenticated endpoint
    has to be listed in PROTECTED, or this fails."""
    declared = {template for template, _, _, _ in PROTECTED}
    actual = {
        route.path
        for route in router.routes
        if route.path not in PUBLIC_PATHS and _requires_authentication(route.endpoint)
    }

    assert actual - declared == set(), "not covered by test_no_token_means_no_answer"
