"""Idempotent personal-task import, local outbox and three-way reconciliation."""

import logging
import threading

from django.db import close_old_connections, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework.exceptions import ValidationError

from notetaker.models import AppSetting, GitLabConnection, GitLabLabel, GitLabTask, Reminder, Tag, Task, TaskTimeEntry
from . import gitlab

logger = logging.getLogger(__name__)
sync_lock = threading.RLock()
COMPLETION_LABELS = frozenset({"To Do", "On Going", "On Testing / Pending Deploy"})
UNSENT_TIME_STATES = (TaskTimeEntry.SyncState.PENDING, TaskTimeEntry.SyncState.SENDING, TaskTimeEntry.SyncState.UNCERTAIN)


def connection():
    return GitLabConnection.objects.get_or_create(pk=1)[0]


def pending_links(config):
    """Count each linked task once, including its undelivered or uncertain time."""
    return GitLabTask.objects.filter(connection=config).filter(
        ~Q(pending={}) | Q(task__time_entries__sync_state__in=UNSENT_TIME_STATES)).distinct()


def publish_key(task_id):
    """Use the existing preferences table for a durable creation reservation."""
    return f"gitlab_publish_task_{task_id}"


def publish_task(task):
    """Publish a local task once, validating the live catalogue before any POST.

    The reservation survives crashes and uncertain responses. It deliberately
    blocks another create until the remote result is checked, avoiding blind retries.
    """
    with sync_lock:
        if GitLabTask.objects.filter(task=task).exists():
            return task
        if AppSetting.objects.filter(key=publish_key(task.pk)).exists():
            raise ValidationError({"detail": "Existe um envio sem confirmação para esta tarefa. Verifica o GitLab; a criação não será repetida."})
        if task.status != Task.Status.TODO or task.owner != Task.Owner.SELF:
            raise ValidationError({"detail": "Só podes enviar tarefas abertas com responsável Eu."})
        config = connection()
        if not config.enabled or not gitlab.writes_enabled() or not gitlab.has_token():
            raise ValidationError({"detail": "Ativa a sincronização e a escrita e configura o token GitLab."})
        client = gitlab.GitLabClient(config, allow_writes=True)
        user = client.get("/user")
        if user.get("email", "").lower() != gitlab.EXPECTED_EMAIL:
            raise gitlab.GitLabError("O token tem de pertencer a diogo.leonardo@warpcom.com.")
        project = client.project()
        config.user_id, config.username, config.project_id = user["id"], user["username"], project["id"]
        config.save(update_fields=["user_id", "username", "project_id"])
        available = sync_labels(config, client)
        names = set(task.tags.values_list("name", flat=True))
        missing = sorted(names - set(available))
        if missing:
            raise ValidationError({"detail": "Estas labels não existem no GitLab: " + ", ".join(missing)})
        if not names & COMPLETION_LABELS:
            raise ValidationError({"detail": "Escolhe pelo menos uma label principal: To Do, On Going ou On Testing / Pending Deploy."})
        if any("," in name for name in names):
            raise ValidationError({"detail": "A API GitLab não permite enviar labels com vírgulas."})
        reservation = AppSetting.objects.create(key=publish_key(task.pk), value={"state": "sending", "project_id": config.project_id})
        try:
            issue = client.create_task(task, config.project_id, config.user_id, names)
        except gitlab.GitLabCreateUncertain:
            reservation.value = {"state": "uncertain", "project_id": config.project_id}
            reservation.save(update_fields=["value"])
            raise
        except gitlab.GitLabError:
            # Rejected requests or local preflight failures did not create an issue.
            reservation.delete()
            raise
        # Keep the reservation if acknowledgement cannot be linked locally.
        # A later click must never emit another POST after remote success.
        with transaction.atomic():
            GitLabTask.objects.create(task=task, connection=config, project_id=config.project_id,
                                      issue_iid=issue["iid"], remote_id=issue["id"], web_url=issue["web_url"],
                                      snapshot=state_of(issue), remote_updated_at=parse_datetime(issue.get("updated_at") or ""))
            task.refresh_from_db()
            queue_task(task)
            reservation.delete()
        return task


