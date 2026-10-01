from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.utils import timezone

from notetaker.models import AppSetting, AudioChunk


def delete_audio_file(chunk: AudioChunk) -> bool:
    path = Path(chunk.file_path)
    try:
        path.resolve().relative_to(settings.AUDIO_DIR.resolve())
    except ValueError:
        return False
    path.unlink(missing_ok=True)
    chunk.file_path = ""
    chunk.size_bytes = 0
    chunk.save(update_fields=["file_path", "size_bytes"])
    return True


def enforce_retention() -> int:
    """Delete only completed audio, oldest first, while preserving transcripts."""
    deleted = 0
    retention_days = AppSetting.objects.filter(key="audio_retention_days").values_list("value", flat=True).first()
    max_bytes = AppSetting.objects.filter(key="audio_max_bytes").values_list("value", flat=True).first()
    retention_days = max(1, min(int(retention_days or settings.AUDIO_RETENTION_DAYS), 7))
    max_bytes = max(100 * 1024**2, int(max_bytes or settings.AUDIO_MAX_BYTES))
    cutoff = timezone.now() - timedelta(days=retention_days)
    eligible = AudioChunk.objects.filter(status=AudioChunk.Status.COMPLETE).exclude(file_path="")
    for chunk in eligible.filter(created_at__lt=cutoff).order_by("created_at"):
        deleted += int(delete_audio_file(chunk))

    remaining = eligible.exclude(file_path="").order_by("created_at")
    total = sum(remaining.values_list("size_bytes", flat=True))
    if total > max_bytes:
        for chunk in remaining:
            if total <= max_bytes:
                break
            size = chunk.size_bytes
            if delete_audio_file(chunk):
                total -= size
                deleted += 1
    return deleted
