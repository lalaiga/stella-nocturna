# A3TN Command: AI components

Everything AI in the project, in one place. For the full write-up (architecture, why each model, datasets, metrics) see [MODEL_REPORT.md](MODEL_REPORT.md).

```
ai/
├── detection/            YOLO11n fire + smoke detector (trained by us)
│   ├── prep_dfire.py       D-Fire parquet → YOLO dataset; also exports held-out images for the demo drone feed
│   ├── train_yolo.py       fine-tune YOLO11n, validate, export ONNX
│   └── models/             fire_yolo11n.pt / .onnx, metrics, curves, confusion matrix, per-epoch results
├── smoke_gnn/            graph neural network for smoke and heat spread inside buildings (trained by us)
│   ├── zone_model.py       multi-room zone fire model: generates the training trajectories (and mirrors web/js/interior.js)
│   ├── gnn.py              message-passing network + rollout
│   ├── train_gnn.py        generate data, train, evaluate on unseen floor plans
│   └── models/             gnn_smoke.pt, metrics, training log
└── MODEL_REPORT.md       the model report (architecture, datasets, metrics, limits)
```

Not in this folder, but part of the AI:

| Component | Where | Kind |
|---|---|---|
| Sensor fusion (Bayesian, inverse-variance) | `web/js/fusion.js` | probabilistic layer, not a trained model |
| Voice: Whisper (STT), Piper (TTS) | `server/app.py` (`/api/stt`, `/api/tts`) | pretrained, run locally |
| Assistant: Gemini, structured actions | `server/app.py` (`/api/assist`) | hosted API, key in `.env` |
| Detection / forecast endpoints | `server/app.py` (`/api/detect`, `/api/spread`) | serve the two trained models above |

## Results

| Model | Metric | Value |
|---|---|---|
| YOLO11n (D-Fire, 4,306 held-out images) | mAP@0.5 | **0.745** (smoke 0.801, fire 0.688) |
| | mAP@0.5:0.95 | 0.424 |
| Smoke GNN (200 unseen floor plans, 6 min rollout) | smoke-index MAE | 0.007 |
| | temperature MAE | 1.9 °C (3.2 °C in rooms above 60 °C) |

## Reproduce

Requires WSL2 Ubuntu with an NVIDIA GPU (CUDA 12.8+), or any Linux box. From the repo root:

```bash
bash scripts/setup_wsl.sh        # Python env with CUDA PyTorch, Ultralytics, faster-whisper, Piper
bash scripts/get_dfire.sh        # D-Fire dataset (~3 GB) → ~/a3tn-data/dfire
bash scripts/train_yolo.sh 30    # prepare + train YOLO11n (~9 min per epoch on an RTX 5050 laptop GPU)
bash scripts/train_gnn.sh        # generate 3,000 floor-plan trajectories and train the GNN (~5 min)
```

Trained weights are committed, so the app runs without retraining: `bash scripts/serve.sh`, then open http://localhost:8765.

## Data

- **D-Fire** (de Venâncio et al., *Neural Computing and Applications*, 2022): 21,527 images, classes smoke and fire. Downloaded by `scripts/get_dfire.sh`, not stored in the repo.
- **Synthetic floor plans** for the GNN are generated on the fly by `smoke_gnn/zone_model.py`; nothing to download.
