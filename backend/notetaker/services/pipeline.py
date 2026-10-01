from datetime import timedelta
import logging
from pathlib import Path
import threading

from django.db import transaction
from django.db import DatabaseError, close_old_connections
from django.db.models import Case, F, IntegerField, Q, Value, When
from django.utils import timezone

from notetaker.models import (
    ActiveListeningLog,
    AppSetting,
    AudioChunk,
    CaptureSession,
    Note,
    ProcessingJob,
    Reminder,
    Speaker,
    Summary,
    Task,
    TranscriptSegment,
    transcript_segment_sort_key,
)

from .dates import parse_spoken_date
from .diarization import diarize_session
from .ollama import ACTIVE_LISTENING_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT, OllamaError, generate_json
from .transcription import detect_language, transcribe


logger = logging.getLogger(__name__)

OLLAMA_INPUT_CHARS = 8000


class JobCancelled(Exception):
    pass


def _ensure_job_active(job_id, *, touch=False):
    updates = {"updated_at": timezone.now()} if touch else {}
    active = ProcessingJob.objects.filter(
        pk=job_id,
        status=ProcessingJob.Status.RUNNING,
    )
    if updates:
        if active.update(**updates):
            return
    elif active.exists():
        return
    raise JobCancelled


def _set_job_progress(job_id, percent, phase):
    now = timezone.now()
    active = ProcessingJob.objects.filter(
        pk=job_id,
        status=ProcessingJob.Status.RUNNING,
    )
    active.filter(progress_started_at__isnull=True).update(progress_started_at=now)
    updated = active.update(
        progress_percent=max(0, min(100, percent)),
        progress_phase=str(phase)[:120],
        updated_at=now,
    )
    if not updated:
        raise JobCancelled


def _analysis_chunks(material: str, limit: int = OLLAMA_INPUT_CHARS) -> list[str]:
    """Split complete meeting material into bounded, contiguous model inputs."""
    chunks = []
    current = []
    current_size = 0
    for line in material.splitlines():
        line_size = len(line) + 1
        if current and current_size + line_size > limit:
            chunks.append("\n".join(current))
            current = []
            current_size = 0
        if line_size > limit:
            if current:
                chunks.append("\n".join(current))
                current = []
                current_size = 0
            chunks.extend(line[offset : offset + limit] for offset in range(0, len(line), limit))
            continue
        current.append(line)
        current_size += line_size
    if current:
        chunks.append("\n".join(current))
    return chunks or ([material] if material else [])

TASK_SCHEMA = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "owner": {"enum": ["self", "other", "unknown"]},
                    "owner_name": {"type": "string"},
                    "date_phrase": {"type": "string"},
                    "confidence": {"type": "number"},
                    "evidence": {"type": "string"},
                    "due_is_ambiguous": {"type": "boolean"},
                },
                "required": ["title", "owner", "date_phrase", "confidence", "evidence"],
            },
        },
        "decisions": {"type": "array", "items": {"type": "string"}},
        "open_questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["tasks", "decisions", "open_questions"],
}


def recover_stale_jobs(max_age_minutes=15):
    """Requeue work abandoned by an interrupted backend without touching active inference."""
    stale = ProcessingJob.objects.filter(
        status=ProcessingJob.Status.RUNNING,
        updated_at__lt=timezone.now() - timedelta(minutes=max_age_minutes),
    )
    stale.filter(attempts__lt=3).update(
        status=ProcessingJob.Status.PENDING,
        error="Recovered after the previous worker stopped unexpectedly.",
    )
    stale.filter(attempts__gte=3).update(
        status=ProcessingJob.Status.FAILED,
        error="The previous worker stopped before this job completed.",
    )


def _job_heartbeat(job_id, stop_event):
    """Keep long native inference distinguishable from an abandoned worker."""
    while not stop_event.wait(60):
        close_old_connections()
        try:
            ProcessingJob.objects.filter(
                pk=job_id,
                status=ProcessingJob.Status.RUNNING,
            ).update(updated_at=timezone.now())
        except DatabaseError as exc:
            logger.warning("Could not update heartbeat for job %s: %s", job_id, exc)
        finally:
            close_old_connections()


