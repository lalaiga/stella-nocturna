"""Fine-tune YOLO11n on D-Fire for fire + smoke detection and export to ONNX.

Why YOLO11n: ~2.6 M parameters, runs in real time on drone-class edge GPUs (Jetson Orin Nano),
so detection can happen on board instead of streaming video over a weak link.
"""
from __future__ import annotations
import pathlib, shutil, sys
from ultralytics import YOLO

DATA = pathlib.Path.home() / "a3tn-data/dfire/yolo/dfire.yaml"
OUT = pathlib.Path(__file__).parent / "models"
epochs = int(sys.argv[1]) if len(sys.argv) > 1 else 40

model = YOLO("yolo11n.pt")
model.train(data=str(DATA), epochs=epochs, imgsz=640, batch=16, workers=2, cos_lr=True,
            project=str(pathlib.Path.home() / "a3tn-data/runs"), name="dfire_y11n", exist_ok=True,
            patience=15, plots=True)
best = pathlib.Path.home() / "a3tn-data/runs/dfire_y11n/weights/best.pt"
OUT.mkdir(exist_ok=True)
shutil.copy(best, OUT / "fire_yolo11n.pt")
m = YOLO(str(best))
metrics = m.val(data=str(DATA), imgsz=640, batch=16, split="val")
onnx = m.export(format="onnx", imgsz=640, opset=17, simplify=True)
shutil.copy(onnx, OUT / "fire_yolo11n.onnx")
for f in ["results.png", "confusion_matrix_normalized.png", "PR_curve.png", "val_batch0_pred.jpg"]:
    p = best.parent.parent / f
    if p.exists(): shutil.copy(p, OUT / f"yolo_{f}")
(OUT / "yolo_metrics.txt").write_text(
    f"mAP50={metrics.box.map50:.4f}\nmAP50-95={metrics.box.map:.4f}\n"
    f"per_class_mAP50={dict(zip(['smoke', 'fire'], [round(float(x), 4) for x in metrics.box.ap50]))}\n")
print(open(OUT / "yolo_metrics.txt").read())
