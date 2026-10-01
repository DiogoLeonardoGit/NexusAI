import tempfile
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from notetaker.models import AudioChunk, CaptureSession, ProcessingJob, Reminder, Task, TranscriptSegment


@override_settings(LOCAL_API_TOKEN="test-token")
class ApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.client.credentials(HTTP_X_LOCAL_TOKEN="test-token")

    def test_create_session_and_complete_it(self):
        response = self.client.post(
            "/api/sessions/",
            {"title": "Planning", "started_at": timezone.now().isoformat()},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        complete = self.client.post(f"/api/sessions/{response.data['id']}/complete/")
        self.assertEqual(complete.status_code, 200)
        self.assertEqual(complete.data["status"], CaptureSession.Status.COMPLETE)
        self.assertTrue(
            ProcessingJob.objects.filter(
                session_id=response.data["id"], kind=ProcessingJob.Kind.SUMMARIZE
            ).exists()
        )

    def test_bulk_upsert_saves_settings_in_one_request(self):
        response = self.client.post(
            "/api/settings/bulk_upsert/",
            {
                "settings": {
                    "audio_retention_days": 3,
                    "audio_max_bytes": 1024,
                    "default_language": "pt",
                    "transcription_glossary": "António, Rita",
                }
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 4)

    def test_completed_summary_job_without_summary_is_retryable(self):
        session = CaptureSession.objects.create(
            status=CaptureSession.Status.COMPLETE,
            started_at=timezone.now(),
        )
        chunk = AudioChunk.objects.create(
            session=session,
            source=AudioChunk.Source.MICROPHONE,
            file_path="unused.webm",
            started_at=timezone.now(),
            status=AudioChunk.Status.COMPLETE,
        )
        ProcessingJob.objects.create(
            kind=ProcessingJob.Kind.SUMMARIZE,
            session=session,
            status=ProcessingJob.Status.COMPLETE,
        )
        response = self.client.get(f"/api/sessions/{session.id}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["processing"]["state"], "failed")
        self.assertTrue(response.data["processing"]["retryable"])

    def test_regenerate_summary_queues_only_a_summary_job(self):
        session = CaptureSession.objects.create(
            status=CaptureSession.Status.COMPLETE,
            started_at=timezone.now(),
        )
        AudioChunk.objects.create(
            session=session,
            source=AudioChunk.Source.MICROPHONE,
            file_path="unused.webm",
            started_at=timezone.now(),
            status=AudioChunk.Status.COMPLETE,
        )
        response = self.client.post(f"/api/sessions/{session.id}/regenerate_summary/")
        self.assertEqual(response.status_code, 202)
        self.assertTrue(ProcessingJob.objects.filter(
            session=session,
            kind=ProcessingJob.Kind.SUMMARIZE,
            status=ProcessingJob.Status.PENDING,
        ).exists())
        self.assertFalse(ProcessingJob.objects.filter(
            session=session,
            kind__in=[ProcessingJob.Kind.EXTRACT, ProcessingJob.Kind.DIARIZE],
        ).exists())

    def test_complete_session_uses_the_capture_stop_time(self):
        session = CaptureSession.objects.create(title="Planning", started_at=timezone.now())
        ended_at = timezone.now() - timezone.timedelta(seconds=5)
        response = self.client.post(
            f"/api/sessions/{session.id}/complete/",
            {"ended_at": ended_at.isoformat()},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        session.refresh_from_db()
        self.assertEqual(session.status, CaptureSession.Status.COMPLETE)
        self.assertAlmostEqual(session.ended_at.timestamp(), ended_at.timestamp(), delta=0.001)

    def test_confirm_task_due_date_creates_reminder(self):
        task = Task.objects.create(
            title="Enviar proposta",
            status=Task.Status.PENDING_CONFIRMATION,
            due_is_ambiguous=True,
        )
        due = timezone.now() + timezone.timedelta(hours=2)
        response = self.client.post(
            f"/api/tasks/{task.id}/confirm_due/", {"due_at": due.isoformat()}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["due_is_ambiguous"])
        self.assertTrue(Reminder.objects.filter(task=task).exists())

    def test_schedule_task_creates_advance_reminder(self):
        task = Task.objects.create(title="Preparar reunião")
        due = timezone.now() + timezone.timedelta(days=1)
        response = self.client.post(
            f"/api/tasks/{task.id}/schedule/",
            {"due_at": due.isoformat(), "minutes_before": 60},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        reminder = Reminder.objects.get(task=task, status=Reminder.Status.SCHEDULED)
        self.assertAlmostEqual(
            (due - reminder.remind_at).total_seconds(),
            3600,
            delta=1,
        )
        self.assertEqual(response.data["reminder_minutes_before"], 60)
        self.assertEqual(response.data["reminder_status"], Reminder.Status.SCHEDULED)

    def test_schedule_rejects_reminder_time_in_the_past(self):
        task = Task.objects.create(title="Preparar reunião")
        due = timezone.now() + timezone.timedelta(minutes=5)
        response = self.client.post(
            f"/api/tasks/{task.id}/schedule/",
            {"due_at": due.isoformat(), "minutes_before": 15},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Reminder.objects.filter(task=task).exists())

    @patch("notetaker.views.generate_json")
    def test_chat_rejects_unverified_citation_ids(self, generate_json):
        generate_json.return_value = {"answer": "Sem evidência.", "segment_ids": [999]}
        response = self.client.post("/api/chat/", {"question": "O que ficou decidido?"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["segment_ids"], [])

    @patch("notetaker.views.generate_json")
    def test_chat_turns_inline_citation_into_structured_source(self, generate_json):
        session = CaptureSession.objects.create(title="Onboarding", started_at=timezone.now())
        chunk = AudioChunk.objects.create(
            session=session,
            source=AudioChunk.Source.MICROPHONE,
            file_path="unused.webm",
            started_at=timezone.now(),
        )
        segment = TranscriptSegment.objects.create(
            session=session,
            chunk=chunk,
            start_ms=0,
            end_ms=1000,
            text="Falámos sobre o processo de onboarding.",
        )
        generate_json.return_value = {
            "answer": f"Sim. [segment:{segment.id}; meeting:{session.id}; speaker:Eu]",
            "segment_ids": [],
        }
        response = self.client.post("/api/chat/", {"question": "Falámos sobre onboarding?"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["answer"], "Sim.")
        self.assertEqual(response.data["segment_ids"], [segment.id])
        self.assertEqual(response.data["sources"][0]["meeting_id"], session.id)
