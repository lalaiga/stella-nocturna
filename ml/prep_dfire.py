"""Convert the D-Fire parquet mirror into an Ultralytics YOLO dataset folder.

D-Fire (de Venâncio et al., Neural Computing and Applications, 2022): 21,527 images labelled
in YOLO format with two classes, 0 = smoke, 1 = fire.
"""
from __future__ import annotations
import pathlib, sys
import pyarrow.parquet as pq

SRC = pathlib.Path.home() / "a3tn-data/dfire/parquet"
DST = pathlib.Path.home() / "a3tn-data/dfire/yolo"
inspect = "--inspect" in sys.argv

counts = {}
for pf in sorted(SRC.glob("*.parquet")):
    split = "train" if pf.name.startswith("train") else "val"
    (DST / "images" / split).mkdir(parents=True, exist_ok=True)
    (DST / "labels" / split).mkdir(parents=True, exist_ok=True)
    tbl = pq.read_table(pf)
    for row in tbl.to_pylist():
        if inspect:
            print(repr(row["label"])[:300], row["filename"], type(row["image"]))
            if counts.setdefault("shown", 0) >= 4: sys.exit(0)
            counts["shown"] += 1
            continue
        stem = pathlib.Path(row["filename"]).stem
        img = row["image"]
        data = img["bytes"] if isinstance(img, dict) else img
        (DST / "images" / split / f"{stem}.jpg").write_bytes(data)
        lines = [l for l in (row["label"] or "").strip().splitlines() if len(l.split()) == 5]
        (DST / "labels" / split / f"{stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
        counts[split] = counts.get(split, 0) + 1
    print(pf.name, counts)

(DST / "dfire.yaml").write_text(f"path: {DST}\ntrain: images/train\nval: images/val\nnames:\n  0: smoke\n  1: fire\n")
print("done", counts)

# Drone camera replay for the web app: held-out validation images containing fire (never seen in training)
import json, random, shutil
feed = pathlib.Path(__file__).resolve().parent.parent / "web" / "assets" / "feed"
feed.mkdir(parents=True, exist_ok=True)
cands = [p for p in (DST / "labels" / "val").glob("*.txt") if any(l.startswith("1 ") for l in p.read_text().splitlines())]
random.Random(3).shuffle(cands)
names = []
for lab in cands[:36]:
    img = DST / "images" / "val" / f"{lab.stem}.jpg"
    if img.exists() and img.stat().st_size < 400_000:
        shutil.copy(img, feed / img.name); names.append(img.name)
(feed / "index.json").write_text(json.dumps(names))
print("feed images:", len(names))
