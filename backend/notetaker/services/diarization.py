from functools import lru_cache
from pathlib import Path

import numpy as np
from django.conf import settings
from django.db import transaction

from notetaker.models import AudioChunk, Speaker, TranscriptSegment

from .ollama import OllamaError, generate_json


MAX_REMOTE_SPEAKERS = 8
MIN_SPEAKER_SECONDS = 3.0
MAX_SPEAKER_NAME_TRANSCRIPT_CHARS = 8000

SPEAKER_NAMES_SCHEMA = {
    "type": "object",
    "properties": {
        "speakers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "name": {"type": "string"},
                    "evidence": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["label", "name", "evidence", "confidence"],
            },
        },
    },
    "required": ["speakers"],
}


@lru_cache(maxsize=1)
def get_diarizer():
    """Load the bundled ONNX diarizer without any runtime network access."""
    import sherpa_onnx

    segmentation = Path(settings.DIARIZATION_SEGMENTATION_MODEL)
    embedding = Path(settings.DIARIZATION_EMBEDDING_MODEL)
    if not segmentation.exists() or not embedding.exists():
        raise RuntimeError("Offline speaker diarization models are not installed.")
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(segmentation),
                window_shift_ratio=0.1,
            )
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding)),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.65),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("Invalid offline speaker diarization configuration.")
    return sherpa_onnx.OfflineSpeakerDiarization(config)


def _overlap(start_a, end_a, start_b, end_b):
    return max(0.0, min(end_a, end_b) - max(start_a, start_b))


def _speaker_name_chunks(lines):
    """Keep all turns available for name inference while bounding each request."""
    chunks = []
    current = []
    current_size = 0
    for line in lines:
        line_size = len(line) + 1
        if current and current_size + line_size > MAX_SPEAKER_NAME_TRANSCRIPT_CHARS:
            chunks.append("\n".join(current))
            current = current[-2:]
            current_size = sum(len(item) + 1 for item in current)
        current.append(line)
        current_size += line_size
    if current:
        chunks.append("\n".join(current))
    return chunks


def identify_speaker_names(session_id: int, check_active=None, set_progress=None):
    """Infer names for generic diarized labels from introductions and direct hand-offs."""
    speakers = list(
        Speaker.objects.filter(session_id=session_id, kind=Speaker.Kind.OTHER)
        .exclude(label="Outros")
        .filter(label__startswith="Participante ")
        .order_by("id")
    )
    if not speakers:
        return
    labels = {speaker.label: speaker for speaker in speakers}
    # Name hand-offs are normally spoken by somebody else, so include the full
    # session rather than only the generic participant's own turns.
    segments = TranscriptSegment.objects.filter(session_id=session_id).select_related("speaker", "chunk")
    transcript_lines = [f"[{segment.speaker.label}] {segment.text}" for segment in segments]
    transcript = "\n".join(transcript_lines)
    if not transcript.strip():
        return
    if check_active:
        check_active()
    chunks = _speaker_name_chunks(transcript_lines)
    candidates = []
    for index, chunk in enumerate(chunks):
        if set_progress:
            set_progress(
                80 + round(10 * index / len(chunks)),
                f"A identificar nomes ({index + 1}/{len(chunks)})",
            )
        prompt = (
            "Infer a speaker name only for a generic label when the transcript contains a proper name "
            "in context. Strong evidence includes an introduction by that label (for example 'sou a Rita') "
            "or a direct hand-off such as 'podes avancar, Antonio' immediately followed by Antonio's "
            "label speaking. The name must occur verbatim in the evidence. Do not rename existing "
            "non-generic labels. Return an empty speakers array when no name can be reasonably associated. "
            f"Valid labels: {', '.join(labels)}.\nTranscript part {index + 1} of {len(chunks)}:\n{chunk}"
        )
        try:
            result = generate_json(prompt, SPEAKER_NAMES_SCHEMA, max_output_tokens=256)
        except OllamaError:
            # Naming is optional: diarization itself remains useful if a part cannot be interpreted.
            continue
        candidates.extend(result.get("speakers", []))
    if check_active:
        check_active()
    if set_progress:
        set_progress(92, "A guardar participantes")
    best_candidates = {}
    for candidate in candidates:
        label = str(candidate.get("label", "")).strip()
        confidence = candidate.get("confidence", 0)
        if isinstance(confidence, (int, float)) and confidence > best_candidates.get(label, {}).get("confidence", -1):
            best_candidates[label] = candidate
    for candidate in best_candidates.values():
        label = str(candidate.get("label", "")).strip()
        name = " ".join(str(candidate.get("name", "")).split())[:120]
        evidence = str(candidate.get("evidence", "")).strip()
        confidence = candidate.get("confidence", 0)
        if (
            label not in labels
            or not name
            or not isinstance(confidence, (int, float))
            or confidence < 0.65
            or name.casefold() not in evidence.casefold()
            or evidence not in transcript
        ):
            continue
        speaker = labels[label]
        if not Speaker.objects.filter(session_id=session_id, label=name).exclude(pk=speaker.pk).exists():
            speaker.label = name
            speaker.save(update_fields=["label"])


