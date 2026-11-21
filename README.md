# A3TN Command

Decision support for Protection Civile commanders at industrial fires. A 3D digital twin of a chemical site fuses drone, crew and fixed-sensor data, forecasts how fire and smoke will spread, plans safe building entries, and lets gloved firefighters run it all by voice.

Built for the Tunisian Aeroday aero-entrepreneur challenge (in partnership with the Protection Civile). Prototype: the site and sensor data are simulated.

## What it does

| | |
|---|---|
| **3D site twin** | Chemical plant at night, 10×10 risk grid, live fire with flames, smoke, embers and flickering light. |
| **Fire physics** | t² / logistic growth, Heskestad flame height, radiant heat flux, McCaffrey plume, Gaussian smoke plume, radiant ignition of neighbouring buildings. |
| **Crew safety** | Every unit carries sensors (air temp, heat flux, CO, CO₂, visibility) checked against firefighter exposure limits. The Visor escalates from quiet to hazard and auto-withdraws crews at critical. |
| **Hazard-aware routing** | A* over a 4 m grid that avoids red cells and re-plans as the fire moves. |
| **Building interiors** | Zoom inside W-1 and the admin block. A caged indoor drone (D3) scans room by room; casualties appear only once its thermal camera finds them. |
| **Entry planner** | For each door: route to casualties, smoke/heat forecast, two-firefighter walk-through (smoke slows them, carrying slows them, air consumption, door forcing). GO / CAUTION / NO-GO. Scrub the timeline back and forth to watch the crew move through the forecast. |
| **Voice (hands-free)** | Hold the mic (or **V**), speak an order. Local Whisper → Gemini → actions → local Piper voice reply. Visor also speaks critical alerts. |

## AI components

| Model | Role | Runs |
|---|---|---|
| **YOLO11n fine-tuned on D-Fire** | Fire and smoke detection on the drone camera feed | Local GPU (`/api/detect`) |
| **Smoke-spread GNN** | Predicts smoke and temperature room-to-room over any floor plan; feeds the entry planner | Local (`/api/spread`) |
| **Sensor fusion** | Inverse-variance temperature fusion and Bayesian fire / person probabilities from crews, drones, heat detectors and YOLO | Browser |
| **Whisper base.en** | Speech to text | Local GPU (`/api/stt`) |
| **Gemini (Google AI Studio)** | Understands orders, answers questions, returns structured actions | API (`/api/assist`) |
| **Piper** | Text to speech | Local CPU (`/api/tts`) |

Training code is in `ml/`; trained weights and metrics land in `ml/models/`.

## Run it

Requirements: WSL2 Ubuntu with an NVIDIA GPU (CUDA 12.8+), or any Linux box with Python 3.12.

```bash
bash scripts/setup_wsl.sh          # once: Python env with CUDA PyTorch, Ultralytics, faster-whisper, Piper
cp .env.example .env               # add GEMINI_API_KEY
bash scripts/serve.sh              # http://localhost:8765
```

Without the backend, `web/` still runs as a static site (`python -m http.server --directory web`): the planner falls back to the zone model and voice falls back to a rule-based parser.

Train the models:

```bash
bash scripts/get_dfire.sh && python ml/prep_dfire.py && python ml/train_yolo.py
python ml/train_gnn.py
```

## Controls

Drag to orbit, scroll to zoom. Click a unit, cell, building or room for details. **V** push-to-talk, **Space** pause, **1/2/3** speed, **←/→** scrub a plan, **Esc** back.

Try saying: *"Scout, scan the warehouse"*, *"Plan a rescue for W-1"*, *"Commit plan A"*, *"Engine 2, foam attack"*, *"Pull back everyone in red"*, *"What's the status of Engine 2?"*

## Data and references

- D-Fire dataset: de Venâncio et al., *An automatic fire detection system based on deep convolutional neural networks for low-power, resource-constrained devices*, Neural Computing and Applications, 2022.
- Fire growth: t-squared fire (NFPA 72 / SFPE). Flame height: Heskestad. Plume: McCaffrey. Toxicity: ISO 13571 fractional effective dose.
- Exposure limits: NIOSH IDLH (CO 1,200 ppm, CO₂ 40,000 ppm), OSHA PEL.