def state_of(issue):
    values = {"title": issue["title"], "description": issue.get("description") or "",
              "state": issue["state"], "labels": sorted(issue.get("labels", []))}
    # Spent time is additive; only the estimate participates in scalar conflicts.
    total = (issue.get("time_stats") or {}).get("total_time_spent", 0)
    values["total_time_spent"] = total if type(total) is int and total >= 0 else 0
    estimate = (issue.get("time_stats") or {}).get("time_estimate", 0)
    values["estimate_seconds"] = estimate if type(estimate) is int and estimate >= 0 else 0
    # Start dates belong exclusively to this app, even if REST exposes the field.
    values["start_date"] = None
    values["due_date"] = issue.get("due_date") or None
    milestone = issue.get("milestone") or {}
    values["milestone_id"] = milestone.get("id")
    values["milestone"] = {"id": milestone["id"], "title": milestone.get("title", "")} if milestone.get("id") else None
    return values


def local_start_date(snapshot, pending=None, conflicts=None):
    """Recover the desired local date, including dates queued by older versions."""
    if pending and "start_date" in pending:
        return pending["start_date"]
    if conflicts and "start_date" in conflicts:
        return conflicts["start_date"].get("local")
    return snapshot.get("start_date") or snapshot.get("_local_start_date")


def retain_local_start_date(link):
    """Retain old date-only outbox entries locally during normal saves/sync.

    Reuse the existing JSON snapshot; no schema change or bulk data update is
    needed. All unrelated pending fields and conflicts remain untouched.
    """
    date = local_start_date(link.snapshot, link.pending, link.conflicts)
    link.snapshot = {**link.snapshot, "start_date": date}
    for key in ("_local_start_date", "_start_date_error"):
        link.snapshot.pop(key, None)
    link.pending = {key: value for key, value in link.pending.items() if key != "start_date"}
    link.conflicts = {key: value for key, value in link.conflicts.items() if key != "start_date"}


def remote_state(issue, link, client):
    """Combine REST fields with the local start date without a GraphQL request."""
    values = state_of(issue)
    if link:
        values["start_date"] = local_start_date(link.snapshot, link.pending, link.conflicts)
    return values


def local_state(task):
    """Calendar deadlines stay on Task; remote-only planning uses the existing outbox."""
    link = getattr(task, "gitlab", None)
    planning = {**link.snapshot, **link.pending} if link else {}
    return {"title": task.title, "description": task.description,
            "state": "closed" if task.status == Task.Status.DONE else "opened",
            "labels": sorted(task.tags.values_list("name", flat=True)),
            "estimate_seconds": task.estimate_seconds,
            "due_date": timezone.localtime(task.due_at).date().isoformat() if task.due_at else None,
            "start_date": local_start_date(link.snapshot, link.pending, link.conflicts) if link else None,
            "milestone_id": planning.get("milestone_id")}


def queue_task(task):
    """Coalesce local changes into one durable desired state per remote task."""
    try:
        link = task.gitlab
    except GitLabTask.DoesNotExist:
        return
    if not link.active or link.hidden:
        raise ValidationError({"detail": "Esta tarefa já não está disponível para sincronização."})
    retain_local_start_date(link)
    current = local_state(task)
    # Stamp the local label change now, so offline delivery retains its actual date.
    if "On Going" in current["labels"] and "On Going" not in link.snapshot.get("labels", []) and not current["start_date"]:
        current["start_date"] = timezone.localdate().isoformat()
    link.snapshot["start_date"] = current["start_date"]
    link.pending = {key: value for key, value in current.items() if value != link.snapshot.get(key, 0 if key == "estimate_seconds" else None)}
    # Editing an already conflicted field updates its local alternative.
    for key in list(link.conflicts):
        if key not in link.pending:
            del link.conflicts[key]
        else:
            link.conflicts[key]["local"] = current[key]
    link.save(update_fields=["snapshot", "pending", "conflicts"])


def merge_states(baseline, pending, remote, existing_conflicts=None):
    """Merge independent fields and label deltas; report competing scalar edits."""
    result, remaining, conflicts = dict(remote), {}, {}
    if any("start_date" in values or "_local_start_date" in values
           for values in (baseline, pending, remote, existing_conflicts or {})):
        result["start_date"] = local_start_date(baseline, pending, existing_conflicts)
    result.pop("_local_start_date", None)
    result.pop("_start_date_error", None)
    for key, wanted in pending.items():
        if key == "start_date":
            continue
        previous = baseline.get(key, 0 if key == "estimate_seconds" else None)
        actual = remote.get(key)
        if key == "labels":
            old, local, external = set(previous or []), set(wanted), set(actual or [])
            wanted = sorted((external - (old - local)) | (local - old))
        elif actual != wanted and ((existing_conflicts or {}).get(key) or actual != previous):
            conflicts[key] = {"base": (existing_conflicts or {}).get(key, {}).get("base", previous),
                              "local": wanted, "remote": actual}
        result[key] = wanted
        if wanted != actual:
            remaining[key] = wanted
    # Closing locally also removes progress labels added remotely before delivery.
    # Restrict this rule to a pending close; imported closed history stays unchanged.
    if pending.get("state") == "closed":
        result["labels"] = sorted(set(result["labels"]) - COMPLETION_LABELS)
        if result["labels"] != remote.get("labels", []):
            remaining["labels"] = result["labels"]
        else:
            remaining.pop("labels", None)
    return result, remaining, conflicts