def next_pending_job():
    """Prioritize transcription so summaries never run over an incomplete day."""
    priority = Case(
        When(kind=ProcessingJob.Kind.ACTIVE_LISTEN, then=Value(0)),
        When(kind=ProcessingJob.Kind.TRANSCRIBE, then=Value(1)),
        When(kind=ProcessingJob.Kind.SUMMARIZE, then=Value(2)),
        When(kind=ProcessingJob.Kind.EXTRACT, then=Value(3)),
        When(kind=ProcessingJob.Kind.DIARIZE, then=Value(4)),
        default=Value(5),
        output_field=IntegerField(),
    )
    return (
        ProcessingJob.objects.filter(status=ProcessingJob.Status.PENDING)
        .annotate(queue_priority=priority)
        .order_by("queue_priority", "created_at")
        .first()
    )


def _enqueue_untranscribed_chunks(session: CaptureSession, current_chunk_id=None):
    chunks = AudioChunk.objects.filter(session=session, segments__isnull=True).exclude(
        status=AudioChunk.Status.CANCELLED
    ).distinct()
    for candidate in chunks:
        if candidate.pk == current_chunk_id:
            continue
        if candidate.status != AudioChunk.Status.PENDING:
            candidate.status = AudioChunk.Status.PENDING
            candidate.save(update_fields=["status"])
        ProcessingJob.objects.get_or_create(
            kind=ProcessingJob.Kind.TRANSCRIBE,
            status=ProcessingJob.Status.PENDING,
            session=session,
            chunk=candidate,
        )


def _choose_session_language(session: CaptureSession, *, force=False):
    votes = list(
        session.audio_chunks.exclude(detected_language="")
        .exclude(language_confidence__isnull=True)
        .values_list("detected_language", "language_confidence")
    )
    reliable = [(language, confidence) for language, confidence in votes if confidence >= 0.35]
    if not force and len(reliable) < 4:
        return ""
    considered = reliable or votes
    if considered:
        totals = {
            language: sum(confidence for code, confidence in considered if code == language)
            for language in CaptureSession.Language.values
        }
        selected = max(totals, key=totals.get)
        total = sum(totals.values())
        confidence = totals[selected] / total if total else 0.5
    else:
        default = AppSetting.objects.filter(key="default_language").values_list("value", flat=True).first()
        selected = default if default in CaptureSession.Language.values else CaptureSession.Language.PORTUGUESE
        confidence = 0.0
    session.language = selected
    session.language_confidence = confidence
    session.save(update_fields=["language", "language_confidence"])
    return selected


def finalize_session_language(session: CaptureSession):
    """Lock short meetings to the best available vote and queue their waiting chunks."""
    if not session.language:
        _choose_session_language(session, force=True)
    _enqueue_untranscribed_chunks(session)


def process_transcription_job(job: ProcessingJob):
    """Transcribe without holding a SQLite write transaction during inference."""
    _ensure_job_active(job.pk)
    chunk = AudioChunk.objects.get(pk=job.chunk_id)
    chunk.status = AudioChunk.Status.PROCESSING
    chunk.save(update_fields=["status"])

    session = chunk.session
    language = session.language
    if not language:
        detected_language, confidence = detect_language(chunk.file_path)
        chunk.detected_language = detected_language
        chunk.language_confidence = confidence
        chunk.save(update_fields=["detected_language", "language_confidence"])
        language = _choose_session_language(session, force=session.status == CaptureSession.Status.COMPLETE)
        if not language:
            chunk.status = AudioChunk.Status.PENDING
            chunk.save(update_fields=["status"])
            return
        _enqueue_untranscribed_chunks(session, current_chunk_id=chunk.pk)

    glossary = AppSetting.objects.filter(key="transcription_glossary").values_list("value", flat=True).first()
    glossary = glossary if isinstance(glossary, str) else ""
    previous = (
        TranscriptSegment.objects.filter(session=session, chunk__started_at__lt=chunk.started_at)
        .order_by("-chunk__started_at", "-end_ms")
        .values_list("text", flat=True)[:4]
    )
    language_name = "português europeu" if language == "pt" else "English"
    initial_prompt = f"Idioma da reunião: {language_name}. " + " ".join(reversed(list(previous)))
    segments, language = transcribe(
        chunk.file_path,
        language,
        initial_prompt=initial_prompt[-1000:],
        hotwords=glossary,
    )

    # Keep the write transaction limited to persistence after inference.
    with transaction.atomic():
        _ensure_job_active(job.pk)
        chunk = AudioChunk.objects.select_for_update().select_related("session").get(pk=job.chunk_id)
        kind = Speaker.Kind.SELF if chunk.source == AudioChunk.Source.MICROPHONE else Speaker.Kind.OTHER
        label = "Eu" if kind == Speaker.Kind.SELF else "Outros"
        speaker, _ = Speaker.objects.get_or_create(
            session=chunk.session,
            label=label,
            defaults={"kind": kind},
        )
        created = [
            TranscriptSegment(
                session=chunk.session,
                chunk=chunk,
                speaker=speaker,
                language=language,
                **segment,
            )
            for segment in segments
        ]
        TranscriptSegment.objects.bulk_create(created)
        chunk.status = AudioChunk.Status.COMPLETE
        chunk.error = ""
        chunk.save(update_fields=["status", "error"])


