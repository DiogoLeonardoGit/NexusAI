from django.db.models import Q

import re

from notetaker.models import Note, Summary, Task, TranscriptSegment


CHAT_STOP_WORDS = {
    "a", "ao", "aos", "as", "com", "da", "das", "de", "do", "dos", "e",
    "em", "esta", "este", "falamos", "foi", "na", "nas", "no", "nos", "o",
    "onde", "os", "para", "por", "que", "reuniao", "reunião", "sessao", "sessão",
    "sobre", "uma",
}


def _evidence_score(text: str, terms: list[str]):
    normalized = text.lower()
    matched = sum(term in normalized for term in terms)
    occurrences = sum(min(normalized.count(term), 3) for term in terms)
    return matched * 10 + occurrences


def search_chat_context(question: str):
    """Return transcript and meeting-summary evidence for an AI question."""
    terms = [
        term for term in re.findall(r"[\wÀ-ÿ]+", question.lower())
        if len(term) > 2 and term not in CHAT_STOP_WORDS
    ][:8]
    query = Q()
    for term in terms:
        query |= Q(text__icontains=term)
    segments = list(
        TranscriptSegment.objects.filter(query).select_related("speaker", "session")[:200]
    ) if terms else []
    segments.sort(
        key=lambda item: (
            _evidence_score(f"{item.session.title} {item.text}", terms),
            item.session.started_at,
            item.id,
        ),
        reverse=True,
    )
    segments = segments[:30]

    summary_query = Q()
    for term in terms:
        summary_query |= Q(content__icontains=term)
    summaries = list(
        Summary.objects.filter(kind=Summary.Kind.MEETING)
        .filter(summary_query)
        .select_related("session")[:100]
    ) if terms else []
    summaries.sort(
        key=lambda item: (
            _evidence_score(f"{item.session.title} {item.content}", terms),
            item.session.started_at,
            item.id,
        ),
        reverse=True,
    )
    summaries = summaries[:10]
    return segments, summaries


def search_local(query: str):
    """Search all local user content without requiring an external index."""
    segments = TranscriptSegment.objects.filter(text__icontains=query).select_related("speaker")[:50]
    notes = Note.objects.filter(Q(title__icontains=query) | Q(body__icontains=query))[:50]
    tasks = Task.objects.filter(Q(title__icontains=query) | Q(description__icontains=query))[:50]
    return segments, notes, tasks
