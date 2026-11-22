#!/usr/bin/env bash
# Pre-download the Whisper model used for speech-to-text (cached in ~/a3tn-data/models).
. "$HOME/venvs/a3tn/bin/activate"
export HF_HUB_DISABLE_XET=1
python - <<'PY'
import pathlib
from huggingface_hub import hf_hub_download
cache = str(pathlib.Path.home() / "a3tn-data/models")
for f in ["en/en_US/ryan/medium/en_US-ryan-medium.onnx.json", "en/en_US/ryan/medium/en_US-ryan-medium.onnx"]:
    hf_hub_download("rhasspy/piper-voices", f, cache_dir=cache)
print("piper voice cached", flush=True)
from faster_whisper import WhisperModel
WhisperModel("base.en", device="cpu", compute_type="int8", download_root=cache)
print("whisper base.en cached")
PY
