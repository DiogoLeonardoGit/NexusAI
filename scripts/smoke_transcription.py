"""Transcribe a supplied local audio file and print the detected result."""

import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django


django.setup()

from notetaker.services.transcription import transcribe


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: smoke_transcription.py <audio-file>")
    segments, language = transcribe(sys.argv[1])
    print(json.dumps({"language": language, "segments": segments}, ensure_ascii=False))
