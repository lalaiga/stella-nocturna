# A3TN Command: AI model report

A3TN Command helps Protection Civile commanders keep crews safe at industrial fires. Its AI does four jobs: **see** the fire (drone vision), **predict** where smoke and heat will go inside buildings (graph neural network), **combine** every sensor into one picture (sensor fusion), and **listen and talk** to gloved firefighters (speech + language model). All models except the language model run locally on one laptop GPU, so the system keeps working on a site with no internet.

---

## 1. Fire and smoke detection (YOLO11n)

**Task.** Detect `fire` and `smoke` boxes in drone camera frames, so a drone circling an industrial site confirms the fire, its extent and smoke in seconds.

**Architecture.** Ultralytics YOLO11n: a single-stage, anchor-free detector (CSP backbone with C3k2 blocks, SPPF and C2PSA attention, PAN neck, decoupled detection head), about 2.6 M parameters and 6.5 GFLOPs at 640 px. Fine-tuned from COCO-pretrained weights.

**Why this model.**
- Runs in real time on drone-class edge computers (e.g. NVIDIA Jetson Orin Nano), so detection happens on board and only alerts are sent over the radio link.
- Nano size keeps power draw and weight low, which matters for flight endurance.
- Proven family for fire detection, mature tooling, exports to ONNX / TensorRT.

**Dataset.** D-Fire (de Venâncio et al., 2022): 21,527 images with YOLO labels, two classes (0 smoke, 1 fire), including fire-only, smoke-only, both, and hard negatives (no fire, fire-like scenes). We use the published train / test split (test = validation here). Augmentation: Ultralytics defaults (mosaic, HSV, flips, scale).

**Training.** 640 px, batch 32, cosine LR, early stopping (patience 15), on an RTX 5050 laptop GPU.

**Results** (validation split, never used for training):

| Metric | Value |
|---|---|
| mAP@0.5 (all) | _see `ml/models/yolo_metrics.txt`_ |
| mAP@0.5:0.95 | _see `ml/models/yolo_metrics.txt`_ |
| AP@0.5 fire / smoke | _see `ml/models/yolo_metrics.txt`_ |
| Inference (RTX 5050, 640 px) | shown live in the app (ms per frame) |

**In the app.** Drone D1's camera panel replays held-out validation images through the model in real time; detections feed the sensor-fusion fire probability of the cell D1 is watching.

**Limits and next steps.** D-Fire is mostly ground-level and wildfire imagery. Next: fine-tune on aerial industrial footage (FLAME dataset, Protection Civile footage) and add a thermal (IR) channel.

---

## 2. Smoke-spread graph neural network

**Task.** Given a building's floor plan as a graph (rooms = nodes, doors = edges) and the current smoke and temperature in each room, predict both 5 s ahead; rolled forward, this gives a 15-minute forecast used to grade every entry plan.

**Why a GNN.** Floor plans differ in size and shape. A message-passing GNN works on any graph without retraining: it learns local physics (smoke moving through an opening, heat lost to walls) and reuses it everywhere. One forward pass costs milliseconds, so the planner can evaluate several doors and many minutes ahead instantly.

**Architecture.** Encode–process–decode message-passing network (in the style of Battaglia et al. / MeshGraphNets):
- Node input (7): smoke index, temperature, heat-release rate now and next step, log room volume, open area to outside, outside smoke level.
- Edge input (1): door opening area.
- Encoder MLPs to 96-d, 4 message-passing layers (edge MLP on [sender, receiver, edge], sum aggregation, residual node MLP), decoder MLP to Δsmoke and Δtemperature.
- Trained with noise injection on inputs so long autoregressive rollouts stay stable.

**Dataset.** Generated: 3,000 random floor plans (2–20 rooms, random sizes, doors open/closed/wide, exterior vents), 1–2 fires each with random peak heat release (0.3–4 MW) following the NFPA t-squared "fast" growth curve, simulated with a multi-room zone model (well-mixed zones, buoyancy-driven exchange through doors ∝ A·√ΔT, venting, wall losses). 200 separate floor plans held out for testing.

**Results** (held-out floor plans, full 6-minute autoregressive rollout):

| Metric | Value |
|---|---|
| Smoke-index MAE (0–1 scale) | **0.007** |
| Temperature MAE (all rooms) | **1.9 °C** |
| Temperature MAE (rooms > 60 °C) | **3.2 °C** |
| Parameters | 391 k (trains in ~5 min on a laptop GPU) |

**Honest limits.** The teacher is a zone model, not CFD. The architecture is ready to be retrained on NIST Fire Dynamics Simulator (FDS) runs of real Tunisian industrial buildings, which is the planned next step with the Protection Civile.

---

## 3. Sensor fusion

**Task.** Turn many noisy, partial sensors into one trustworthy picture per map cell and per room.

**Methods.**
- **Temperature per cell:** Gaussian inverse-variance fusion of the physics model (prior, σ = 12 °C) with every sensor in the cell: crew wearables (σ = 2 °C), low drones (σ = 7 °C), high drones (σ = 20 °C, they see the plume), fixed heat detectors (σ = 1 °C). Output: fused temperature ± uncertainty.
- **Fire probability per cell:** log-odds Bayesian update from fixed-temperature heat detectors (57 °C rating, likelihood ratio 20), YOLO detections on the drone feed, and weak physics evidence, with forgetting so stale evidence fades.
- **Person presence per room:** log-odds update from indoor thermal scans (P(detect | present) = 0.95, false alarm 0.03). A person is shown once P > 0.8.

**Why.** Commanders must not trust one sensor. Fusion makes the uncertainty visible ("64 ± 3 °C, from model + E2 + HD-1") and the "Why is this red?" panel lists the sources behind each decision.

---

## 4. Voice assistant (speech in, speech out)

**Task.** Firefighters wear gloves and breathing apparatus and cannot use a touchscreen. They hold a push-to-talk button and speak.

**Pipeline.**
1. **Speech to text: Whisper base.en** (faster-whisper / CTranslate2, local GPU). Small (74 M parameters), robust to noise, prompted with the unit vocabulary.
2. **Understanding: Gemini** (Google AI Studio). It receives a compact situation report (units, alerts, fires, buildings, casualties, plans) and returns structured JSON: a short radio-style reply plus a list of actions (move, pull back, scan, plan, commit plan, task, wind, pause, ...). The system prompt enforces crew safety (refuse or warn on orders into critical cells) and facts-only answers.
3. **Actions** are executed by the app, so the model cannot invent capabilities.
4. **Text to speech: Piper** (local, CPU, en_US voice), replies in under a second. The Visor also speaks critical alerts (auto-withdraw, fire spread, scan results) unprompted.

**Offline fallback.** If the language model or network is unavailable, a rule-based parser handles the core orders and the browser voice speaks, so the system degrades gracefully.

---

## 5. Physics and safety references

- t-squared fire growth: NFPA 72 / SFPE Handbook ("fast" α = 0.0469 kW/s²).
- Flame height: Heskestad correlation. Plume centreline temperature: McCaffrey / Heskestad.
- Radiant heat flux: point-source model, radiative fraction 0.30.
- Smoke dispersion outdoors: Gaussian plume with Briggs rural dispersion coefficients.
- Toxicity / incapacitation: ISO 13571 fractional effective dose (CO and convected heat).
- Exposure limits: NIOSH IDLH (CO 1,200 ppm, CO₂ 40,000 ppm), OSHA PEL (CO₂ 5,000 ppm), firefighter radiant-heat bands (1.6 / 4.7 / 10 kW/m²).
