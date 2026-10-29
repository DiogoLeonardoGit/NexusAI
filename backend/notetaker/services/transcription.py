from functools import lru_cache
from collections import Counter
import math
from pathlib import Path
import re

from django.conf import settings


def is_header_only_webm(path: str) -> bool:
    """Recognize Chromium's empty WebM header followed only by zero padding.

    Match this specific recorder output rather than suppressing decoder errors
    from truncated or otherwise damaged audio files.
    """
    source = Path(path)
    if not source.is_file() or source.stat().st_size > 4096:
        return False
    header = bytes.fromhex(
        "1a45dfa39f4286810142f7810142f2810442f381084282847765626d4287810442858102"
    )
    with source.open("rb") as audio:
        data = audio.read(4097)
    return len(data) <= 4096 and data.startswith(header) and not any(data[len(header):])


@lru_cache(maxsize=1)
def get_model():
    from faster_whisper import WhisperModel

    model_path = Path(settings.WHISPER_MODEL)
    if not model_path.exists():
        raise RuntimeError(
            f"Offline Whisper model not found at {model_path}. Run scripts/download_models.py during setup."
        )
    return WhisperModel(
        str(model_path),
        device=settings.WHISPER_DEVICE,
        compute_type=settings.WHISPER_COMPUTE_TYPE,
    )


def detect_language(path: str) -> tuple[str, float]:
    """Score only Portuguese and English for a short local audio sample."""
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions

    audio = decode_audio(path, sampling_rate=16000)
    _language, _probability, probabilities = get_model().detect_language(
        audio=audio,
        vad_filter=True,
        vad_parameters=VadOptions(min_silence_duration_ms=500),
        language_detection_segments=3,
    )
    scores = {code.strip("<|>"): probability for code, probability in probabilities}
    selected = max(("pt", "en"), key=lambda code: scores.get(code, 0.0))
    return selected, float(scores.get(selected, 0.0))


def transcribe(
    path: str,
    language: str,
    *,
    initial_prompt: str = "",
    hotwords: str = "",
) -> tuple[list[dict], str]:
    """Transcribe an independent audio chunk without inheriting prior hallucinations."""
    segments, info = get_model().transcribe(
        path,
        language=language,
        beam_size=8,
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=initial_prompt or None,
        hotwords=hotwords or None,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    output = []
    for segment in segments:
        text = segment.text.strip()
        confidence = min(1.0, max(0.0, math.exp(segment.avg_logprob)))
        if not text or _should_reject_segment(segment, text, confidence, hotwords):
            continue
        output.append({
            "start_ms": max(0, round(segment.start * 1000)),
            "end_ms": max(0, round(segment.end * 1000)),
            "text": text,
            "confidence": confidence,
        })
    return output, info.language


def _should_reject_segment(segment, text: str, confidence: float, glossary: str) -> bool:
    """Reject likely silence hallucinations while retaining credible technical speech."""
    words = _text_words(text)
    duration_seconds = max(0.25, float(segment.end) - float(segment.start))
    word_density = len(words) / duration_seconds
    no_speech_probability = float(getattr(segment, "no_speech_prob", 0.0))
    probable_silence = (
        (no_speech_probability >= 0.80 and confidence < 0.75 and word_density < 1.50)
        or (no_speech_probability >= 0.80 and confidence < 0.55 and word_density > 3.00)
        or (no_speech_probability >= 0.60 and confidence < 0.55 and word_density < 1.00)
        or (no_speech_probability >= 0.45 and confidence < 0.35 and word_density < 0.50)
    )
    return (
        probable_silence
        or _is_repetitive(text)
        or _is_unlikely_acronym_list(text, confidence, glossary)
    )


def _text_words(text: str) -> list[str]:
    return re.findall(r"[\wÀ-ÿ]+", text, flags=re.UNICODE)


def _glossary_words(glossary: str) -> set[str]:
    """Return normalized glossary words so domain acronyms are never treated as noise."""
    return {
        word.casefold()
        for entry in re.split(r"[,;\n]+", glossary or "")
        for word in _text_words(entry)
    }


def _is_unlikely_acronym_list(text: str, confidence: float, glossary: str) -> bool:
    """Detect low-confidence acronym dumps without penalizing configured terminology."""
    if confidence >= 0.70:
        return False
    words = _text_words(text)
    if len(words) < 4:
        return False
    protected = _glossary_words(glossary)
    candidates = [word for word in words if word.casefold() not in protected]
    if len(candidates) < 4:
        return False
    frequencies = Counter(word.casefold() for word in candidates)
    suspicious = sum(
        1
        for word in candidates
        if (
            1 <= len(word) <= 10
            and any(character.isalpha() for character in word)
            and word.isupper()
        )
        or (len(word) <= 5 and frequencies[word.casefold()] >= 3)
    )
    suspicious_ratio = suspicious / len(candidates)
    looks_like_list = text.count(",") >= 3 or suspicious_ratio >= 0.65
    return suspicious >= 4 and suspicious_ratio >= 0.50 and looks_like_list


def _is_repetitive(text: str) -> bool:
    """Reject long Whisper loops such as one short phrase repeated for a whole chunk."""
    words = _text_words(text.casefold())
    if len(words) < 24:
        return False
    return len(set(words)) / len(words) < 0.3
