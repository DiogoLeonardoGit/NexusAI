"""Download inference assets during setup so runtime can remain fully offline."""

from pathlib import Path
import tarfile
import tempfile
from urllib.request import urlretrieve

from huggingface_hub import snapshot_download


ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"
WHISPER_TARGET = MODELS / "faster-whisper-medium"
SEGMENTATION_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
EMBEDDING_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
)


if __name__ == "__main__":
    WHISPER_TARGET.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id="Systran/faster-whisper-medium",
        local_dir=WHISPER_TARGET,
        allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.*"],
    )
    print(f"Whisper model ready at {WHISPER_TARGET}")

    segmentation_target = MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
    if not segmentation_target.exists():
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "segmentation.tar.bz2"
            urlretrieve(SEGMENTATION_URL, archive)
            with tarfile.open(archive, "r:bz2") as package:
                package.extractall(MODELS, filter="data")
    print(f"Segmentation model ready at {segmentation_target}")

    embedding_target = MODELS / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
    if not embedding_target.exists():
        urlretrieve(EMBEDDING_URL, embedding_target)
    print(f"Speaker embedding model ready at {embedding_target}")