def process_extraction_job(job: ProcessingJob):
    """Run Ollama outside the short transaction used to save extracted work."""
    segments = list(
        TranscriptSegment.objects.filter(session=job.session)
        .select_related("speaker", "chunk", "session")
    )
    segments.sort(key=transcript_segment_sort_key)
    transcript = "\n".join(f"[{s.speaker.label if s.speaker else 'Unknown'}] {s.text}" for s in segments)
    if not transcript:
        return
    language = job.session.language or CaptureSession.Language.PORTUGUESE
    requested_language = "Portuguese" if language == "pt" else "English"
    pieces = _analysis_chunks(transcript)
    results = []
    for index, piece in enumerate(pieces):
        _ensure_job_active(job.pk)
        results.append(generate_json(
            f"Extract actionable information from part {index + 1} of {len(pieces)}. "
            f"Write in {requested_language}.\n{piece}",
            TASK_SCHEMA,
            system_prompt=EXTRACTION_SYSTEM_PROMPT,
        ))
        _set_job_progress(
            job.pk,
            10 + round(75 * (index + 1) / len(pieces)),
            f"A extrair tarefas ({index + 1}/{len(pieces)})",
        )
        ProcessingJob.objects.filter(pk=job.pk).update(updated_at=timezone.now())

    with transaction.atomic():
        _ensure_job_active(job.pk)
        known_titles = {
            title.strip().casefold()
            for title in Task.objects.filter(session=job.session).values_list("title", flat=True)
        }
        for item in (task for result in results for task in result.get("tasks", [])):
            title = str(item.get("title", "")).strip()
            normalized_title = title.casefold()
            if not title or normalized_title in known_titles:
                continue
            known_titles.add(normalized_title)
            phrase = str(item.get("date_phrase", "")).strip()
            parsed = parse_spoken_date(phrase, job.session.started_at) if phrase else None
            ambiguous = bool(item.get("due_is_ambiguous", False)) or (parsed.ambiguous if parsed else False)
            task, _ = Task.objects.get_or_create(
                session=job.session,
                title=title,
                defaults={
                    "description": str(item.get("description", "")).strip(),
                    "owner": item.get("owner", Task.Owner.UNKNOWN),
                    "owner_name": str(item.get("owner_name", ""))[:120],
                    "date_phrase": phrase[:240],
                    "due_at": parsed.value if parsed else None,
                    "due_is_ambiguous": ambiguous,
                    "status": Task.Status.PENDING_CONFIRMATION if ambiguous else Task.Status.TODO,
                    "confidence": item.get("confidence"),
                    "evidence": str(item.get("evidence", ""))[:2000],
                },
            )
            if task.due_at and not task.due_is_ambiguous:
                Reminder.objects.get_or_create(task=task, remind_at=task.due_at)


