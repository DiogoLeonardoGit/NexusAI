"""Keep meeting audio, transcript coverage and the shared timeline consistent."""
from datetime import timedelta
from pathlib import Path
import uuid
import wave

from django.conf import settings
from django.db import transaction

from notetaker.models import AudioChunk, CaptureSession, ProcessingJob


def audio_path(chunk):
    """Only expose or modify files inside the application's audio directory."""
    if not chunk.file_path:
        return None
    path = Path(chunk.file_path).resolve()
    if not path.is_relative_to(settings.AUDIO_DIR.resolve()):
        return None
    return path if path.is_file() else None


def require_idle(session):
    if session.status != CaptureSession.Status.COMPLETE:
        raise ValueError("Termina a gravação antes de editar ou verificar o áudio.")
    if ProcessingJob.objects.filter(
        session=session, status__in=[ProcessingJob.Status.PENDING, ProcessingJob.Status.RUNNING],
    ).exists():
        raise ValueError("Aguarda o fim do processamento ou cancela-o primeiro.")


def verify_transcriptions(session):
    """Queue unfinished available chunks once; completed silence is valid coverage."""
    queued, missing, inconsistent, active_ids = [], [], [], []
    for chunk in session.audio_chunks.all():
        if chunk.status == AudioChunk.Status.COMPLETE:
            continue
        if chunk.segments.exists():
            inconsistent.append(chunk.pk)
            continue
        if not audio_path(chunk):
            missing.append(chunk.pk)
            continue
        active = ProcessingJob.objects.filter(
            chunk=chunk, kind=ProcessingJob.Kind.TRANSCRIBE,
            status__in=[ProcessingJob.Status.PENDING, ProcessingJob.Status.RUNNING],
        ).exists()
        if active:
            active_ids.append(chunk.pk)
            continue
        chunk.status, chunk.error = AudioChunk.Status.PENDING, ""
        chunk.save(update_fields=["status", "error"])
        queued.append(ProcessingJob.objects.create(
            session=session, chunk=chunk, kind=ProcessingJob.Kind.TRANSCRIBE,
        ).pk)
    return {"job_ids": queued, "missing_chunks": missing, "inconsistent_chunks": inconsistent,
            "active_chunks": active_ids,
            "validated": not queued and not missing and not inconsistent and not active_ids}


def _cut_audio(chunk, start_ms, end_ms):
    """Decode one recorder chunk and write precisely bounded, lossless PCM audio."""
    import numpy as np
    from faster_whisper.audio import decode_audio

    source = audio_path(chunk)
    if source is None:
        raise ValueError("Falta áudio num dos limites do corte. Não é possível recortá-lo.")
    try:
        samples = decode_audio(str(source), sampling_rate=16000)
    except (ValueError, RuntimeError, EOFError) as exc:
        raise ValueError("Não foi possível descodificar o áudio num dos limites do corte.") from exc
    first, last = round(start_ms * 16), round(end_ms * 16)
    selected = samples[first:last]
    if not len(selected):
        raise ValueError("O intervalo escolhido não contém áudio num dos limites.")
    destination = source.parent / f"{uuid.uuid4().hex}.wav"
    try:
        with wave.open(str(destination), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            output.writeframes((np.clip(selected, -1, 1) * 32767).astype("<i2").tobytes())
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return destination, round(len(selected) / 16)


def trim_session(session_id, start, end):
    """Stage boundary files before committing metadata; delete originals only afterwards."""
    staged, obsolete = [], []
    try:
        with transaction.atomic():
            session = CaptureSession.objects.select_for_update().get(pk=session_id)
            require_idle(session)
            if not session.ended_at or not session.started_at <= start < end <= session.ended_at:
                raise ValueError("Escolhe um intervalo válido dentro da reunião.")
            chunks = list(session.audio_chunks.all())
            retained = False
            for chunk in chunks:
                chunk_end = chunk.started_at + timedelta(milliseconds=chunk.duration_ms)
                if chunk.started_at >= end or chunk_end <= start:
                    path = audio_path(chunk)
                    if path:
                        obsolete.append(path)
                    chunk.delete()  # Also removes discarded transcript and job references.
                    continue
                retained = True
                left, right = max(start, chunk.started_at), min(end, chunk_end)
                if left == chunk.started_at and right == chunk_end:
                    continue
                destination, duration = _cut_audio(
                    chunk, (left - chunk.started_at).total_seconds() * 1000,
                    (right - chunk.started_at).total_seconds() * 1000,
                )
                staged.append(destination)
                obsolete.append(audio_path(chunk))
                chunk.segments.all().delete()
                chunk.file_path, chunk.mime_type = str(destination), "audio/wav"
                chunk.started_at, chunk.duration_ms = left, duration
                chunk.size_bytes = destination.stat().st_size
                chunk.status, chunk.error = AudioChunk.Status.PENDING, ""
                chunk.save()
            if not retained:
                raise ValueError("O intervalo escolhido não contém blocos de áudio.")
            session.started_at, session.ended_at = start, end
            session.save(update_fields=["started_at", "ended_at"])
            result = verify_transcriptions(session)
    except Exception:
        for path in staged:
            path.unlink(missing_ok=True)
        raise
    # Database references now point exclusively to retained audio. A failed unlink
    # is reported, rather than rolling back to originals already deleted.
    cleanup_errors = []
    for path in obsolete:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            cleanup_errors.append(path.name)
    result["cleanup_errors"] = cleanup_errors
    return result
