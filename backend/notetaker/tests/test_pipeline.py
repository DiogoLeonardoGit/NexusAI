from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from notetaker.models import (
    AudioChunk,
    CaptureSession,
    ProcessingJob,
    Reminder,
    Speaker,
    Task,
    TranscriptSegment,
)
from notetaker.services.pipeline import next_pending_job, process_job, recover_stale_jobs
from notetaker.services.ollama import OllamaError
from notetaker.services.diarization import identify_speaker_names


class PipelineTests(TestCase):
    def setUp(self):
        self.session = CaptureSession.objects.create(title="Test", started_at=timezone.now())

    @patch("notetaker.services.pipeline.transcribe")
    def test_transcription_uses_locked_session_language(self, transcribe):
        self.session.language = CaptureSession.Language.PORTUGUESE
        self.session.save(update_fields=["language"])
        transcribe.return_value = (
            [{"start_ms": 0, "end_ms": 1200, "text": "Faço amanhã.", "confidence": 0.9}],
            "pt",
        )
        chunk = AudioChunk.objects.create(
            session=self.session,
            source=AudioChunk.Source.MICROPHONE,
            file_path="unused.webm",
            started_at=timezone.now(),
        )
        job = ProcessingJob.objects.create(kind=ProcessingJob.Kind.TRANSCRIBE, chunk=chunk, session=self.session)
        process_job(job)
        job.refresh_from_db()
        self.assertEqual(job.status, ProcessingJob.Status.COMPLETE)
        self.assertEqual(TranscriptSegment.objects.count(), 1)
        self.assertFalse(ProcessingJob.objects.filter(kind=ProcessingJob.Kind.EXTRACT).exists())
        self.assertEqual(transcribe.call_args.args[1], CaptureSession.Language.PORTUGUESE)

    @patch("notetaker.services.pipeline.transcribe")
    @patch("notetaker.services.pipeline.detect_language")
    def test_language_is_locked_after_four_supported_votes(self, detect_language, transcribe):
        detect_language.return_value = (CaptureSession.Language.PORTUGUESE, 0.9)
        transcribe.return_value = (
            [{"start_ms": 0, "end_ms": 1000, "text": "Bom dia.", "confidence": 0.9}],
            "pt",
        )
        jobs = []
        for index in range(4):
            chunk = AudioChunk.objects.create(
                session=self.session,
                source=AudioChunk.Source.MICROPHONE,
                file_path=f"unused-{index}.webm",
                started_at=timezone.now() + timezone.timedelta(seconds=index),
            )
            jobs.append(ProcessingJob.objects.create(
                kind=ProcessingJob.Kind.TRANSCRIBE,
                chunk=chunk,
                session=self.session,
            ))
            process_job(jobs[-1])
        self.session.refresh_from_db()
        self.assertEqual(self.session.language, CaptureSession.Language.PORTUGUESE)
        self.assertTrue(ProcessingJob.objects.filter(
            kind=ProcessingJob.Kind.TRANSCRIBE,
            status=ProcessingJob.Status.PENDING,
        ).exists())
        self.assertEqual(TranscriptSegment.objects.count(), 1)

    def test_transcription_jobs_have_queue_priority(self):
        ProcessingJob.objects.create(kind=ProcessingJob.Kind.SUMMARIZE, session=self.session)
        ProcessingJob.objects.create(kind=ProcessingJob.Kind.EXTRACT, session=self.session)
        expected = ProcessingJob.objects.create(kind=ProcessingJob.Kind.TRANSCRIBE, session=self.session)
        self.assertEqual(next_pending_job(), expected)

    def test_stale_running_job_is_recovered(self):
        job = ProcessingJob.objects.create(
            kind=ProcessingJob.Kind.SUMMARIZE,
            session=self.session,
            status=ProcessingJob.Status.RUNNING,
            attempts=1,
        )
        ProcessingJob.objects.filter(pk=job.pk).update(
            updated_at=timezone.now() - timezone.timedelta(minutes=20)
        )
        recover_stale_jobs()
        job.refresh_from_db()
        self.assertEqual(job.status, ProcessingJob.Status.PENDING)

    def test_job_is_only_claimed_once(self):
        job = ProcessingJob.objects.create(kind=ProcessingJob.Kind.SUMMARIZE, session=self.session)
        with patch("notetaker.services.pipeline.process_summary_job") as summarize:
            process_job(job)
            process_job(job)
        self.assertEqual(summarize.call_count, 1)

    @patch("notetaker.services.pipeline.process_summary_job", side_effect=OllamaError("invalid JSON"))
    def test_invalid_ollama_output_fails_without_automatic_retry(self, summarize):
        job = ProcessingJob.objects.create(kind=ProcessingJob.Kind.SUMMARIZE, session=self.session)
        process_job(job)
        job.refresh_from_db()
        self.assertEqual(job.status, ProcessingJob.Status.FAILED)
        self.assertEqual(job.attempts, 1)

    @patch("notetaker.services.pipeline.generate_json")
    def test_extraction_creates_task_and_reminder(self, generate_json):
        chunk = AudioChunk.objects.create(
            session=self.session,
            source=AudioChunk.Source.MICROPHONE,
            file_path="unused.webm",
            started_at=timezone.now(),
        )
        TranscriptSegment.objects.create(
            session=self.session,
            chunk=chunk,
            start_ms=0,
            end_ms=1000,
            text="Amanhã ao final da tarde envio a proposta.",
        )
        generate_json.return_value = {
            "tasks": [{
                "title": "Enviar a proposta",
                "owner": "self",
                "owner_name": "",
                "date_phrase": "amanhã ao final da tarde",
                "confidence": 0.95,
                "evidence": "envio a proposta",
                "due_is_ambiguous": False,
            }],
            "decisions": [],
            "open_questions": [],
        }
        job = ProcessingJob.objects.create(kind=ProcessingJob.Kind.EXTRACT, session=self.session)
        process_job(job)
        task = Task.objects.get()
        self.assertEqual(task.due_at.hour, 17)
        self.assertTrue(Reminder.objects.filter(task=task).exists())

    @patch("notetaker.services.diarization.generate_json")
    def test_explicit_self_introduction_renames_diarized_speaker(self, generate_json):
        speaker = Speaker.objects.create(
            session=self.session,
            label="Participante 1",
            kind=Speaker.Kind.OTHER,
        )
        chunk = AudioChunk.objects.create(
            session=self.session,
            source=AudioChunk.Source.SYSTEM,
            file_path="unused.webm",
            started_at=timezone.now(),
        )
        TranscriptSegment.objects.create(
            session=self.session,
            chunk=chunk,
            speaker=speaker,
            start_ms=0,
            end_ms=1000,
            text="Bom dia, sou a Rita.",
        )
        generate_json.return_value = {
            "speakers": [{
                "label": "Participante 1",
                "name": "Rita",
                "evidence": "Bom dia, sou a Rita.",
                "confidence": 0.95,
            }]
        }
        identify_speaker_names(self.session.id)
        speaker.refresh_from_db()
        self.assertEqual(speaker.label, "Rita")

    @patch("notetaker.services.diarization.generate_json")
    def test_direct_handoff_renames_the_next_generic_speaker(self, generate_json):
        first = Speaker.objects.create(session=self.session, label="Participante 1", kind=Speaker.Kind.OTHER)
        second = Speaker.objects.create(session=self.session, label="Participante 2", kind=Speaker.Kind.OTHER)
        chunk = AudioChunk.objects.create(
            session=self.session,
            source=AudioChunk.Source.SYSTEM,
            file_path="unused.webm",
            started_at=timezone.now(),
        )
        TranscriptSegment.objects.create(
            session=self.session, chunk=chunk, speaker=first, start_ms=0, end_ms=1000,
            text="Podes avancar com a explicacao, Antonio.",
        )
        TranscriptSegment.objects.create(
            session=self.session, chunk=chunk, speaker=second, start_ms=1000, end_ms=2000,
            text="Claro, vou explicar a proposta.",
        )
        generate_json.return_value = {
            "speakers": [{
                "label": "Participante 2", "name": "Antonio",
                "evidence": "Podes avancar com a explicacao, Antonio.", "confidence": 0.8,
            }]
        }
        identify_speaker_names(self.session.id)
        second.refresh_from_db()
        self.assertEqual(second.label, "Antonio")

    @patch("notetaker.services.diarization.generate_json")
    def test_name_is_not_applied_when_not_present_in_evidence(self, generate_json):
        speaker = Speaker.objects.create(session=self.session, label="Participante 1", kind=Speaker.Kind.OTHER)
        chunk = AudioChunk.objects.create(
            session=self.session, source=AudioChunk.Source.SYSTEM, file_path="unused.webm", started_at=timezone.now()
        )
        TranscriptSegment.objects.create(
            session=self.session, chunk=chunk, speaker=speaker, start_ms=0, end_ms=1000, text="Podes avancar."
        )
        generate_json.return_value = {
            "speakers": [{
                "label": "Participante 1", "name": "Antonio", "evidence": "Podes avancar.", "confidence": 0.9,
            }]
        }
        identify_speaker_names(self.session.id)
        speaker.refresh_from_db()
        self.assertEqual(speaker.label, "Participante 1")
