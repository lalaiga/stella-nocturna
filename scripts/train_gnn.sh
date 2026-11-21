#!/usr/bin/env bash
set -euo pipefail
. "$HOME/venvs/a3tn/bin/activate"
cd "$(dirname "$0")/.."
python ml/train_gnn.py 2>&1 | tee ml/models/gnn_train.log
