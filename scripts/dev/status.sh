#!/usr/bin/env bash
# Quick progress check for the WSL environment and dataset.
ls ~/a3tn-data/dfire/parquet 2>/dev/null
du -sh ~/venvs/a3tn ~/.cache/uv 2>/dev/null
ls ~/venvs/a3tn/lib/python3.12/site-packages 2>/dev/null | grep -iE '^(torch|ultralytics|faster_whisper|piper|google)' | head
pgrep -fa 'uv pip|curl' | head -5