def process_active_listening_job(job: ProcessingJob):
    """Persist the transcript, extract personal tasks, and discard active-listening audio."""
    path = Path(job.temporary_audio_path)
    if not path.is_file():
        raise RuntimeError("Temporary active-listening audio is no longer available.")
    language = AppSetting.objects.filter(key="default_language").values_list("value", flat=True).first()
    language = language if language in CaptureSession.Language.values else CaptureSession.Language.PORTUGUESE
    glossary = AppSetting.objects.filter(key="transcription_glossary").values_list("value", flat=True).first()
    segments, detected_language = transcribe(str(path), language, hotwords=glossary or "")
    transcript = " ".join(segment["text"] for segment in segments).strip()
    if not transcript:
        return
    ActiveListeningLog.objects.create(
        text=transcript,
        language=detected_language or language,
        recorded_at=job.created_at,
    )
    requested_language = "Portuguese" if detected_language == "pt" else "English"
    result = generate_json(
        f"Extract only explicit personal tasks or reminders. Write in {requested_language}.\n{transcript}",
        TASK_SCHEMA,
        system_prompt=ACTIVE_LISTENING_SYSTEM_PROMPT,
    )
    with transaction.atomic():
        for item in result.get("tasks", []):
            title = str(item.get("title", "")).strip()
            if not title or Task.objects.filter(
                session__isnull=True,
                title__iexact=title,
                created_at__gte=job.created_at - timedelta(minutes=10),
            ).exists():
                continue
            phrase = str(item.get("date_phrase", "")).strip()
            parsed = parse_spoken_date(phrase, job.created_at) if phrase else None
            ambiguous = bool(item.get("due_is_ambiguous", False)) or (parsed.ambiguous if parsed else False)
            task = Task.objects.create(
                title=title,
                description=str(item.get("description", "")).strip(),
                owner=Task.Owner.SELF,
                status=Task.Status.PENDING_CONFIRMATION if ambiguous else Task.Status.TODO,
                date_phrase=phrase[:240],
                due_at=parsed.value if parsed else None,
                due_is_ambiguous=ambiguous,
                confidence=item.get("confidence"),
                evidence="",
                creation_source=Task.CreationSource.SYSTEM,
            )
            if task.due_at and not task.due_is_ambiguous:
                Reminder.objects.create(task=task, remind_at=task.due_at)


SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "decisions": {"type": "array", "items": {"type": "string"}},
        "open_questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "summary", "decisions", "open_questions"],
}


def _clean_list(values):
    return [str(value).strip() for value in values or [] if str(value).strip()]


def _short_title(value):
    return " ".join(str(value or "").strip().split()[:10])[:240]


def _keyword_title(transcript):
    for line in transcript.splitlines():
        text = line.split("]", 1)[-1].strip() if line.startswith("[") else line.strip()
        title = _short_title(text)
        if title:
            return title
    return ""


def _summarize_material(material: str, label: str, language: str, heartbeat=None):
    requested_language = "Portuguese" if language == "pt" else "English"
    chunk_size = OLLAMA_INPUT_CHARS
    pieces = [material[index : index + chunk_size] for index in range(0, len(material), chunk_size)]
    partials = []
    for index, piece in enumerate(pieces, start=1):
        if heartbeat:
            heartbeat()
        partials.append(
            generate_json(
                f"Summarize part {index}/{len(pieces)} of {label} in {requested_language}. "
                f"Create a descriptive title with at most 10 words:\n{piece}",
                SUMMARY_SCHEMA,
                system_prompt=SUMMARY_SYSTEM_PROMPT,
                max_output_tokens=512 if len(pieces) > 1 else 768,
            )
        )
        if heartbeat:
            heartbeat()
    if len(partials) == 1:
        result = partials[0]
    else:
        combined = "\n\n".join(
            f"Partial summary: {item.get('summary', '')}\n"
            f"Decisions: {_clean_list(item.get('decisions'))}\n"
            f"Open questions: {_clean_list(item.get('open_questions'))}"
            for item in partials
        )
        result = generate_json(
            f"Create one final {label} summary in {requested_language}, including a descriptive "
            f"title with at most 10 words:\n{combined}",
            SUMMARY_SCHEMA,
            system_prompt=SUMMARY_SYSTEM_PROMPT,
            max_output_tokens=768,
        )
        if heartbeat:
            heartbeat()
    result["decisions"] = _clean_list(result.get("decisions"))
    result["open_questions"] = _clean_list(result.get("open_questions"))
    return result

