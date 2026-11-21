#!/usr/bin/env bash
. "$HOME/venvs/a3tn/bin/activate"
python - <<'PY'
import torch, ultralytics, cv2, faster_whisper, piper, fastapi, google.genai, pyarrow
print("torch", torch.__version__, "cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0))
print("ultralytics", ultralytics.__version__, "cv2", cv2.__version__, "faster_whisper", faster_whisper.__version__)
PY
