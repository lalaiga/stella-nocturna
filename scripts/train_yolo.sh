#!/usr/bin/env bash
# Prepare D-Fire and fine-tune YOLO11n (run inside WSL). Usage: bash scripts/train_yolo.sh [epochs]
set -euo pipefail
. "$HOME/venvs/a3tn/bin/activate"
cd "$(dirname "$0")/.."
mkdir -p ai/detection/models
[ -f "$HOME/a3tn-data/dfire/yolo/dfire.yaml" ] || python -u ai/detection/prep_dfire.py
python -u ai/detection/train_yolo.py "${1:-40}" 2>&1 | tee ai/detection/models/yolo_train.log