def _summarize_complete_transcript(job, transcript, prompt_label, language):
    """Map every transcript part and reduce partial results into one summary."""
    pieces = _analysis_chunks(transcript)
    if len(pieces) == 1:
        return _summarize_material(
            pieces[0],
            prompt_label,
            language,
            heartbeat=lambda: _ensure_job_active(job.pk, touch=True),
        )

    partials = []
    for index, piece in enumerate(pieces):
        _set_job_progress(
            job.pk,
            20 + round(55 * index / len(pieces)),
            f"A resumir parte {index + 1}/{len(pieces)}",
        )
        partials.append(_summarize_material(
            piece,
            f"part {index + 1} of {len(pieces)} of the {prompt_label}",
            language,
            heartbeat=lambda: _ensure_job_active(job.pk, touch=True),
        ))

    consolidated = "\n\n".join(
        "\n".join([
            f"Part {index + 1}: {partial.get('summary', '')}",
            f"Decisions: {'; '.join(partial.get('decisions', []))}",
            f"Open questions: {'; '.join(partial.get('open_questions', []))}",
        ])
        for index, partial in enumerate(partials)
    )
    _set_job_progress(job.pk, 80, "A consolidar o resumo")
    return _summarize_material(
        consolidated,
        f"complete {prompt_label} from chronological partial summaries",
        language,
        heartbeat=lambda: _ensure_job_active(job.pk, touch=True),
    )


def process_summary_job(job: ProcessingJob):
    """Generate the summary before opening the transaction that stores it."""
    transcript = ""
    if job.session_id:
        segments = list(
            TranscriptSegment.objects.filter(session=job.session).select_related(
                "speaker", "chunk", "session"
            )
        )
        segments.sort(key=transcript_segment_sort_key)
        prompt_label = "meeting"
        language = job.session.language or CaptureSession.Language.PORTUGUESE
    else:
        summary_date = job.summary_date or timezone.localdate()
        meetings = list(CaptureSession.objects.filter(
            started_at__date=summary_date,
        ).order_by("started_at"))
        languages = [meeting.language for meeting in meetings if meeting.language]
        language = max(set(languages), key=languages.count) if languages else CaptureSession.Language.PORTUGUESE
        daily_parts = []
        for meeting in meetings:
            meeting_summary = Summary.objects.filter(
                session=meeting,
                kind=Summary.Kind.MEETING,
            ).first()
            if meeting_summary:
                material = meeting_summary.content
            else:
                meeting_segments = list(meeting.segments.select_related("speaker", "chunk", "session"))
                meeting_segments.sort(key=transcript_segment_sort_key)
                material = "\n".join(
                    f"[{segment.speaker.label if segment.speaker else 'Unknown'}] {segment.text}"
                    for segment in meeting_segments
                )
            if material.strip():
                daily_parts.append(f"Meeting: {meeting.title or 'Untitled meeting'}\n{material}")
        tasks = Task.objects.filter(
            Q(created_at__date=summary_date) | Q(completed_at__date=summary_date)
        ).distinct()
        notes = Note.objects.filter(created_at__date=summary_date)
        daily_parts.extend(f"Task [{task.status}]: {task.title}" for task in tasks)
        daily_parts.extend(f"Personal note: {note.body}" for note in notes)
        transcript = "\n".join(daily_parts)
        prompt_label = f"work day {summary_date.isoformat()}"
        segments = []
    if job.session_id:
        transcript = "\n".join(
            f"[{segment.speaker.label if segment.speaker else 'Unknown'}] {segment.text}"
            for segment in segments
        )
    if not transcript.strip():
        raise RuntimeError("No transcript is available to generate the summary.")
    _set_job_progress(job.pk, 25, "A analisar com IA")
    result = _summarize_complete_transcript(job, transcript, prompt_label, language)
    _set_job_progress(job.pk, 90, "A guardar o resumo")
    with transaction.atomic():
        _ensure_job_active(job.pk)
        Summary.objects.update_or_create(
            session=job.session,
            kind=Summary.Kind.MEETING if job.session_id else Summary.Kind.DAILY,
            summary_date=None if job.session_id else summary_date,
            defaults={
                "content": str(result.get("summary", "")).strip(),
                "decisions": result.get("decisions", []),
                "open_questions": result.get("open_questions", []),
            },
        )
        if job.session_id and (not job.session.title or job.session.title.startswith("Sessão ")):
            _set_job_progress(job.pk, 95, "A renomear a sessão")
            _ensure_job_active(job.pk)
            title = _short_title(result.get("title")) or _keyword_title(transcript)
            if title:
                CaptureSession.objects.filter(pk=job.session_id).update(title=title)


