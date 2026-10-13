"""GitLab REST client. Phase one has a non-configurable remote-write barrier."""

import json
import os
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from rest_framework.exceptions import ValidationError

EXPECTED_EMAIL = "diogo.leonardo@warpcom.com"
BASE_URL = "https://gitlab.warpcom.com"
PROJECT_PATH = "serviceunit/django-apps/twinportal"
# A future, separately authorised release can enable outbound edits here.
REMOTE_WRITES_ALLOWED = False
_token = os.getenv("NOTETAKER_GITLAB_TOKEN", "")
_credential_lock = threading.Lock()


class GitLabError(Exception):
    """Safe error text without credentials or untrusted response bodies."""


class GitLabDisabled(GitLabError):
    """Abort pagination promptly when the local switch is turned off."""


class NoRedirects(HTTPRedirectHandler):
    """Never forward a personal access token to a redirect destination."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def set_token(value):
    """Replace only the in-memory credential; persistence belongs to Electron."""
    global _token
    if not isinstance(value, str) or len(value) > 4096 or any(c in value for c in "\r\n"):
        raise ValidationError({"detail": "Token inválido."})
    with _credential_lock:
        _token = value.strip()


def has_token():
    with _credential_lock:
        return bool(_token)


class GitLabClient:
    """Restrict authenticated requests to the configured HTTPS instance."""

    def __init__(self, connection):
        self.connection = connection
        self.opener = build_opener(NoRedirects())

    def request(self, path, method="GET", data=None, query=None):
        if self.connection.base_url.rstrip("/") != BASE_URL or not path.startswith("/") or urlsplit(path).netloc:
            raise GitLabError("Destino GitLab inválido.")
        if method != "GET" and (not REMOTE_WRITES_ALLOWED or not self.connection.enabled):
            raise GitLabError("Escritas no GitLab bloqueadas nesta fase.")
        self.connection.refresh_from_db(fields=["enabled"])
        if not self.connection.enabled:
            raise GitLabDisabled("Sincronização desativada.")
        with _credential_lock:
            credential = _token
        if not credential:
            raise GitLabError("Configura o token pessoal nas definições GitLab.")
        url = BASE_URL + "/api/v4" + path
        if query:
            url += "?" + urlencode(query, doseq=True)
        body = json.dumps(data).encode() if data is not None else None
        request = Request(url, data=body, method=method, headers={
            "PRIVATE-TOKEN": credential, "Accept": "application/json", "Content-Type": "application/json",
        })
        try:
            with self.opener.open(request, timeout=20) as response:
                return json.load(response), response.headers.get("X-Next-Page", "")
        except HTTPError as exc:
            messages = {401: "Token inválido ou expirado.", 403: "Sem permissão no GitLab.",
                        404: "Tarefa ou projeto indisponível.", 429: "Limite de pedidos atingido; será feita nova tentativa."}
            raise GitLabError(messages.get(exc.code, f"GitLab respondeu com HTTP {exc.code}.")) from exc
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            raise GitLabError("Não foi possível consultar o GitLab. Verifica VPN, rede e certificado.") from exc

    def get(self, path, **query):
        return self.request(path, query=query)[0]

    def pages(self, path, **query):
        """Follow numeric pagination headers without trusting remote URLs."""
        page = 1
        while True:
            values, next_page = self.request(path, query={**query, "per_page": 100, "page": page})
            if not isinstance(values, list):
                raise GitLabError("Resposta de paginação inválida.")
            yield from values
            if not next_page:
                return
            if not next_page.isdigit() or int(next_page) <= page:
                raise GitLabError("Paginação GitLab inválida.")
            page = int(next_page)

    def project(self):
        return self.get("/projects/" + quote(PROJECT_PATH, safe=""))

    def update_task(self, link, changes):
        """Send only field deltas; never replace unrelated remote labels."""
        payload = {key: value for key, value in changes.items() if key in {"title", "description"}}
        if "state" in changes:
            payload["state_event"] = "close" if changes["state"] == "closed" else "reopen"
        if "labels" in changes:
            before, after = set(link.snapshot.get("labels", [])), set(changes["labels"])
            if any("," in name for name in before | after):
                raise GitLabError("A API não permite alterar estas etiquetas com vírgulas.")
            added, removed = sorted(after - before), sorted(before - after)
            if added:
                payload["add_labels"] = ",".join(added)
            if removed:
                payload["remove_labels"] = ",".join(removed)
        if not payload:
            return None
        return self.request(f"/projects/{link.project_id}/issues/{link.issue_iid}", "PUT", payload)[0]
