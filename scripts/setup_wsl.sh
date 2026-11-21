#!/usr/bin/env bash
# One-time setup of the A3TN Python environment inside WSL (Ubuntu 24.04, NVIDIA GPU).
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
VENV="$HOME/venvs/a3tn"
[ -d "$VENV" ] || uv venv -p 3.12 "$VENV" --seed
# shellcheck disable=SC1091
. "$VENV/bin/activate"
# RTX 50-series (Blackwell) needs CUDA 12.8+ wheels
uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install ultralytics onnx onnxruntime pyarrow pandas \
  fastapi "uvicorn[standard]" python-multipart python-dotenv google-genai \
  faster-whisper piper-tts huggingface_hub
# cuBLAS / cuDNN for faster-whisper already come with the CUDA PyTorch wheels (site-packages/nvidia)
python - <<'PY'
import torch
print("torch", torch.__version__, "cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
PY
