import tempfile
from datetime import timedelta
from pathlib import Path

from django.test import TestCase, override_settings
from django.utils import timezone

from notetaker.models import AudioChunk, CaptureSession
from notetaker.services.retention import enforce_retention


class RetentionTests(TestCase):
    def test_expired_completed_audio_is_deleted_but_row_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / "old.webm"
            audio.write_bytes(b"audio")
            session = CaptureSession.objects.create(started_at=timezone.now() - timedelta(days=8))
            chunk = AudioChunk.objects.create(
                session=session,
                source=AudioChunk.Source.SYSTEM,
                file_path=str(audio),
                started_at=timezone.now() - timedelta(days=8),
                size_bytes=5,
                status=AudioChunk.Status.COMPLETE,
            )
            AudioChunk.objects.filter(pk=chunk.pk).update(created_at=timezone.now() - timedelta(days=8))
            with override_settings(AUDIO_DIR=root, AUDIO_RETENTION_DAYS=7, AUDIO_MAX_BYTES=100):
                self.assertEqual(enforce_retention(), 1)
            chunk.refresh_from_db()
            self.assertFalse(audio.exists())
            self.assertEqual(chunk.file_path, "")
