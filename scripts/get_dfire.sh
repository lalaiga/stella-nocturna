#!/usr/bin/env bash
# Download the D-Fire dataset (de Venâncio et al., 2022) parquet mirror from Hugging Face.
# Order: a usable subset first (4 train shards + 1 val shard), then the rest. Resumable.
set -euo pipefail
DST="$HOME/a3tn-data/dfire/parquet"
mkdir -p "$DST"
BASE="https://huggingface.co/datasets/badsaarow/d-fire/resolve/main/data"
files=(train-00000-of-00009 train-00001-of-00009 train-00002-of-00009 train-00003-of-00009 test-00000-of-00003
       train-00004-of-00009 train-00005-of-00009 train-00006-of-00009 train-00007-of-00009 train-00008-of-00009
       test-00001-of-00003 test-00002-of-00003)
for f in "${files[@]}"; do
  [ -s "$DST/$f.parquet" ] && continue
  curl -sSL --retry 5 -C - -o "$DST/$f.parquet.part" "$BASE/$f.parquet" && mv "$DST/$f.parquet.part" "$DST/$f.parquet"
  echo "got $f"
done
du -sh "$DST"
