"""Local retrieval shared by textual search and grounded AI answers."""
import heapq
import logging
import re
import unicodedata
from datetime import datetime, time, timedelta

from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date

from notetaker.models import CaptureSession, Note, Summary, Task, TranscriptSegment
from .ollama import OllamaError, SEARCH_EXPANSION_PROMPT, SEARCH_RANKING_PROMPT, generate_json

logger = logging.getLogger(__name__)
CHAT_STOP_WORDS = set("a ao aos as com da das de do dos e em esta este falamos foi na nas no nos o onde os para por que sobre uma quando what when the with about meeting reuniao reunião sessao sessão".split())


def normalize(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(c))


def search_filters(values):
    """Validate filters before using them in either retrieval endpoint."""
    result = {}
    for field in ("project", "tag", "participant"):
        value = values.get(field)
        if value not in (None, ""):
            try:
                result[field] = int(value)
                if result[field] < 1:
                    raise ValueError()
            except (ValueError, TypeError):
                raise ValueError(f"Filtro inválido: {field}")
    for field in ("date_from", "date_to"):
        value = values.get(field)
        if value:
            try:
                parsed = parse_date(str(value))
            except ValueError:
                parsed = None
            if parsed is None:
                raise ValueError(f"Data inválida: {field}")
            result[field] = parsed
    if result.get("date_from") and result.get("date_to") and result["date_from"] > result["date_to"]:
        raise ValueError("O início do intervalo deve anteceder o fim.")
    return result


def _filtered(queryset, kind, filters):
    """Scope records by their own organization or their parent meeting."""
    meeting = "" if kind == "session" else "session__"
    own = "" if kind in ("session", "note", "task") else "session__"
    for field, lookup in (("project", "project_id"), ("tag", "tags__id")):
        if field in filters:
            condition = Q(**{own + lookup: filters[field]})
            if kind in ("note", "task"):
                condition |= Q(**{meeting + lookup: filters[field]}) if field == "tag" else Q(project__isnull=True, **{meeting + lookup: filters[field]})
            queryset = queryset.filter(condition)
    if "participant" in filters:
        lookup = "speaker_id" if kind == "segment" else meeting + "speakers__id"
        queryset = queryset.filter(**{lookup: filters["participant"]})
    date_field = "started_at" if kind == "session" else "session__started_at"
    for field in ("date_from", "date_to"):
        if field not in filters:
            continue
        date = filters[field] + (timedelta(days=1) if field == "date_to" else timedelta())
        bound = timezone.make_aware(datetime.combine(date, time.min))
        lookup = "lt" if field == "date_to" else "gte"
        condition = Q(**{date_field + "__" + lookup: bound})
        if kind in ("note", "task"):
            condition |= Q(session__isnull=True, **{"created_at__" + lookup: bound})
        queryset = queryset.filter(condition)
    return queryset.distinct()


