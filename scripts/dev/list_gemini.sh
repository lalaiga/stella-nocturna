#!/usr/bin/env bash
# List Gemini models available to the key in .env
. "$HOME/venvs/a3tn/bin/activate"
cd "$(dirname "$0")/.."
python - <<'PY'
import os
from dotenv import load_dotenv
from google import genai
load_dotenv(".env")
c = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
for m in c.models.list():
    n = m.name.split("/")[-1]
    if "flash" in n or "gemma" in n:
        print(n)
PY
