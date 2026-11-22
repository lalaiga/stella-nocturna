#!/usr/bin/env bash
set -euo pipefail
. "$HOME/venvs/a3tn/bin/activate"
cd "$(dirname "$0")/.."
mkdir -p ai/smoke_gnn/models
python ai/smoke_gnn/train_gnn.py 2>&1 | tee ai/smoke_gnn/models/gnn_train.log
