"""A3TN Command local backend.

Serves the web app and the AI services it uses:
  POST /api/stt      speech -> text        faster-whisper (local, GPU if available)
  POST /api/tts      text -> speech (wav)  Piper (local)
  POST /api/assist   text + situation -> reply + actions   Gemini (Google AI Studio key in .env)
  POST /api/detect   image -> fire/smoke boxes             YOLO11n fine-tuned on D-Fire (local)
  POST /api/spread   room graph + state -> smoke/heat forecast   GNN (local)

Run (from WSL, repo root):  python -m uvicorn server.app:app --host 0.0.0.0 --port 8765
"""
from __future__ import annotations
import io, json, os, pathlib, sys, tempfile, time, wave, logging
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import Response, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ml"))
load_dotenv(ROOT / ".env")
log = logging.getLogger("a3tn")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
MODELS = ROOT / "ml" / "models"
CACHE = pathlib.Path.home() / "a3tn-data" / "models"
CACHE.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="A3TN Command")
_lazy: dict = {}


@app.middleware("http")
async def revalidate_static(request, call_next):
    """Make browsers re-check web files on every load, so edits always show up (ETag keeps it cheap)."""
    r = await call_next(request)
    if not request.url.path.startswith("/api"):
        r.headers["Cache-Control"] = "no-cache"
    return r


def cuda_ok() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


# ---------------------------------------------------------------- health
@app.get("/api/health")
def health():
    return {
        "llm": bool(os.getenv("GEMINI_API_KEY")), "llm_model": _lazy.get("llm_model"),
        "yolo": (MODELS / "fire_yolo11n.pt").exists(), "gnn": (MODELS / "gnn_smoke.pt").exists(),
        "cuda": cuda_ok(),
    }


# ---------------------------------------------------------------- speech to text
def whisper():
    if "whisper" not in _lazy:
        from faster_whisper import WhisperModel
        name = os.getenv("WHISPER_MODEL", "base.en")
        try:
            m = WhisperModel(name, device="cuda", compute_type="float16", download_root=str(CACHE))
            segs, _ = m.transcribe(np.zeros(16000, np.float32))
            list(segs)                                   # forces a real decode: fail fast if CUDA libs are missing
            _lazy["whisper"] = m
        except Exception as e:  # noqa: BLE001
            log.warning("whisper on CUDA failed (%s); using CPU int8", e)
            _lazy["whisper"] = WhisperModel(name, device="cpu", compute_type="int8", download_root=str(CACHE))
    return _lazy["whisper"]


def decode_16k(path: str) -> np.ndarray:
    """Decode any browser recording (webm/opus, wav, ...) to 16 kHz mono float32 with PyAV."""
    import av
    out = []
    with av.open(path) as c:
        rs = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in c.decode(audio=0):
            for f in rs.resample(frame):
                out.append(f.to_ndarray().reshape(-1))
        for f in rs.resample(None):
            out.append(f.to_ndarray().reshape(-1))
    return (np.concatenate(out).astype(np.float32) / 32768.0) if out else np.zeros(1600, np.float32)


@app.post("/api/stt")
async def stt(audio: UploadFile = File(...)):
    data = await audio.read()
    with tempfile.NamedTemporaryFile(suffix=pathlib.Path(audio.filename or "a.webm").suffix or ".webm", delete=False) as f:
        f.write(data); path = f.name
    t = time.time()
    audio16k = decode_16k(path)
    segs, info = whisper().transcribe(audio16k, language="en", beam_size=1, vad_filter=True,
                                      initial_prompt="Visor, Engine 1, Engine 2, Hazmat 1, Rescue 1, Drone D1, D2, D3, scout, "
                                                     "warehouse W-1, admin block, pull back, foam attack, scan, entry plan.")
    text = " ".join(s.text.strip() for s in segs).strip()
    os.unlink(path)
    return {"text": text, "ms": int((time.time() - t) * 1000)}