def apply_state(task, values, label_ids):
    """Apply reconciled remote fields without touching projects or meeting links."""
    task.title, task.description = values["title"], values["description"]
    task.estimate_seconds = values.get("estimate_seconds", 0)
    # Keep the local clock time when only the remote calendar date changes.
    if "due_date" in values:
        date = parse_date(values.get("due_date") or "")
        local_due = timezone.localtime(task.due_at) if task.due_at else None
        if date is None:
            task.due_at = None
        elif not local_due or local_due.date() != date:
            from datetime import datetime, time
            clock = local_due.time() if local_due else time(23, 59)
            task.due_at = timezone.make_aware(datetime.combine(date, clock))
    done = values["state"] == "closed"
    was_done = task.status == Task.Status.DONE
    task.status = Task.Status.DONE if done else Task.Status.TODO
    task.owner = Task.Owner.SELF
    if done and not was_done:
        task.completed_at = timezone.now()
    elif not done:
        task.completed_at = None
    task.save()
    task.tags.set([label_ids[name] for name in values["labels"]])
    if done:
        task.reminders.update(status=Reminder.Status.CANCELLED)


def sync_labels(config, client):
    """Keep external identities for both project and inherited group labels."""
    labels = list(client.pages(f"/projects/{config.project_id}/labels", include_ancestor_groups="true"))
    seen = []
    with transaction.atomic():
        for label in labels:
            tag, _ = Tag.objects.get_or_create(name=label["name"], defaults={"color": label.get("color", "#6699cc")})
            mapping, _ = GitLabLabel.objects.update_or_create(
                connection=config, project_id=config.project_id, remote_id=label["id"],
                defaults={"tag": tag, "remote_name": label["name"], "available": True},
            )
            seen.append(mapping.pk)
        GitLabLabel.objects.filter(connection=config).exclude(pk__in=seen).update(available=False)
    return {row.remote_name: row.tag_id for row in GitLabLabel.objects.filter(connection=config, available=True)}


def check_enabled(config):
    """Re-read the switch between requests and before any remote write."""
    config.refresh_from_db(fields=["enabled"])
    return config.enabled


