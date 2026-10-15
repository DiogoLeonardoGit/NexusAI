"""GitLab REST client with persistent opt-in and per-client write permission."""

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
WRITE_SETTING = "gitlab_write_enabled"
_token = os.getenv("NOTETAKER_GITLAB_TOKEN", "")
_credential_lock = threading.Lock()


def writes_enabled():
    """Missing or malformed preferences always keep remote writes blocked."""
    from notetaker.models import AppSetting
    return AppSetting.objects.filter(key=WRITE_SETTING).values_list("value", flat=True).first() is True


class GitLabError(Exception):
    """Safe error text without credentials or untrusted response bodies."""


class GitLabDisabled(GitLabError):
    """Abort pagination promptly when the local switch is turned off."""


class GitLabCreateUncertain(GitLabError):
    """A create request may have reached GitLab; repeating it could duplicate an issue."""


class GitLabTimeUncertain(GitLabError):
    """An additive time request may have succeeded and must not be replayed blindly."""


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

    def __init__(self, connection, *, allow_writes=False):
        self.connection = connection
        self.allow_writes = allow_writes
        self.opener = build_opener(NoRedirects())

    def request(self, path, method="GET", data=None, query=None):
        if self.connection.base_url.rstrip("/") != BASE_URL or not path.startswith("/") or urlsplit(path).netloc:
            raise GitLabError("Destino GitLab inválido.")
        self.connection.refresh_from_db(fields=["enabled"])
        if not self.connection.enabled:
            raise GitLabDisabled("Sincronização desativada.")
        if method != "GET" and (not self.allow_writes or not writes_enabled()):
            raise GitLabError("Escrita desativada ou pedido de escrita não autorizado.")
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
            if method == "POST" and path.endswith("/add_spent_time") and exc.code >= 500:
                raise GitLabTimeUncertain("O envio de tempo ficou incerto. Verifica o GitLab antes de repetir o registo.") from exc
            if method == "POST" and path.endswith("/issues") and exc.code >= 500:
                raise GitLabCreateUncertain("A resposta à criação ficou incerta. Verifica o GitLab antes de tentar novamente.") from exc
            messages = {401: "Token inválido ou expirado.", 403: "Sem permissão no GitLab.",
                        404: "Tarefa ou projeto indisponível.", 429: "Limite de pedidos atingido; será feita nova tentativa."}
            if method == "POST" and (path.endswith("/issues") or path.endswith("/add_spent_time")):
                messages[429] = "Limite de pedidos atingido. Tenta novamente mais tarde."
            raise GitLabError(messages.get(exc.code, f"GitLab respondeu com HTTP {exc.code}.")) from exc
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            if method == "POST" and path.endswith("/add_spent_time"):
                raise GitLabTimeUncertain("O envio de tempo ficou incerto. Verifica o GitLab antes de repetir o registo.") from exc
            if method == "POST" and path.endswith("/issues"):
                raise GitLabCreateUncertain("A resposta à criação ficou incerta. Verifica o GitLab antes de tentar novamente.") from exc
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

    def create_task(self, task, project_id, user_id, labels):
        """Create one explicitly approved issue; labels must be prevalidated by the caller."""
        return self.request(f"/projects/{project_id}/issues", "POST", {
            "title": task.title, "description": task.description,
            "assignee_ids": [user_id], "labels": ",".join(sorted(labels)),
        })[0]

    def add_spent_time(self, link, duration_seconds):
        """Send one minute-precision time increment, preserving existing remote time."""
        return self.request(f"/projects/{link.project_id}/issues/{link.issue_iid}/add_spent_time", "POST", {
            "duration": f"{duration_seconds // 60}m",
        })[0]

    def update_task(self, link, changes):
        """Send only field deltas; never replace unrelated remote labels."""
        estimate_updated = False
        if "estimate_seconds" in changes:
            # An absolute estimate can be retried without incrementing spent time.
            estimate = changes["estimate_seconds"]
            stats = self.request(f"/projects/{link.project_id}/issues/{link.issue_iid}/time_estimate", "POST", {
                "duration": f"{estimate}s",
            })[0]
            if not isinstance(stats, dict) or stats.get("time_estimate") != estimate:
                raise GitLabError("Não foi possível confirmar a estimativa no GitLab.")
            estimate_updated = True
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
            return self.get(f"/projects/{link.project_id}/issues/{link.issue_iid}") if estimate_updated else None
        return self.request(f"/projects/{link.project_id}/issues/{link.issue_iid}", "PUT", payload)[0]
