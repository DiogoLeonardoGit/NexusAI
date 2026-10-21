"""GitLab REST/GraphQL client with persistent opt-in and per-client write permission."""

import json
import os
import re
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


class GitLabCommentUncertain(GitLabError):
    """A comment may already exist remotely; never retry it automatically."""


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

    def request(self, path, method="GET", data=None, query=None, *, graphql=False):
        if self.connection.base_url.rstrip("/") != BASE_URL or not path.startswith("/") or urlsplit(path).netloc:
            raise GitLabError("Destino GitLab inválido.")
        self.connection.refresh_from_db(fields=["enabled"])
        if not self.connection.enabled:
            raise GitLabDisabled("Sincronização desativada.")
        # GraphQL reads use POST too; only explicit query documents are read-only.
        graphql_read = (graphql and method == "POST" and isinstance(data, dict)
                        and data.get("query", "").lstrip().startswith("query ")
                        and "mutation" not in data["query"])
        if method != "GET" and not graphql_read and (not self.allow_writes or not writes_enabled()):
            raise GitLabError("Escrita desativada ou pedido de escrita não autorizado.")
        with _credential_lock:
            credential = _token
        if not credential:
            raise GitLabError("Configura o token pessoal nas definições GitLab.")
        if graphql and path != "/graphql":
            raise GitLabError("Destino GraphQL inválido.")
        url = BASE_URL + ("/api" if graphql else "/api/v4") + path
        if query:
            url += "?" + urlencode(query, doseq=True)
        body = json.dumps(data).encode() if data is not None else None
        authentication = {"Authorization": f"Bearer {credential}"} if graphql else {"PRIVATE-TOKEN": credential}
        request = Request(url, data=body, method=method, headers={
            **authentication, "Accept": "application/json", "Content-Type": "application/json",
        })
        try:
            with self.opener.open(request, timeout=20) as response:
                return json.load(response), response.headers.get("X-Next-Page", "")
        except HTTPError as exc:
            if method == "POST" and path.endswith("/notes") and exc.code >= 500:
                raise GitLabCommentUncertain("Envio do comentário sem confirmação. Verifica o GitLab antes de tentar novamente.") from exc
            if method == "POST" and path.endswith("/add_spent_time") and exc.code >= 500:
                raise GitLabTimeUncertain("O envio de tempo ficou incerto. Verifica o GitLab antes de repetir o registo.") from exc
            if method == "POST" and path.endswith("/issues") and exc.code >= 500:
                raise GitLabCreateUncertain("A resposta à criação ficou incerta. Verifica o GitLab antes de tentar novamente.") from exc
            messages = {401: "Token inválido ou expirado.", 403: "Sem permissão no GitLab.",
                        404: "Tarefa ou projeto indisponível.", 429: "Limite de pedidos atingido; será feita nova tentativa."}
            if method == "POST" and (path.endswith("/issues") or path.endswith("/add_spent_time") or path.endswith("/notes")):
                messages[429] = "Limite de pedidos atingido. Tenta novamente mais tarde."
            raise GitLabError(messages.get(exc.code, f"GitLab respondeu com HTTP {exc.code}.")) from exc
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            if method == "POST" and path.endswith("/notes"):
                raise GitLabCommentUncertain("Envio do comentário sem confirmação. Verifica o GitLab antes de tentar novamente.") from exc
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

    def milestones(self, project_id):
        """Read assignable project and ancestor-group milestones with pagination."""
        # Use only the current parameter; its deprecated alias must not be sent alongside it.
        return list(self.pages(f"/projects/{project_id}/milestones", include_ancestors="true"))

    def supports_start_date(self):
        """REST issue start dates require GitLab 19.1 or later."""
        if not hasattr(self, "_start_date_supported"):
            version = self.get("/version").get("version", "")
            match = re.match(r"^(\d+)\.(\d+)", version)
            self._start_date_supported = bool(match and tuple(map(int, match.groups())) >= (19, 1))
        return self._start_date_supported

    def ongoing_date(self, link):
        """Recover the latest On Going addition from the issue's label history."""
        from django.utils import timezone
        from django.utils.dateparse import parse_datetime
        dates = []
        for event in self.pages(f"/projects/{link.project_id}/issues/{link.issue_iid}/resource_label_events"):
            if event.get("action") == "add" and (event.get("label") or {}).get("name") == "On Going":
                date = parse_datetime(event.get("created_at") or "")
                if date:
                    dates.append(date)
        return timezone.localtime(max(dates)).date().isoformat() if dates else None

    def work_item_dates(self, issue):
        """Read older servers' date widget; distinguish absent support from failures."""
        if getattr(self, "_graphql_dates_unsupported", False):
            return None
        if not hasattr(self, "_graphql_project_path"):
            # Resolve the canonical path and prove GraphQL access before treating
            # schema/widget availability as a limitation of the start-date field.
            rest_project = self.project()
            path = rest_project.get("path_with_namespace") if isinstance(rest_project, dict) else None
            if not isinstance(path, str) or not path:
                raise GitLabError("O GitLab não devolveu o caminho oficial do projeto.")
            access = self.request("/graphql", "POST", {
                "query": """query TaskDateAccess($path: ID!) {
                  currentUser { username }
                  project(fullPath: $path) { id }
                }""",
                "variables": {"path": path},
            }, graphql=True)[0]
            if access.get("errors"):
                raise GitLabError("Não foi possível verificar o acesso ao projeto por GraphQL.")
            access_data = access.get("data") or {}
            if not access_data.get("currentUser"):
                raise GitLabError("O token não autenticou o utilizador na API GraphQL do GitLab. Verifica as permissões do token.")
            if not access_data.get("project"):
                raise GitLabError("O projeto está acessível por REST, mas não por GraphQL. Não foi possível sincronizar a data de início.")
            self._graphql_project_path = path
        result = self.request("/graphql", "POST", {
            "query": """query TaskDates($path: ID!, $iid: String!) {
              updateInput: __type(name: "WorkItemUpdateInput") { inputFields { name } }
              dateInput: __type(name: "WorkItemWidgetStartAndDueDateUpdateInput") { inputFields { name } }
              project(fullPath: $path) { workItem(iid: $iid) { id widgets {
                ... on WorkItemWidgetStartAndDueDate { startDate }
              } } }
            }""",
            "variables": {"path": self._graphql_project_path, "iid": str(issue["iid"])},
        }, graphql=True)[0]
        errors = result.get("errors") or []
        # Validation failures mean this schema lacks the work-item API/widget.
        unsupported = {"undefinedField", "undefinedType", "variableRequiresValidType"}
        if errors and all((error.get("extensions") or {}).get("code") in unsupported for error in errors):
            self._graphql_dates_unsupported = True
            return None
        if errors:
            raise GitLabError("Não foi possível consultar a data de início por GraphQL.")
        data = result.get("data") or {}
        update_fields = {field["name"] for field in (data.get("updateInput") or {}).get("inputFields", [])}
        date_fields = {field["name"] for field in (data.get("dateInput") or {}).get("inputFields", [])}
        writable = "startAndDueDateWidget" in update_fields and "startDate" in date_fields
        project = data.get("project")
        if not project:
            raise GitLabError("O projeto deixou de estar acessível por GraphQL ao consultar a data de início.")
        item = project.get("workItem")
        if not item:
            # Some older instances expose work items only for selected issue types.
            return None
        for widget in item.get("widgets", []):
            if "startDate" in widget:
                return {"id": item["id"], "start_date": widget["startDate"], "writable": writable}
        return None

    def update_start_date(self, link, date):
        """Confirm a GraphQL date write, or explicitly preserve it only locally."""
        dates = self.work_item_dates({"iid": link.issue_iid})
        if dates is None or not dates["writable"]:
            return False
        result = self.request("/graphql", "POST", {
            "query": """mutation TaskStartDate($input: WorkItemUpdateInput!) {
              workItemUpdate(input: $input) { errors workItem { widgets {
                ... on WorkItemWidgetStartAndDueDate { startDate }
              } } }
            }""",
            "variables": {"input": {"id": dates["id"], "startAndDueDateWidget": {"startDate": date}}},
        }, graphql=True)[0]
        payload = (result.get("data") or {}).get("workItemUpdate") or {}
        if result.get("errors") or payload.get("errors"):
            raise GitLabError("O GitLab não permitiu atualizar a data de início por GraphQL.")
        widgets = (payload.get("workItem") or {}).get("widgets", [])
        if not any("startDate" in widget and widget["startDate"] == date for widget in widgets):
            raise GitLabError("O GitLab não confirmou a data de início por GraphQL.")
        return True

    def add_comment(self, link, body):
        """Post one comment on explicit submission; never retry additive requests."""
        note = self.request(f"/projects/{link.project_id}/issues/{link.issue_iid}/notes", "POST", {"body": body})[0]
        if not isinstance(note, dict) or type(note.get("id")) is not int:
            raise GitLabCommentUncertain("Envio do comentário sem confirmação. Verifica o GitLab antes de tentar novamente.")
        return {"id": note["id"]}

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
        graphql_date = "start_date" in changes and not self.supports_start_date()
        local_date = False
        if graphql_date:
            local_date = not self.update_start_date(link, changes["start_date"])
        if "estimate_seconds" in changes:
            # An absolute estimate can be retried without incrementing spent time.
            estimate = changes["estimate_seconds"]
            stats = self.request(f"/projects/{link.project_id}/issues/{link.issue_iid}/time_estimate", "POST", {
                "duration": f"{estimate}s",
            })[0]
            if not isinstance(stats, dict) or stats.get("time_estimate") != estimate:
                raise GitLabError("Não foi possível confirmar a estimativa no GitLab.")
            estimate_updated = True
        payload = {key: value for key, value in changes.items() if key in {"title", "description", "due_date"}}
        if "milestone_id" in changes:
            payload["milestone_id"] = changes["milestone_id"] or 0
        if "start_date" in changes:
            if not graphql_date:
                payload["start_date"] = changes["start_date"]
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
        if payload:
            issue = self.request(f"/projects/{link.project_id}/issues/{link.issue_iid}", "PUT", payload)[0]
        elif estimate_updated or graphql_date:
            issue = self.get(f"/projects/{link.project_id}/issues/{link.issue_iid}")
        else:
            return None
        if graphql_date:
            issue["start_date"] = changes["start_date"]
            if local_date:
                issue["_local_start_date"] = changes["start_date"]
        return issue