def synchronize(*, send_updates=None):
    """Reconcile linked tasks automatically when the user permits remote writes.

    Local task creation stays exclusively in publish_task, never in this worker.
    """
    if not sync_lock.acquire(blocking=False):
        return {"busy": True}
    try:
        config = connection()
        if not config.enabled:
            return {"disabled": True}
        if send_updates is None:
            send_updates = gitlab.writes_enabled()
        if send_updates and not gitlab.writes_enabled():
            raise ValidationError({"detail": "Ativa o modo de escrita nas definições GitLab."})
        client = gitlab.GitLabClient(config, allow_writes=send_updates)
        started_at = timezone.now()
        sent, failed = 0, 0
        try:
            user = client.get("/user")
            if user.get("email", "").lower() != gitlab.EXPECTED_EMAIL:
                raise gitlab.GitLabError("O token tem de pertencer a diogo.leonardo@warpcom.com.")
            if not check_enabled(config):
                return {"disabled": True}
            project = client.project()
            config.user_id, config.username, config.project_id = user["id"], user["username"], project["id"]
            config.save(update_fields=["user_id", "username", "project_id"])
            if not check_enabled(config):
                return {"disabled": True}
            labels = sync_labels(config, client)
            if not check_enabled(config):
                return {"disabled": True}
            issues = list(client.pages(f"/projects/{config.project_id}/issues", scope="all",
                                      assignee_id=config.user_id, state="all"))
            seen, imported = set(), 0
            for issue in issues:
                if not check_enabled(config):
                    return {"disabled": True}
                if not any(person["id"] == config.user_id for person in issue.get("assignees", [])):
                    continue
                link = GitLabTask.objects.filter(connection=config, project_id=config.project_id, issue_iid=issue["iid"]).first()
                # Closed history is imported only for tasks already managed by this app.
                if link is None and issue["state"] != "opened":
                    continue
                for name in issue.get("labels", []):
                    if name not in labels:
                        labels[name] = Tag.objects.get_or_create(name=name)[0].pk
                remote = remote_state(issue, link, client)
                with transaction.atomic():
                    if link is None:
                        task = Task.objects.create(title=issue["title"], owner=Task.Owner.SELF, creation_source=Task.CreationSource.GITLAB)
                        created = parse_datetime(issue.get("created_at") or "")
                        if created:
                            task.created_at = created
                            task.save(update_fields=["created_at"])
                        link = GitLabTask.objects.create(task=task, connection=config, project_id=config.project_id,
                                                        issue_iid=issue["iid"], remote_id=issue["id"], web_url=issue["web_url"])
                        imported += 1
                    seen.add(link.pk)
                    link.active = True
                    retain_local_start_date(link)
                    if not link.hidden:
                        # Seed the new baseline without discarding existing app deadlines.
                        if "due_date" not in link.snapshot:
                            link.snapshot["due_date"] = remote["due_date"]
                            if link.task.due_at:
                                local_due = timezone.localtime(link.task.due_at).date().isoformat()
                                if local_due != remote["due_date"]:
                                    link.pending.setdefault("due_date", local_due)
                        merged, link.pending, link.conflicts = merge_states(link.snapshot, link.pending, remote, link.conflicts)
                        for name in merged["labels"]:
                            if name not in labels:
                                labels[name] = Tag.objects.get_or_create(name=name)[0].pk
                        apply_state(link.task, merged, labels)
                        closed = parse_datetime(issue.get("closed_at") or "")
                        if closed and merged["state"] == "closed" and "state" not in link.pending:
                            link.task.completed_at = closed
                            link.task.save(update_fields=["completed_at"])
                        # Recover history only for pre-existing labels with no start date.
                        if "On Going" in merged["labels"] and not merged.get("start_date") and "start_date" not in link.pending:
                            date = client.ongoing_date(link)
                            if date:
                                remote["start_date"] = date
                    link.snapshot = remote
                    link.remote_updated_at = parse_datetime(issue.get("updated_at") or "")
                    link.error = ""
                    link.web_url = issue["web_url"]
                    link.save()
                has_time = link.task.time_entries.filter(sync_state__in=UNSENT_TIME_STATES).exists() if send_updates else False
                if send_updates and (link.pending or has_time) and not link.conflicts and not link.hidden and check_enabled(config):
                    try:
                        fields_sent = bool(push_pending(link, config, client, labels)) if link.pending else False
                        if fields_sent:
                            sent += 1
                        if has_time and push_time_entries(link, config, client) and not fields_sent:
                            sent += 1
                    except gitlab.GitLabDisabled:
                        raise
                    except gitlab.GitLabError as exc:
                        link.error = str(exc)
                        link.save(update_fields=["error"])
                        failed += 1
            # Missing assignments suspend edits, never delete personal records.
            GitLabTask.objects.filter(connection=config).exclude(pk__in=seen).update(active=False)
            config.last_sync_at = timezone.now()
            config.error = (
                f"Não foi possível enviar todas as alterações de {failed} tarefa(s). "
                "As alterações não confirmadas continuam pendentes."
            ) if failed else ""
            config.save(update_fields=["last_sync_at", "error"])
            links = GitLabTask.objects.filter(connection=config)
            return {"imported": imported, "updated": len(seen), "read_only": not gitlab.writes_enabled(),
                    "sent": sent, "failed": failed, "pending": pending_links(config).count(),
                    "time_entries_sent": TaskTimeEntry.objects.filter(task__gitlab__connection=config,
                        sync_state=TaskTimeEntry.SyncState.SENT, synced_at__gte=started_at).count(),
                    "conflicts": links.exclude(conflicts={}).count()}
        except gitlab.GitLabDisabled:
            return {"disabled": True}
        except gitlab.GitLabError as exc:
            config.error = str(exc)
            config.save(update_fields=["error"])
            raise
    finally:
        sync_lock.release()


def resolve_conflicts(link, choice):
    """Resolve each conflicting field against the last observed remote version."""
    if choice not in {"local", "remote"}:
        raise ValidationError({"choice": "Escolhe local ou remote."})
    retain_local_start_date(link)
    current = local_state(link.task)
    for key, conflict in link.conflicts.items():
        current[key] = conflict[choice]
    label_ids = {tag.name: tag.pk for tag in Tag.objects.filter(name__in=current["labels"])}
    apply_state(link.task, current, label_ids)
    link.conflicts = {}
    link.pending = {key: value for key, value in current.items() if value != link.snapshot.get(key, 0 if key == "estimate_seconds" else None)}
    link.save(update_fields=["snapshot", "pending", "conflicts"])