def process_job(job: ProcessingJob):
    claimed = ProcessingJob.objects.filter(
        pk=job.pk,
        status=ProcessingJob.Status.PENDING,
    ).update(
        status=ProcessingJob.Status.RUNNING,
        attempts=F("attempts") + 1,
        updated_at=timezone.now(),
    )
    if not claimed:
        return
    job.refresh_from_db()
    heartbeat_stop = threading.Event()
    heartbeat = threading.Thread(
        target=_job_heartbeat,
        args=(job.pk, heartbeat_stop),
        name=f"job-heartbeat-{job.pk}",
        daemon=True,
    )
    heartbeat.start()
    try:
        if job.kind == ProcessingJob.Kind.EXTRACT:
            ProcessingJob.objects.filter(
                kind=job.kind,
                status=ProcessingJob.Status.PENDING,
                session=job.session,
            ).exclude(pk=job.pk).update(status=ProcessingJob.Status.COMPLETE, error="Superseded by a consolidated job.")
        elif job.kind == ProcessingJob.Kind.SUMMARIZE:
            ProcessingJob.objects.filter(
                kind=job.kind,
                status=ProcessingJob.Status.PENDING,
                session=job.session,
                summary_date=job.summary_date,
            ).exclude(pk=job.pk).update(status=ProcessingJob.Status.COMPLETE, error="Superseded by a consolidated job.")
        if job.kind == ProcessingJob.Kind.TRANSCRIBE:
            process_transcription_job(job)
        elif job.kind == ProcessingJob.Kind.ACTIVE_LISTEN:
            process_active_listening_job(job)
        elif job.kind == ProcessingJob.Kind.EXTRACT:
            process_extraction_job(job)
        elif job.kind == ProcessingJob.Kind.DIARIZE:
            diarize_session(
                job.session_id,
                check_active=lambda: _ensure_job_active(job.pk),
                set_progress=lambda percent, phase: _set_job_progress(job.pk, percent, phase),
            )
        elif job.kind == ProcessingJob.Kind.SUMMARIZE:
            process_summary_job(job)
        job.status = ProcessingJob.Status.COMPLETE
        job.error = ""
    except JobCancelled:
        job.status = ProcessingJob.Status.CANCELLED
        job.error = "Cancelado pelo utilizador."
    except Exception as exc:
        job.status = ProcessingJob.Status.FAILED if isinstance(exc, OllamaError) or job.kind == ProcessingJob.Kind.ACTIVE_LISTEN else (
            ProcessingJob.Status.FAILED if job.attempts >= 3 else ProcessingJob.Status.PENDING
        )
        job.error = str(exc)[:4000]
        if job.chunk_id:
            AudioChunk.objects.filter(pk=job.chunk_id).exclude(
                status=AudioChunk.Status.CANCELLED
            ).update(status=AudioChunk.Status.FAILED, error=job.error)
        if job.status == ProcessingJob.Status.FAILED and job.session_id:
            downstream = {
                ProcessingJob.Kind.DIARIZE: [ProcessingJob.Kind.SUMMARIZE, ProcessingJob.Kind.EXTRACT],
                ProcessingJob.Kind.SUMMARIZE: [ProcessingJob.Kind.EXTRACT],
            }.get(job.kind, [])
            ProcessingJob.objects.filter(
                session_id=job.session_id,
                kind__in=downstream,
                status=ProcessingJob.Status.PENDING,
                created_at__gte=job.created_at,
            ).update(
                status=ProcessingJob.Status.CANCELLED,
                error="Cancelado porque uma fase anterior falhou.",
                updated_at=timezone.now(),
            )
    finally:
        heartbeat_stop.set()
        heartbeat.join(timeout=2)
        if job.kind == ProcessingJob.Kind.ACTIVE_LISTEN and job.temporary_audio_path:
            Path(job.temporary_audio_path).unlink(missing_ok=True)
    ProcessingJob.objects.filter(pk=job.pk).exclude(
        status=ProcessingJob.Status.CANCELLED
    ).update(status=job.status, error=job.error, updated_at=timezone.now())

    if job.kind == ProcessingJob.Kind.ACTIVE_LISTEN:
        ProcessingJob.objects.filter(pk=job.pk).delete()