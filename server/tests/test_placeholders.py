"""Platzhalter des Grundgerüsts.

Solange ein Endpunkt noch nicht umgesetzt ist, antwortet er mit 501 im Vertragsformat.
Diese Datei schrumpft mit jedem umgesetzten Endpunkt und verschwindet am Ende von Runde 1.
"""

ID = "3f2b8c1e-5a47-4d09-9b6e-0c1d2e3f4a5b"


def test_placeholder_endpoints_answer_in_the_error_format(client):
    """Das Grundgerüst beantwortet alles außer /api/health mit 501 im Vertragsformat."""
    calls = [
        ("POST", "/api/auth/login", {"password": "x", "device_name": "Test"}),
        ("POST", "/api/auth/logout", None),
        ("GET", "/api/devices", None),
        ("PATCH", f"/api/devices/{ID}", {"name": "Neu"}),
        ("DELETE", f"/api/devices/{ID}", None),
        ("POST", "/api/sync", {}),
        ("GET", "/api/images/abc.jpg", None),
        ("GET", "/api/backup", None),
        ("GET", "/api/events", None),
    ]
    for method, path, body in calls:
        response = client.request(method, path, json=body)
        assert response.status_code == 501, (method, path, response.text)
        error = response.json()["error"]
        assert error["code"] == "not_implemented"
        assert error["message"]
        assert error["details"] is None
