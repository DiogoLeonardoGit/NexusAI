import os
from pathlib import Path

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BASE_DIR.parent
load_dotenv(PROJECT_DIR / ".env")

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "local-development-only")
DEBUG = os.getenv("DJANGO_DEBUG", "false").lower() == "true"
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "notetaker",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "notetaker.middleware.LocalOnlyMiddleware",
]

ROOT_URLCONF = "config.urls"
TEMPLATES = []
WSGI_APPLICATION = "config.wsgi.application"

DATA_DIR = Path(os.getenv("NOTETAKER_DATA_DIR", PROJECT_DIR / "data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR = DATA_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": DATA_DIR / "notetaker.sqlite3",
        "OPTIONS": {"timeout": 20},
    }
}

LANGUAGE_CODE = "pt-pt"
TIME_ZONE = "Europe/Lisbon"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

CORS_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "null", "file://"]
CORS_ALLOW_HEADERS = ["accept", "content-type", "x-local-token"]
REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": [
        "rest_framework.parsers.JSONParser",
        "rest_framework.parsers.MultiPartParser",
    ],
    "UNAUTHENTICATED_USER": None,
}

LOCAL_API_TOKEN = os.getenv("NOTETAKER_API_TOKEN", "development-token")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:12b")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", str(PROJECT_DIR / "models" / "faster-whisper-medium"))
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
DIARIZATION_SEGMENTATION_MODEL = os.getenv(
    "DIARIZATION_SEGMENTATION_MODEL",
    str(PROJECT_DIR / "models" / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"),
)
DIARIZATION_EMBEDDING_MODEL = os.getenv(
    "DIARIZATION_EMBEDDING_MODEL",
    str(PROJECT_DIR / "models" / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"),
)
AUDIO_RETENTION_DAYS = int(os.getenv("AUDIO_RETENTION_DAYS", "7"))
AUDIO_MAX_BYTES = int(os.getenv("AUDIO_MAX_BYTES", str(5 * 1024**3)))
