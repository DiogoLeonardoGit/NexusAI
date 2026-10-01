import json
from urllib.error import URLError
from urllib.request import Request, urlopen

from django.conf import settings


class OllamaError(RuntimeError):
    pass


EXTRACTION_SYSTEM_PROMPT = """You are a private offline meeting assistant. Return only JSON.
Extract tasks, decisions and open questions from the transcript. Never invent facts.
For each task include title, owner (self, other, unknown), owner_name, date_phrase,
confidence from 0 to 1, evidence copied from the supplied transcript, and
due_is_ambiguous. Use the language of the transcript.
"""

ACTIVE_LISTENING_SYSTEM_PROMPT = """You are a private offline personal assistant. Return only JSON.
The transcript contains only the user's microphone. Extract a task only when the user explicitly
states a personal commitment, action to perform, or reminder request. Ignore conversation,
dictation, ideas, questions, and mentions of other people's work. Never invent facts. For each
task include a concise title, an optional useful description, owner=self, an empty owner_name,
date_phrase, confidence from 0 to 1, evidence copied from the transcript, and due_is_ambiguous.
Use the language of the transcript.
"""

SUMMARY_SYSTEM_PROMPT = """You are a private offline meeting assistant. Return only JSON.
Create a useful factual summary from the supplied material. Never invent facts. Write in
the requested language. The summary must contain substantive information, not a title or
date label. Decisions and open questions must be concise and empty entries are forbidden.
"""

CHAT_SYSTEM_PROMPT = """You are a private offline meeting assistant. Return only JSON.
Answer exclusively from the supplied context. If evidence is insufficient, say so clearly.
Keep citation segment identifiers exact and write in the language of the question.
"""


def _request(path: str, payload: dict, timeout: int = 300) -> dict:
    request = Request(
        f"{settings.OLLAMA_URL.rstrip('/')}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, json.JSONDecodeError) as exc:
        raise OllamaError(f"Local Ollama request failed: {exc}") from exc


def _matches_schema(value, schema: dict | None) -> bool:
    """Validate the small JSON-schema subset used by the local Ollama calls."""
    if not schema:
        return isinstance(value, dict)
    if "enum" in schema and value not in schema["enum"]:
        return False
    expected_type = schema.get("type")
    if expected_type == "object":
        if not isinstance(value, dict):
            return False
        if any(name not in value for name in schema.get("required", [])):
            return False
        return all(
            name not in value or _matches_schema(value[name], child_schema)
            for name, child_schema in schema.get("properties", {}).items()
        )
    if expected_type == "array":
        return isinstance(value, list) and all(
            _matches_schema(item, schema.get("items")) for item in value
        )
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "boolean":
        return isinstance(value, bool)
    return True


def _decode_json_object(content: str, schema: dict | None) -> dict | None:
    """Accept a JSON object, including one preceded by a model preamble."""
    decoder = json.JSONDecoder()
    for marker in ("{",):
        start = content.find(marker)
        if start < 0:
            continue
        try:
            value, _ = decoder.raw_decode(content[start:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and _matches_schema(value, schema):
            return value
    return None


def generate_json(
    prompt: str,
    schema: dict | None = None,
    *,
    system_prompt: str = EXTRACTION_SYSTEM_PROMPT,
    max_output_tokens: int | None = None,
) -> dict:
    options = {"temperature": 0.1, "num_predict": max_output_tokens or 768}
    payload = {
        "model": settings.OLLAMA_MODEL,
        "keep_alive": "30m",
        "stream": False,
        "format": schema or "json",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "options": options,
    }
    result = _request("/api/chat", payload)
    content = str(result.get("message", {}).get("content", "")).strip()
    decoded = _decode_json_object(content, schema)
    if decoded is not None:
        return decoded
    raise OllamaError("Ollama returned invalid structured output.")


def health() -> bool:
    try:
        result = _request("/api/show", {"model": settings.OLLAMA_MODEL}, timeout=10)
    except OllamaError:
        return False
    return bool(result.get("details") or result.get("modelfile"))
