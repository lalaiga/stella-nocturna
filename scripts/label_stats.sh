#!/usr/bin/env bash
. "$HOME/venvs/a3tn/bin/activate"
python - <<'PY'
import pyarrow.parquet as pq, pathlib, collections
src = pathlib.Path.home() / "a3tn-data/dfire/parquet"
tot = collections.Counter()
for f in sorted(src.glob("*.parquet")):
    t = pq.read_table(f, columns=["label", "filename"]).to_pylist()
    c = collections.Counter()
    for r in t:
        lab = (r["label"] or "").strip()
        c[("lab" if lab else "empty") + ":" + r["filename"][:2]] += 1
    tot.update({f.name.split('-')[0] + ":" + k: v for k, v in c.items()})
    print(f.name, dict(c))
print(dict(tot))
PY