def push_pending(link, config, client, labels):
    """Recheck assignment and conflicts before emitting permitted field deltas."""
    retain_local_start_date(link)
    latest = client.get(f"/projects/{link.project_id}/issues/{link.issue_iid}")
    if not any(person["id"] == config.user_id for person in latest.get("assignees", [])):
        link.active = False
        link.save(update_fields=["active"])
        return
    remote = remote_state(latest, link, client)
    merged, pending, conflicts = merge_states(link.snapshot, link.pending, remote, link.conflicts)
    for name in merged["labels"]:
        if name not in labels:
            labels[name] = Tag.objects.get_or_create(name=name)[0].pk
    with transaction.atomic():
        link.snapshot, link.pending, link.conflicts = remote, pending, conflicts
        link.error = ""
        apply_state(link.task, merged, labels)
        link.save()
    if not pending or conflicts or not check_enabled(config):
        return
    updated = client.update_task(link, pending)
    if updated:
        confirmed = remote_state(updated, link, client)
        for key in ("due_date", "milestone_id"):
            if key in pending and confirmed.get(key) != pending[key]:
                raise gitlab.GitLabError("O GitLab não confirmou o campo de planeamento: " + key)
        with transaction.atomic():
            link.snapshot = confirmed
            link.pending = {}
            link.remote_updated_at = parse_datetime(updated.get("updated_at") or "")
            for name in link.snapshot["labels"]:
                if name not in labels:
                    labels[name] = Tag.objects.get_or_create(name=name)[0].pk
            apply_state(link.task, {**link.snapshot, **link.pending}, labels)
            link.error = ""
            link.save()
        return True
    return False


def push_time_entries(link, config, client):
    """Send each manual time record once, acknowledging its remote total atomically.

    SENDING is committed before the additive request, so a crash cannot trigger a
    blind retry. Uncertain responses block time delivery for this task until reviewed.
    """
    if not link.active or link.hidden or link.conflicts:
        return 0
    entries = link.task.time_entries
    if entries.filter(sync_state__in=(TaskTimeEntry.SyncState.SENDING, TaskTimeEntry.SyncState.UNCERTAIN)).exists():
        raise gitlab.GitLabError("Há um envio de tempo por confirmar nesta tarefa. Verifica o GitLab; o tempo não será enviado novamente.")
    latest = client.get(f"/projects/{link.project_id}/issues/{link.issue_iid}")
    if not any(person["id"] == config.user_id for person in latest.get("assignees", [])):
        link.active = False
        link.save(update_fields=["active"])
        return 0
    if state_of(latest)["estimate_seconds"] <= 0:
        raise gitlab.GitLabError("Define e sincroniza uma estimativa antes de enviar tempo ao GitLab.")
    sent = 0
    for entry in entries.filter(sync_state=TaskTimeEntry.SyncState.PENDING):
        if not check_enabled(config):
            raise gitlab.GitLabDisabled("Sincronização desativada.")
        entry.sync_state, entry.error = TaskTimeEntry.SyncState.SENDING, ""
        entry.save(update_fields=["sync_state", "error"])
        try:
            stats = client.add_spent_time(link, entry.duration_seconds)
            total = stats.get("total_time_spent") if isinstance(stats, dict) else None
            if type(total) is not int or total < 0:
                raise gitlab.GitLabTimeUncertain("Não foi possível confirmar o total de tempo recebido pelo GitLab. Verifica o registo antes de repetir.")
        except gitlab.GitLabTimeUncertain as exc:
            entry.sync_state, entry.error = TaskTimeEntry.SyncState.UNCERTAIN, str(exc)
            entry.save(update_fields=["sync_state", "error"])
            raise
        except gitlab.GitLabError as exc:
            entry.sync_state, entry.error = TaskTimeEntry.SyncState.PENDING, str(exc)
            entry.save(update_fields=["sync_state", "error"])
            raise
        with transaction.atomic():
            link.snapshot["total_time_spent"] = total
            link.save(update_fields=["snapshot"])
            entry.sync_state, entry.synced_at, entry.error = TaskTimeEntry.SyncState.SENT, timezone.now(), ""
            entry.save(update_fields=["sync_state", "synced_at", "error"])
        sent += 1
    return sent


def sync_worker():
    """Run independently of audio processing while the local backend is alive."""
    import time
    while True:
        close_old_connections()
        try:
            synchronize()
        except gitlab.GitLabError:
            logger.info("GitLab sync deferred; details available in integration status.")
        except Exception:
            logger.exception("Unexpected local GitLab synchronization error")
        finally:
            close_old_connections()
        time.sleep(60)