def retrieve(question, filters=None, *, expand=False):
    """Rank the complete filtered corpus before limiting returned evidence.

    Local model expansion supplies alternate vocabulary, never source facts.
    No cloud requests, embeddings model or external index is needed.
    """
    filters = filters or {}
    original = [term for term in re.findall(r"\w+", normalize(question)) if len(term) > 2 and term not in CHAT_STOP_WORDS][:24]
    terms = list(original)
    warning = ""
    if expand and question.strip():
        try:
            alternatives = generate_json(
                "Generate up to 12 useful search synonyms or alternate phrases in Portuguese and English. "
                "Preserve the meaning; do not answer or invent facts. Query: " + question[:1500],
                {"type": "object", "properties": {"terms": {"type": "array", "items": {"type": "string"}}}, "required": ["terms"]},
                system_prompt=SEARCH_EXPANSION_PROMPT,
                max_output_tokens=256, request_timeout=45,
            )
            for term in alternatives.get("terms", [])[:12]:
                normalized = normalize(term.strip())[:100]
                if normalized and normalized not in terms:
                    terms.append(normalized)
        except OllamaError as exc:
            logger.warning("Local search expansion unavailable: %s", exc)
            warning = "A expansão por IA não está disponível; foi usada pesquisa textual."
    specifications = [
        ("segment", TranscriptSegment.objects.select_related("speaker", "session", "chunk", "session__project").prefetch_related("session__tags")),
        ("summary", Summary.objects.select_related("session", "session__project").prefetch_related("session__tags")),
        ("note", Note.objects.select_related("session", "project", "session__project").prefetch_related("tags", "session__tags")),
        ("task", Task.objects.select_related("session", "project", "session__project").prefetch_related("tags", "session__tags")),
        ("session", CaptureSession.objects.select_related("project").prefetch_related("tags")),
    ]
    records = []
    for kind, queryset in specifications:
        def candidates():
            for item in _filtered(queryset, kind, filters).iterator(chunk_size=200):
                session = item if kind == "session" else item.session
                title = getattr(item, "title", "") or (session.title if session else "")
                text = getattr(item, "text", getattr(item, "content", getattr(item, "body", getattr(item, "description", ""))))
                if kind == "summary":
                    text += "\n" + "\n".join([*item.decisions, *item.open_questions])
                project = getattr(item, "project", None) or (session.project if session else None)
                labels = list(item.tags.all()) if kind in ("session", "note", "task") else []
                if session and kind != "session":
                    labels.extend(session.tags.all())
                metadata = f"{project.name if project else ''} {' '.join(tag.name for tag in labels)}"
                if kind == "task":
                    status_words = {"todo": "pending pendente a fazer", "pending_confirmation": "pending pendente confirmar", "done": "completed concluida concluido", "cancelled": "cancelled cancelada cancelado"}
                    metadata += f" {status_words.get(item.status, item.status)} {item.owner_name} {item.evidence}"
                searchable = normalize(f"{title} {text} {metadata} {session.title if session else ''}")
                score = sum((10 if term in original else 3) for term in terms if term in searchable)
                if project and re.search(r"(?<!\w)" + re.escape(normalize(project.name)) + r"(?!\w)", normalize(question)):
                    score += 30
                if question.strip() and not score:
                    continue
                if question.strip() and normalize(question.strip()) in searchable:
                    score += 30
                record = {"kind": kind, "item": item, "title": title, "text": text, "score": score}
                yield score, item.pk, record
        records.extend(row[2] for row in heapq.nlargest(30, candidates(), key=lambda row: row[:2]))
    records.sort(key=lambda row: (row["score"], row["item"].pk), reverse=True)
    # Ask the same local model to assess meaning within the retrieved candidates.
    if expand and records and not warning:
        try:
            result = generate_json(
                "Select up to 24 relevant source identifiers for this question. Rank by semantic relevance. "
                "Return only identifiers from the supplied list; do not answer.\nQuestion: " + question[:1500] + "\n" +
                "\n".join(f"{r['kind']}:{r['item'].pk} {r['title']} {r['text'][:450]}" for r in records[:50]),
                {"type": "object", "properties": {"ids": {"type": "array", "items": {"type": "string"}}}, "required": ["ids"]},
                system_prompt=SEARCH_RANKING_PROMPT,
                max_output_tokens=512, request_timeout=45,
            )
            order = list(dict.fromkeys(result.get("ids", [])))[:24]
            ranked = {f"{r['kind']}:{r['item'].pk}": r for r in records[:50]}
            selected = [ranked[key] for key in order if key in ranked]
            if selected:
                records = selected
        except OllamaError as exc:
            logger.warning("Local relevance ranking unavailable: %s", exc)
            warning = "A avaliação por IA não está disponível; foi usada relevância textual."
    return records[:50], warning


def search_chat_context(question):
    """Compatibility wrapper for callers requesting only transcript/summary evidence."""
    records, _ = retrieve(question)
    return ([r["item"] for r in records if r["kind"] == "segment"], [r["item"] for r in records if r["kind"] == "summary"])


def search_local(query):
    records, _ = retrieve(query)
    return tuple([r["item"] for r in records if r["kind"] == kind] for kind in ("segment", "note", "task"))