# ---------------------------------------------------------------- text to speech
VOICE = os.getenv("PIPER_VOICE", "en_US-ryan-medium")


def piper():
    if "piper" not in _lazy:
        from huggingface_hub import hf_hub_download
        from piper import PiperVoice
        lang, rest = VOICE.split("-", 1)
        spk, q = rest.rsplit("-", 1)
        sub = f"{lang.split('_')[0]}/{lang}/{spk}/{q}"
        onnx = hf_hub_download("rhasspy/piper-voices", f"{sub}/{VOICE}.onnx", cache_dir=str(CACHE))
        hf_hub_download("rhasspy/piper-voices", f"{sub}/{VOICE}.onnx.json", cache_dir=str(CACHE))
        _lazy["piper"] = PiperVoice.load(onnx)
    return _lazy["piper"]


class TTSIn(BaseModel):
    text: str


@app.post("/api/tts")
def tts(body: TTSIn):
    v = piper()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        if hasattr(v, "synthesize_wav"):
            v.synthesize_wav(body.text[:600], wf)
        else:
            v.synthesize(body.text[:600], wf)
    return Response(buf.getvalue(), media_type="audio/wav")


# ---------------------------------------------------------------- LLM assistant
SYSTEM = """You are VISOR, the voice assistant of A3TN Command, an incident-command system used by
Protection Civile commanders and firefighters at industrial fires. Users wear gloves and breathing
apparatus, so they talk to you instead of touching a screen.

Rules:
- Answer in plain spoken English, at most 2 short sentences (under 30 words). No markdown, no lists.
- Use radio style: unit first, then the fact or order. Example: "Engine 2, pulling back to F6. Heat flux was 7 kilowatts."
- Only state facts present in SITUATION. If unsure, say so and suggest the safest option.
- Crew safety comes first: refuse or warn on orders that send crews into critical cells.
- When the user asks for something the system can do, add it to "actions". Unit ids: E1, E2, H1, R1, D1, D2, D3.
  Cells are letter A-J + number 1-10 (e.g. F4). Buildings: W1 (warehouse), A1 (admin block).
  Action types:
    move {unit, target: cell}            send a unit to a cell
    pull_back {unit | "all"}             withdraw to a safe point
    task {unit, value: foam|cool|recon|survey|evac|contain}
    scan {unit: D3, target: W1|A1}       indoor drone scans a building for people
    plan {target: W1|A1}                 build an entry/rescue plan for that building
    commit_plan {target: W1|A1}          execute the selected plan
    enter {target: W1|A1} / exit {}      zoom the view inside / back outside
    status {unit}                        just answer, no state change
    air_tanker {}                        dispatch the water bomber for an aerial drop
    wind {value: "SE 6"}  speed {value: "1"|"5"|"20"}  pause {}  resume {}
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "actions": {"type": "array", "items": {"type": "object", "properties": {
            "type": {"type": "string"}, "unit": {"type": "string"},
            "target": {"type": "string"}, "value": {"type": "string"}},
            "required": ["type"]}},
    },
    "required": ["reply", "actions"],
}


JSON_ONLY = '\nReply ONLY with JSON: {"reply": str, "actions": [{"type": str, "unit": str, "target": str, "value": str}]}'


def gemini():
    if "gemini" not in _lazy:
        key = os.getenv("GEMINI_API_KEY")
        if not key:
            raise HTTPException(503, "GEMINI_API_KEY missing in .env")
        from google import genai
        client = genai.Client(api_key=key)
        model = os.getenv("GEMINI_MODEL")
        if not model:
            names = [m.name.split("/")[-1] for m in client.models.list()]
            pref = [n for n in names if "flash-lite" in n and "preview" not in n and "tts" not in n] or \
                   [n for n in names if "flash" in n and "preview" not in n and "tts" not in n and "image" not in n] or names
            model = sorted(pref)[-1]
        _lazy["gemini"] = client; _lazy["llm_model"] = model
        log.info("LLM model: %s", model)
    return _lazy["gemini"], _lazy["llm_model"]


class AssistIn(BaseModel):
    text: str
    situation: str = ""
    history: list[dict] = []


@app.post("/api/assist")
def assist(body: AssistIn):
    client, model = gemini()
    from google.genai import types
    contents = []
    for h in body.history[-6:]:
        contents.append(types.Content(role=h.get("role", "user"), parts=[types.Part(text=h.get("text", ""))]))
    contents.append(types.Content(role="user", parts=[types.Part(text=f"SITUATION:\n{body.situation}\n\nUSER SAID: {body.text}")]))
    t = time.time()
    try:
        r = client.models.generate_content(
            model=model, contents=contents,
            config=types.GenerateContentConfig(system_instruction=SYSTEM, temperature=0.2,
                                               response_mime_type="application/json", response_schema=SCHEMA))
    except Exception as e:  # noqa: BLE001  (older/newer SDKs differ on schema format)
        log.warning("schema call failed (%s); retrying with JSON mode only", e)
        r = client.models.generate_content(
            model=model, contents=contents,
            config=types.GenerateContentConfig(system_instruction=SYSTEM + JSON_ONLY,
                                               temperature=0.2, response_mime_type="application/json"))
    try:
        out = json.loads(r.text)
    except Exception:  # noqa: BLE001
        out = {"reply": r.text or "Sorry, say again.", "actions": []}
    out["ms"] = int((time.time() - t) * 1000); out["model"] = model
    return out


# ---------------------------------------------------------------- fire / smoke detection
def yolo():
    if "yolo" not in _lazy:
        from ultralytics import YOLO
        p = MODELS / "fire_yolo11n.pt"
        if not p.exists():
            raise HTTPException(503, "YOLO model not trained yet")
        _lazy["yolo"] = YOLO(str(p))
    return _lazy["yolo"]


@app.post("/api/detect")
async def detect(image: UploadFile = File(...)):
    from PIL import Image
    img = Image.open(io.BytesIO(await image.read())).convert("RGB")
    t = time.time()
    r = yolo().predict(img, imgsz=640, conf=0.25, verbose=False, device=0 if cuda_ok() else "cpu")[0]
    names = r.names
    boxes = [{"cls": names[int(c)], "conf": round(float(p), 3), "xyxyn": [round(float(v), 4) for v in b]}
             for b, c, p in zip(r.boxes.xyxyn.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist())]
    return {"boxes": boxes, "ms": int((time.time() - t) * 1000), "w": img.width, "h": img.height}


# ---------------------------------------------------------------- GNN smoke-spread forecast
def gnn():
    if "gnn" not in _lazy:
        import torch
        from gnn import SmokeGNN
        ck = torch.load(MODELS / "gnn_smoke.pt", map_location="cpu")
        m = SmokeGNN(ck["hidden"], ck["layers"]); m.load_state_dict(ck["state_dict"]); m.eval()
        _lazy["gnn"] = m
    return _lazy["gnn"]


class SpreadIn(BaseModel):
    V: list[float]
    edges: list[list[float]]      # [i, j, open_area_m2]
    ext: list[float]              # open area to outside per room
    s_out: list[float]            # smoke index outside each room's exterior opening
    s: list[float]
    T: list[float]
    Q: list[list[float]]          # HRR schedule per 5 s step: (steps+1) x rooms


@app.post("/api/spread")
def spread(b: SpreadIn):
    from gnn import rollout
    t = time.time()
    S, T = rollout(gnn(), np.array(b.V), np.array(b.edges, float), np.array(b.ext), np.array(b.s_out),
                   np.array(b.s), np.array(b.T), np.array(b.Q))
    return {"s": np.round(S, 4).tolist(), "T": np.round(T, 1).tolist(), "dt": 5, "ms": int((time.time() - t) * 1000)}


# ---------------------------------------------------------------- static web app
@app.get("/")
def index():
    return FileResponse(ROOT / "web" / "index.html")


app.mount("/", StaticFiles(directory=ROOT / "web"), name="web")
