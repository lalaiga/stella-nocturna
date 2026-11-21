#!/usr/bin/env bash
# Start the A3TN backend (web app + AI services) inside WSL. Open http://localhost:8765
set -euo pipefail
. "$HOME/venvs/a3tn/bin/activate"
cd "$(dirname "$0")/.."
# cuBLAS / cuDNN from pip wheels for faster-whisper (CTranslate2)
SP=$(python -c 'import site; print(site.getsitepackages()[0])')
export LD_LIBRARY_PATH="$SP/nvidia/cublas/lib:$SP/nvidia/cudnn/lib:${LD_LIBRARY_PATH:-}"
export HF_HUB_DISABLE_XET=1
exec python -m uvicorn server.app:app --host 0.0.0.0 --port 8765