def diarize_session(session_id: int, check_active=None, set_progress=None):
    """Identify remote voices across the session and label their transcript segments."""
    from faster_whisper.audio import decode_audio

    if check_active:
        check_active()
    if set_progress:
        set_progress(10, "A preparar áudio")
    chunks = list(
        AudioChunk.objects.filter(
            session_id=session_id,
            source=AudioChunk.Source.SYSTEM,
            status=AudioChunk.Status.COMPLETE,
        ).order_by("started_at")
    )
    if not chunks:
        return

    audio_parts = []
    chunk_offsets = {}
    cursor = 0.0
    for chunk in chunks:
        samples = decode_audio(chunk.file_path, sampling_rate=16000).astype(np.float32, copy=False)
        start = cursor
        cursor += len(samples) / 16000
        chunk_offsets[chunk.id] = start
        audio_parts.append(samples)
    if not audio_parts:
        return

    if set_progress:
        set_progress(30, "A identificar vozes")
    turns = list(get_diarizer().process(np.concatenate(audio_parts)).sort_by_start_time())
    if check_active:
        check_active()
    if not turns:
        return
    if set_progress:
        set_progress(65, "A associar participantes")

    speaker_durations = {}
    for turn in turns:
        speaker_durations[turn.speaker] = speaker_durations.get(turn.speaker, 0.0) + max(
            0.0, turn.end - turn.start
        )
    ranked_speakers = sorted(speaker_durations, key=speaker_durations.get, reverse=True)
    speaker_order = [
        speaker_id
        for speaker_id in ranked_speakers
        if speaker_durations[speaker_id] >= MIN_SPEAKER_SECONDS
    ][:MAX_REMOTE_SPEAKERS]
    if not speaker_order:
        speaker_order = ranked_speakers[:1]

    with transaction.atomic():
        if check_active:
            check_active()
        speakers = {}
        existing = list(
            Speaker.objects.filter(session_id=session_id, kind=Speaker.Kind.OTHER)
            .exclude(label="Outros")
            .order_by("id")
        )
        for index, speaker_id in enumerate(speaker_order, start=1):
            if index <= len(existing):
                speakers[speaker_id] = existing[index - 1]
            else:
                speakers[speaker_id], _ = Speaker.objects.get_or_create(
                    session_id=session_id,
                    label=f"Participante {index}",
                    defaults={"kind": Speaker.Kind.OTHER},
                )
        others, _ = Speaker.objects.get_or_create(
            session_id=session_id,
            label="Outros",
            defaults={"kind": Speaker.Kind.OTHER},
        )

        segments = list(
            TranscriptSegment.objects.filter(
                session_id=session_id,
                chunk__source=AudioChunk.Source.SYSTEM,
            ).select_related("chunk")
        )
        changed = []
        for segment in segments:
            base = chunk_offsets.get(segment.chunk_id)
            if base is None:
                continue
            start = base + segment.start_ms / 1000
            end = base + segment.end_ms / 1000
            best = max(turns, key=lambda turn: _overlap(start, end, turn.start, turn.end))
            if _overlap(start, end, best.start, best.end) <= 0:
                continue
            segment.speaker = speakers.get(best.speaker, others)
            changed.append(segment)
        TranscriptSegment.objects.bulk_update(changed, ["speaker"])
    identify_speaker_names(session_id, check_active=check_active, set_progress=set_progress)
