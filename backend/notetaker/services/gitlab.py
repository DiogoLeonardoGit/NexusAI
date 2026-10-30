"""GitLab REST/GraphQL client with persistent opt-in and per-client write permission."""

import json
import logging
import os
import re
import threading
import uuid
from itertools import chain
from logging.handlers import RotatingFileHandler
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from rest_framework.exceptions import ValidationError

EXPECTED_EMAIL = "diogo.leonardo@warpcom.com"
BASE_URL = "https://gitlab.warpcom.com"
PROJECT_PATH = "serviceunit/django-apps/twinportal"
WRITE_SETTING = "gitlab_write_enabled"
_token = os.getenv("NOTETAKER_GITLAB_TOKEN", "")
_credential_lock = threading.Lock()


def _diagnose_graphql(operation, result, status):
    """Record allowlisted response structure, never variables, text or credentials.

    Temporary diagnostics are enabled by the desktop launcher. Each backend
    process has its own bounded log to avoid competing rotations.
    """
    if os.getenv("NOTETAKER_DIAGNOSTICS") != "1":
        return
    try:
        from django.conf import settings
        destination = settings.DATA_DIR / "diagnostics"
        destination.mkdir(parents=True, exist_ok=True)
        logger = logging.getLogger("notetaker.graphql.diagnostics")
        if not logger.handlers:
            handler = RotatingFileHandler(
                destination / f"gitlab-graphql-{os.getpid()}.jsonl",
                maxBytes=1024 * 1024, backupCount=1, encoding="utf-8",
            )
            handler.setFormatter(logging.Formatter('%(message)s'))
            logger.addHandler(handler)
            logger.setLevel(logging.INFO)
            logger.propagate = False
        envelope = result if isinstance(result, dict) else {}
        data = envelope.get("data")
        project = data.get("project") if isinstance(data, dict) else None
        errors = envelope.get("errors")
        known_codes = {"undefinedField", "undefinedType", "variableRequiresValidType", "ACCESS_DENIED", "FORBIDDEN"}
        codes = []
        if isinstance(errors, list):
            for error in errors:
                extensions = error.get("extensions") if isinstance(error, dict) else None
                code = extensions.get("code") if isinstance(extensions, dict) else None
                codes.append(code if isinstance(code, str) and code in known_codes else "other_or_missing")
        # Deliberately do not persist server error messages: they can echo input.
        from datetime import datetime, timezone
        logger.info(json.dumps({
            "time": datetime.now(timezone.utc).isoformat(),
            "operation": operation, "http_status": status,
            "response_is_object": isinstance(result, dict),
            "data_is_object": isinstance(data, dict),
            "data_fields_present": [key for key in ("currentUser", "project", "__schema")
                                    if isinstance(data, dict) and key in data],
            "authenticated": bool(data.get("currentUser")) if isinstance(data, dict) and "currentUser" in data else None,
            "project_is_object": isinstance(project, dict),
            "work_item_is_object": isinstance(project.get("workItem"), dict) if isinstance(project, dict) else False,
            "error_count": len(errors) if isinstance(errors, list) else 0,
            "error_codes": codes,
        }))
    except (OSError, ValueError):
        logging.getLogger(__name__).warning("Could not write GraphQL diagnostics.")


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


