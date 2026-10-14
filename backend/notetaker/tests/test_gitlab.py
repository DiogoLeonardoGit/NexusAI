"""Local integration tests: all GitLab responses and transports are simulated."""

from copy import deepcopy
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from notetaker.models import CaptureSession, GitLabConnection, GitLabLabel, GitLabTask, Project, Tag, Task, TaskSection
from notetaker.services import gitlab
from notetaker.services.gitlab_sync import merge_states, queue_task, synchronize


@override_settings(LOCAL_API_TOKEN="test-token")
class GitLabTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.client.credentials(HTTP_X_LOCAL_TOKEN="test-token")
        self.config = GitLabConnection.objects.create(pk=1)
        self.issue = {"id": 301, "iid": 5, "project_id": 42, "title": "Preparar entrega", "description": "Detalhes",
                      "state": "opened", "labels": ["Em curso"], "assignees": [{"id": 7}],
                      "updated_at": "2026-10-13T10:00:00Z", "due_date": None,
                      "web_url": "https://gitlab.warpcom.com/serviceunit/django-apps/twinportal/-/issues/5"}
        self.issues = [self.issue]
        self.labels = [{"id": 10, "name": "Em curso", "color": "#6699cc"},
                       {"id": 11, "name": "P1", "color": "#ff0000"},
                       {"id": 12, "name": "Revisão", "color": "#6699cc"}]
        self.fake = MagicMock()
        self.fake.get.return_value = {"id": 7, "username": "diogo.leonardo", "email": gitlab.EXPECTED_EMAIL}
        self.fake.project.return_value = {"id": 42}
        self.fake.pages.side_effect = lambda path, **query: deepcopy(self.labels if path.endswith("/labels") else self.issues)
        self.client_patch = patch("notetaker.services.gitlab.GitLabClient", return_value=self.fake)
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)
        # An accidental unmocked HTTP request fails immediately instead of reaching GitLab.
        self.transport_patch = patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("Real network forbidden"))
        self.transport_patch.start()
        self.addCleanup(self.transport_patch.stop)

    def enable_import(self):
        self.config.enabled = True
        self.config.save(update_fields=["enabled"])
        return synchronize()

    def test_disabled_by_default_makes_no_requests(self):
        response = self.client.get("/api/gitlab/")
        self.assertFalse(response.data["enabled"])
        self.assertTrue(response.data["read_only"])
        self.assertEqual(self.client.post("/api/gitlab/sync/").data, {"disabled": True})
        self.fake.get.assert_not_called()

    def test_personal_import_is_idempotent_and_filters_assignees(self):
        other = {**self.issue, "id": 302, "iid": 6, "assignees": [{"id": 8}]}
        closed = {**self.issue, "id": 303, "iid": 7, "state": "closed"}
        self.issues += [other, closed]
        self.assertEqual(self.enable_import()["imported"], 1)
        self.assertEqual(synchronize()["imported"], 0)
        task = Task.objects.get()
        self.assertEqual(task.owner, "self")
        self.assertEqual(task.creation_source, "gitlab")
        self.assertEqual(set(task.tags.values_list("name", flat=True)), {"Em curso"})
        self.fake.pages.assert_any_call("/projects/42/issues", scope="all", assignee_id=7, state="all")
        self.assertEqual(self.client.get("/api/tasks/?owner=self").data[0]["gitlab"]["issue_iid"], 5)

    def test_wrong_account_rejected_without_import(self):
        self.fake.get.return_value = {"id": 8, "email": "other@example.com"}
        with self.assertRaises(gitlab.GitLabError):
            self.enable_import()
        self.assertEqual(Task.objects.count(), 0)
        self.config.refresh_from_db()
        self.assertIn(gitlab.EXPECTED_EMAIL, self.config.error)

    def test_completion_and_labels_queue_without_remote_writes(self):
        self.enable_import()
        task = Task.objects.get()
        response = self.client.post(f"/api/tasks/{task.pk}/complete/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["gitlab"]["pending"])
        p1 = Tag.objects.get(name="P1")
        response = self.client.patch(f"/api/tasks/{task.pk}/", {"tags": [p1.pk]}, format="json")
        self.assertEqual(response.status_code, 200)
        synchronize()
        link = GitLabTask.objects.get()
        self.assertEqual(link.pending, {"state": "closed", "labels": ["P1"]})
        self.fake.update_task.assert_not_called()
        self.assertEqual(self.client.post(f"/api/tasks/{task.pk}/reopen/").status_code, 200)
        link.refresh_from_db()
        self.assertNotIn("state", link.pending)

    def test_remote_edits_preserve_local_meeting_and_derived_project(self):
        self.enable_import()
        task = Task.objects.get()
        project = Project.objects.create(name="Local")
        meeting = CaptureSession.objects.create(title="Reunião", started_at=timezone.now(), project=project)
        response = self.client.patch(f"/api/tasks/{task.pk}/", {"session": meeting.pk}, format="json")
        self.assertEqual(response.status_code, 200)
        self.issue.update(title="Título remoto", state="closed")
        synchronize()
        task.refresh_from_db()
        self.assertEqual(task.title, "Título remoto")
        self.assertEqual(task.status, "done")
        self.assertIsNone(task.project)
        self.assertEqual(self.client.get(f"/api/tasks/{task.pk}/").data["project"], project.pk)
        self.assertEqual(task.session, meeting)
        self.assertEqual(task.gitlab.pending, {})

    def test_conflicts_survive_repeated_sync_until_resolved(self):
        self.enable_import()
        task = Task.objects.get()
        self.client.patch(f"/api/tasks/{task.pk}/", {"title": "Local"}, format="json")
        self.issue["title"] = "Remoto"
        synchronize()
        synchronize()
        link = GitLabTask.objects.get()
        self.assertEqual(link.conflicts["title"]["local"], "Local")
        self.assertEqual(link.conflicts["title"]["remote"], "Remoto")
        response = self.client.post(f"/api/tasks/{task.pk}/resolve/", {"choice": "remote"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["title"], "Remoto")
        self.assertFalse(response.data["gitlab"]["pending"])
        self.assertEqual(response.data["gitlab"]["conflicts"], {})

    def test_label_deltas_preserve_remote_additions(self):
        self.enable_import()
        task = Task.objects.get()
        p1 = Tag.objects.get(name="P1")
        self.client.patch(f"/api/tasks/{task.pk}/", {"tags": [p1.pk]}, format="json")
        self.issue["labels"].append("Revisão")
        synchronize()
        link = GitLabTask.objects.get()
        self.assertEqual(link.pending["labels"], ["P1", "Revisão"])
        self.assertEqual(link.conflicts, {})

    def test_unassigned_task_suspends_edits_and_can_return(self):
        self.enable_import()
        task = Task.objects.get()
        self.issues = []
        synchronize()
        self.assertEqual(self.client.get("/api/tasks/").data, [])
        self.assertEqual(self.client.post(f"/api/tasks/{task.pk}/complete/").status_code, 400)
        self.issues = [self.issue]
        synchronize()
        self.assertEqual(len(self.client.get("/api/tasks/").data), 1)
        self.assertEqual(Task.objects.count(), 1)

    def test_hidden_task_is_not_reimported_or_deleted_remotely(self):
        self.enable_import()
        task = Task.objects.get()
        self.assertEqual(self.client.delete(f"/api/tasks/{task.pk}/").status_code, 400)
        self.assertEqual(self.client.post(f"/api/tasks/{task.pk}/hide/").status_code, 204)
        synchronize()
        self.assertEqual(Task.objects.count(), 1)
        self.assertEqual(self.client.get("/api/tasks/").data, [])
        self.fake.update_task.assert_not_called()

    def test_labels_from_other_projects_are_rejected(self):
        self.enable_import()
        task = Task.objects.get()
        local = Tag.objects.create(name="Pessoal")
        response = self.client.patch(f"/api/tasks/{task.pk}/", {"tags": [local.pk]}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.patch(f"/api/tasks/{task.pk}/", {"owner": "other"}, format="json").status_code, 400)

    def test_disabling_prevents_subsequent_requests(self):
        self.enable_import()
        self.assertEqual(self.client.patch("/api/gitlab/", {"enabled": False}, format="json").status_code, 200)
        self.fake.reset_mock()
        synchronize()
        self.fake.get.assert_not_called()

    def test_disable_during_import_stops_next_request(self):
        def disable():
            GitLabConnection.objects.filter(pk=1).update(enabled=False)
            return {"id": 42}
        self.fake.project.side_effect = disable
        self.assertEqual(self.enable_import(), {"disabled": True})
        self.fake.pages.assert_not_called()

    def test_local_tasks_and_label_views_do_not_need_gitlab(self):
        task_response = self.client.post("/api/tasks/", {"title": "Local", "owner": "self"}, format="json")
        self.assertEqual(task_response.status_code, 201)
        self.assertIsNone(task_response.data["gitlab"])
        self.assertNotIn("priority", task_response.data)
        response = self.client.post("/api/task-sections/", {"name": "Cliente"}, format="json")
        self.assertEqual(response.status_code, 201)
        tag = Tag.objects.get(name="Cliente")
        self.assertEqual(response.data["tag"], tag.pk)
        self.assertEqual(self.client.post("/api/task-sections/", {"tag": tag.pk}, format="json").status_code, 400)
        self.client.patch(f"/api/tasks/{task_response.data['id']}/", {"tags": [tag.pk]}, format="json")
        self.assertEqual(self.client.delete(f"/api/task-sections/{response.data['id']}/").status_code, 204)
        self.assertTrue(Task.objects.get().tags.filter(pk=tag.pk).exists())

    def test_offline_failure_keeps_local_outbox_and_records_error(self):
        self.enable_import()
        task = Task.objects.get()
        self.client.post(f"/api/tasks/{task.pk}/complete/")
        self.fake.get.side_effect = gitlab.GitLabError("Sem VPN")
        response = self.client.post("/api/gitlab/sync/")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(GitLabTask.objects.get().pending, {"state": "closed"})
        self.assertEqual(self.client.get("/api/gitlab/").data["error"], "Sem VPN")

    def test_manual_write_path_acknowledges_only_simulated_success(self):
        self.enable_import()
        task = Task.objects.get()
        self.client.post(f"/api/tasks/{task.pk}/complete/")
        self.fake.get.side_effect = lambda path: ({"id": 7, "username": "diogo", "email": gitlab.EXPECTED_EMAIL}
                                                 if path == "/user" else deepcopy(self.issue))
        self.fake.update_task.return_value = {**self.issue, "state": "closed"}
        settings = self.client.patch("/api/gitlab/", {"write_enabled": True}, format="json")
        self.assertEqual(settings.status_code, 200)
        self.assertFalse(settings.data["read_only"])
        synchronize()
        self.fake.update_task.assert_not_called()
        response = self.client.post("/api/gitlab/push/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["sent"], 1)
        self.fake.update_task.assert_called_once()
        link = GitLabTask.objects.get()
        self.assertEqual(link.pending, {})
        self.assertEqual(link.snapshot["state"], "closed")
        self.assertEqual(link.task.status, "done")

    def test_manual_write_path_rechecks_assignee_before_sending(self):
        self.enable_import()
        task = Task.objects.get()
        self.client.post(f"/api/tasks/{task.pk}/complete/")
        self.fake.get.side_effect = lambda path: ({"id": 7, "username": "diogo", "email": gitlab.EXPECTED_EMAIL}
                                                 if path == "/user" else {**self.issue, "assignees": [{"id": 8}]})
        with patch.object(gitlab, "writes_enabled", return_value=True):
            synchronize(send_updates=True)
        self.fake.update_task.assert_not_called()
        self.assertFalse(GitLabTask.objects.get().active)

    def test_credentials_are_not_persisted_or_returned(self):
        with patch.object(gitlab, "_token", ""):
            response = self.client.post("/api/gitlab/credentials/", {"token": "fake-local-test-token"}, format="json")
            self.assertEqual(response.data, {"has_token": True})
            status = self.client.get("/api/gitlab/")
            self.assertNotIn("fake-local-test-token", str(status.data))
            self.assertNotIn("token", {field.name for field in GitLabConnection._meta.fields})


class ClientSafetyTests(TestCase):
    def test_all_remote_write_methods_are_blocked_before_transport(self):
        config = GitLabConnection.objects.create(enabled=True)
        client = gitlab.GitLabClient(config)
        with patch.object(client.opener, "open") as transport:
            for method in ["POST", "PUT", "PATCH", "DELETE"]:
                with self.assertRaises(gitlab.GitLabError):
                    client.request("/projects/42/issues/5", method, {"state_event": "close"})
            transport.assert_not_called()

    def test_foreign_host_and_redirect_are_rejected(self):
        config = GitLabConnection.objects.create(base_url="https://other.example.com")
        with self.assertRaises(gitlab.GitLabError):
            gitlab.GitLabClient(config).get("/user")
        self.assertIsNone(gitlab.NoRedirects().redirect_request(None, None, 302, None, {}, "https://other.example.com"))

    def test_disabled_connection_blocks_even_manually_authorized_writes(self):
        config = GitLabConnection.objects.create(enabled=False)
        with patch.object(gitlab, "writes_enabled", return_value=True), self.assertRaises(gitlab.GitLabError):
            gitlab.GitLabClient(config, allow_writes=True).request("/projects/42/issues/5", "PUT", {})

    def test_future_outbound_payload_uses_only_deltas_in_simulated_transport(self):
        config = GitLabConnection.objects.create(enabled=True)
        task = Task.objects.create(title="Local")
        link = GitLabTask.objects.create(task=task, connection=config, project_id=42, issue_iid=5, remote_id=301,
                                        snapshot={"labels": ["Em curso", "Cliente"]}, web_url="https://gitlab.warpcom.com")
        client = gitlab.GitLabClient(config)
        with patch.object(client, "request", return_value=({}, "")) as request:
            client.update_task(link, {"state": "closed", "labels": ["Cliente", "P1"]})
            request.assert_called_once_with("/projects/42/issues/5", "PUT", {"state_event": "close", "add_labels": "P1", "remove_labels": "Em curso"})

    def test_merge_preserves_independent_fields(self):
        baseline = {"title": "Old", "description": "Old", "state": "opened", "labels": ["A", "B"]}
        remote = {**baseline, "description": "Remote", "labels": ["A", "B", "C"]}
        merged, pending, conflicts = merge_states(baseline, {"title": "Local", "labels": ["B", "D"]}, remote)
        self.assertEqual(merged, {"title": "Local", "description": "Remote", "state": "opened", "labels": ["B", "C", "D"]})
        self.assertEqual(conflicts, {})
        self.assertEqual(pending, {"title": "Local", "labels": ["B", "C", "D"]})

    def test_get_pagination_uses_numeric_pages_and_can_be_stopped(self):
        config = GitLabConnection.objects.create(enabled=True)
        client = gitlab.GitLabClient(config)
        with patch.object(client, "request", side_effect=[([{"id": 1}], "2"), ([{"id": 2}], "")]) as request:
            self.assertEqual(list(client.pages("/issues", scope="all")), [{"id": 1}, {"id": 2}])
            self.assertEqual(request.call_args_list[1].kwargs["query"]["page"], 2)
        config.enabled = False
        config.save(update_fields=["enabled"])
        with patch.object(client.opener, "open") as transport, self.assertRaises(gitlab.GitLabDisabled):
            client.get("/issues")
        transport.assert_not_called()

    def test_failed_get_does_not_expose_response_or_credentials(self):
        config = GitLabConnection.objects.create(enabled=True)
        client = gitlab.GitLabClient(config)
        with patch.object(gitlab, "_token", "fake-local-test-token"):
            with patch.object(client.opener, "open", side_effect=HTTPError("unused", 401, "secret-response", {}, None)):
                with self.assertRaises(gitlab.GitLabError) as error:
                    client.get("/user")
                self.assertEqual(str(error.exception), "Token inválido ou expirado.")
            with patch.object(client.opener, "open", side_effect=URLError("secret-proxy-url")):
                with self.assertRaises(gitlab.GitLabError) as error:
                    client.get("/user")
                self.assertNotIn("secret-proxy-url", str(error.exception))
