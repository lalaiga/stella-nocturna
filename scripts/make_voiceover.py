"""Add a voice-over to a recorded scenario video.

    python scripts/make_voiceover.py video/scenario_nosubs.mp4 video/scenario_nosubs.cues.json video/scenario_nosubs_voiceover.mp4
    python scripts/make_voiceover.py video/scenario_1min.mp4 video/scenario_1min.cues.json video/scenario_1min_voiceover.mp4 --short   # exactly 60.0 s

The cues file (written by the in-page recorder, web/js/recorder.js) says when each narration line is due.
Each line is synthesised by the local Piper voice through the running backend (POST /api/tts), placed at its
cue time (never overlapping the previous line), mixed, and muxed onto the untouched video track.
Needs: the backend running on localhost:8765, and ffmpeg / ffprobe (FFMPEG_DIR env var, or on PATH).
"""
import json, os, shutil, subprocess, sys, tempfile, urllib.request, wave, pathlib

API = os.environ.get("A3TN_API", "http://localhost:8765")
GAP = 0.4          # seconds of silence kept between two lines
TAIL = 0.3         # keep the last line this far from the end of the video

# Final narration wording (shorter than the on-screen script, so lines keep up with a fast-moving scenario)
TEXT = {
    "intro":  "A fire has broken out at a chemical plant, and two workers are missing.",
    "safety": "Engine 2 is sent too close, and the system pulls it back by itself.",
    "drones": "Two firefighting drones now spray foam on the fire.",
    "foam":   "Engine 2 returns and attacks from a safe distance.",
    "scan1":  "At roll call, two workers are missing. The indoor drone flies into the warehouse and finds them.",
    "plan1":  "The system predicts the smoke, picks the safest way in, and the rescue team goes in.",
    "scan2":  "The warehouse is clear. The drone now checks the admin building, where one person is missing.",
    "plan2":  "Another person is found. A safe plan is built, and the rescue team goes in.",
    "finish": "Everyone is out, and the fire is out. Three people saved. That is A3TN Command.",
}

# One-minute cut: shorter lines, so they keep up with the fast part of the scenario
TEXT_SHORT = {
    "intro":  "A fire at a chemical plant. Two workers are missing.",
    "safety": "An engine sent too close is pulled back automatically.",
    "drones": "Firefighting drones spray foam on the fire.",
    "foam":   "The engine attacks again, from a safe distance.",
    "scan1":  "Roll call: two missing. The indoor drone finds them in the warehouse.",
    "plan1":  "The system picks the safest way in, and the rescue team goes.",
    "scan2":  "Warehouse clear. Now the admin block.",
    "plan2":  "One more person found. Rescue goes in.",
    "finish": "Everyone is out. Three saved. A3TN Command.",
}

def tool(name):
    d = os.environ.get("FFMPEG_DIR")
    p = shutil.which(name) or (str(pathlib.Path(d) / (name + ".exe")) if d else None)
    if not p or not pathlib.Path(p).exists():
        sys.exit(f"{name} not found: put it on PATH or set FFMPEG_DIR")
    return p

def tts(text, path):
    req = urllib.request.Request(API + "/api/tts", data=json.dumps({"text": text}).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as f:
        f.write(r.read())
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()

def main(video, cues_path, out, short=False):
    ffmpeg, ffprobe = tool("ffmpeg"), tool("ffprobe")
    texts = TEXT_SHORT if short else TEXT
    final = 60.0 if short else None      # strict length for the one-minute cut
    cues = json.loads(pathlib.Path(cues_path).read_text(encoding="utf-8"))
    vdur = float(subprocess.check_output([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", video]).decode())
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="a3tn_vo_"))
    # one-minute cut: drop the idle tail after the closing line, then compress the rest evenly to the target length
    src_end, scale = vdur, 1.0
    if final:
        src_end = min(vdur, max(c["t"] for c in cues) + 6.0)
        scale = final / src_end if src_end > final else 1.0
        for c in cues: c["t"] *= scale
        print(f"source {vdur:.1f}s -> keeping {src_end:.1f}s, playback x{1 / scale:.2f} to reach {final:.0f}s")
    plan, t_free = [], 0.0
    for i, c in enumerate(sorted(cues, key=lambda c: c["t"])):
        text = texts.get(c["id"], c["text"])
        wav = str(tmp / f"{i:02d}_{c['id']}.wav"); dur = tts(text, wav)
        start = max(c["t"], t_free)
        plan.append({"id": c["id"], "cue": c["t"], "start": start, "end": start + dur, "wav": wav, "text": text})
        t_free = start + dur + GAP
    if final: vdur_out = final
    else: vdur_out = vdur
    over = plan[-1]["end"] - (vdur_out - TAIL)      # the closing line must not be cut: start it earlier if needed
    if over > 0:
        floor = (plan[-2]["end"] + GAP) if len(plan) > 1 else 0
        shift = min(over, plan[-1]["start"] - floor)
        plan[-1]["start"] -= shift; plan[-1]["end"] -= shift
    print(f"video {vdur:.1f}s -> output {vdur_out:.1f}s, {len(plan)} lines")
    for p in plan:
        print(f"  {p['id']:7s} cue {p['cue']:6.1f}s  speaks {p['start']:6.1f}-{p['end']:6.1f}s  (late by {p['start'] - p['cue']:4.1f}s)")
    if plan[-1]["end"] > vdur_out - TAIL:
        print(f"  ! last line ends at {plan[-1]['end']:.1f}s, past the video end: it will be cut")
    # mix: each clip delayed to its start time, then summed and loudness-normalised
    args = [ffmpeg, "-y", "-loglevel", "error", "-i", video]
    for p in plan: args += ["-i", p["wav"]]
    chains = [f"[{i + 1}:a]adelay={int(p['start'] * 1000)}|{int(p['start'] * 1000)},apad[a{i}]" for i, p in enumerate(plan)]
    mix = "".join(f"[a{i}]" for i in range(len(plan))) + f"amix=inputs={len(plan)}:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=7,aresample=48000,apad=whole_dur={vdur_out:.3f},atrim=0:{vdur_out:.3f}[aout]"
    args += ["-filter_complex", ";".join(chains + [mix]), "-map", "0:v", "-map", "[aout]"]
    if final:   # re-encode so the length is exact: hold the last frame if short, cut the tail if long
        args += ["-vf", f"trim=duration={src_end:.3f},setpts=(PTS-STARTPTS)*{scale:.6f},fps=30,tpad=stop_mode=clone:stop_duration=8,trim=duration={final:.3f},setpts=PTS-STARTPTS", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30"]
    else:
        args += ["-c:v", "copy"]
    args += ["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]
    subprocess.run(args, check=True)
    (pathlib.Path(out).with_suffix(".voiceover.txt")).write_text(
        "\n".join(f"{p['start']:.1f}s  {p['text']}" for p in plan), encoding="utf-8")
    print("wrote", out)

if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if x != "--short"]
    if len(a) != 3: sys.exit(__doc__)
    main(*a, short="--short" in sys.argv)