class GitLabUploadUncertain(GitLabError):
    """An upload may exist remotely even when its Markdown was not acknowledged."""


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

    def request(self, path, method="GET", data=None, query=None, *, graphql=False, upload=None, image=False):
        if self.connection.base_url.rstrip("/") != BASE_URL or not path.startswith("/") or urlsplit(path).netloc:
            raise GitLabError("Destino GitLab inválido.")
        if image and (method != "GET" or not re.fullmatch(r"/projects/\d+/uploads/[a-fA-F0-9]{32}/[^/]+", path)):
            raise GitLabError("Destino de imagem inválido.")
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
        content_headers = {"Content-Type": "application/json"}
        if upload is not None:
            if method != "POST" or not re.fullmatch(r"/projects/\d+/uploads", path) or graphql or data is not None:
                raise GitLabError("Destino de upload inválido.")
            # Stream multipart bytes with an explicit length instead of buffering the file.
            boundary = uuid.uuid4().hex
            filename = re.sub(r"[\x00-\x1f\x7f]", "_", upload.name.replace("\\", "/").rsplit("/", 1)[-1])
            filename = filename.replace("\\", "\\\\").replace('"', '\\"')
            prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                      'Content-Type: application/octet-stream\r\n\r\n').encode("utf-8")
            suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
            body = chain((prefix,), upload.chunks(), (suffix,))
            content_headers = {"Content-Type": f"multipart/form-data; boundary={boundary}",
                               "Content-Length": str(len(prefix) + upload.size + len(suffix))}
        authentication = {"Authorization": f"Bearer {credential}"} if graphql else {"PRIVATE-TOKEN": credential}
        request = Request(url, data=body, method=method, headers={
            **authentication, "Accept": "image/png,image/jpeg,image/gif,image/webp" if image else "application/json", **content_headers,
        })
        try:
            with self.opener.open(request, timeout=20) as response:
                if image:
                    # Bound memory and accept only inert raster formats, never HTML or SVG.
                    content = response.read(15 * 1024 * 1024 + 1)
                    if len(content) > 15 * 1024 * 1024:
                        raise GitLabError("A imagem excede o limite de preview de 15 MB.")
                    mime = None
                    if content.startswith(b"\x89PNG\r\n\x1a\n"):
                        mime = "image/png"
                    elif content.startswith(b"\xff\xd8\xff"):
                        mime = "image/jpeg"
                    elif content[:6] in (b"GIF87a", b"GIF89a"):
                        mime = "image/gif"
                    elif content.startswith(b"RIFF") and content[8:12] == b"WEBP":
                        mime = "image/webp"
                    if not mime:
                        raise GitLabError("Preview disponível apenas para PNG, JPEG, GIF e WebP.")
                    return content, mime
                result = json.load(response)
                if graphql_read:
                    operation = re.search(r"\bquery\s+(TaskDateAccess|TaskDateSchema|TaskDates)\b", data["query"])
                    _diagnose_graphql(operation[1] if operation else "other_query", result, response.status)
                return result, response.headers.get("X-Next-Page", "")
        except HTTPError as exc:
            if upload is not None and exc.code >= 500:
                raise GitLabUploadUncertain("Upload sem confirmação. Verifica o GitLab antes de tentar enviar este ficheiro novamente.") from exc
            if method == "POST" and path.endswith("/notes") and exc.code >= 500:
                raise GitLabCommentUncertain("Envio do comentário sem confirmação. Verifica o GitLab antes de tentar novamente.") from exc
            if method == "POST" and path.endswith("/add_spent_time") and exc.code >= 500:
                raise GitLabTimeUncertain("O envio de tempo ficou incerto. Verifica o GitLab antes de repetir o registo.") from exc
            if method == "POST" and path.endswith("/issues") and exc.code >= 500:
                raise GitLabCreateUncertain("A resposta à criação ficou incerta. Verifica o GitLab antes de tentar novamente.") from exc
            messages = {401: "Token inválido ou expirado.", 403: "Sem permissão no GitLab.",
                        404: "Tarefa ou projeto indisponível.", 413: "O ficheiro excede o tamanho permitido pelo GitLab.",
                        429: "Limite de pedidos atingido; será feita nova tentativa."}
            if upload is not None:
                messages[429] = "Limite de pedidos atingido. Tenta novamente mais tarde."
            if method == "POST" and (path.endswith("/issues") or path.endswith("/add_spent_time") or path.endswith("/notes")):
                messages[429] = "Limite de pedidos atingido. Tenta novamente mais tarde."
            raise GitLabError(messages.get(exc.code, f"GitLab respondeu com HTTP {exc.code}.")) from exc
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            if upload is not None:
                raise GitLabUploadUncertain("Upload sem confirmação. Verifica o GitLab antes de tentar enviar este ficheiro novamente.") from exc
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

    def members(self, project_id):
        """List active direct and inherited project members using numeric pagination."""
        members = {item["id"]: {"id": item["id"], "name": item.get("name") or item["username"],
                                  "username": item["username"]}
                   for item in self.pages(f"/projects/{project_id}/members/all")
                   if item.get("state", "active") == "active"}
        return sorted(members.values(), key=lambda item: (item["name"].casefold(), item["id"]))

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

    def comment_image(self, link, source):
        """Resolve a Markdown upload only inside this task's GitLab project."""
        if not isinstance(source, str) or len(source) > 2048:
            raise GitLabError("Link de imagem inválido.")
        try:
            parsed = urlsplit(source)
        except ValueError as exc:
            raise GitLabError("Link de imagem inválido.") from exc
        if parsed.query or parsed.fragment or (parsed.netloc and f"{parsed.scheme}://{parsed.netloc}" != BASE_URL):
            raise GitLabError("Link de imagem inválido.")
        path = parsed.path
        prefix = f"/{self.connection.project_path.strip('/')}/uploads/"
        if path.startswith(prefix):
            path = "/uploads/" + path[len(prefix):]
        match = re.fullmatch(r"/uploads/([a-fA-F0-9]{32})/([^/]+)", path)
        if not match or (parsed.scheme and not parsed.netloc):
            raise GitLabError("Só são suportadas imagens anexadas ao projeto GitLab.")
        filename = unquote(match[2])
        if filename in (".", "..") or any(char in filename for char in "/\\\x00\r\n"):
            raise GitLabError("Nome de imagem inválido.")
        return self.request(f"/projects/{link.project_id}/uploads/{match[1]}/{quote(filename, safe='')}", image=True)

    def upload_file(self, link, upload):
        """Upload one attachment on explicit submission and return confirmed Markdown."""
        result = self.request(f"/projects/{link.project_id}/uploads", "POST", upload=upload)[0]
        if not isinstance(result, dict) or not isinstance(result.get("markdown"), str) or not result["markdown"].strip():
            raise GitLabUploadUncertain("O GitLab não confirmou o link do ficheiro. Verifica o upload antes de tentar novamente.")
        return {"markdown": result["markdown"]}

    def comments(self, link):
        """Read all user comments chronologically, excluding automatic system notes."""
        notes = self.pages(f"/projects/{link.project_id}/issues/{link.issue_iid}/notes",
                           sort="asc", order_by="created_at")
        return [{"id": note["id"], "body": note.get("body", ""),
                 "created_at": note.get("created_at"),
                 "author": {key: (note.get("author") or {}).get(key, "")
                            for key in ("name", "username")}}
                for note in notes if not note.get("system")]

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
            "assignee_ids": [user_id] if user_id is not None else [], "labels": ",".join(sorted(labels)),
        })[0]

    def add_spent_time(self, link, duration_seconds):
        """Send one minute-precision time increment, preserving existing remote time."""
        return self.request(f"/projects/{link.project_id}/issues/{link.issue_iid}/add_spent_time", "POST", {
            "duration": f"{duration_seconds // 60}m",
        })[0]

    def update_task(self, link, changes):
        """Send supported REST deltas; start dates remain exclusively local."""
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
        payload = {key: value for key, value in changes.items() if key in {"title", "description", "due_date"}}
        if "assignees" in changes:
            payload["assignee_ids"] = [person["id"] for person in changes["assignees"]]
        if "milestone_id" in changes:
            payload["milestone_id"] = changes["milestone_id"] or 0
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
        elif estimate_updated:
            issue = self.get(f"/projects/{link.project_id}/issues/{link.issue_iid}")
        else:
            return None
        return issue
