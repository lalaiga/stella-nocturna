#!/usr/bin/env bash
# Look for already-installed packages / models in WSL that A3TN can reuse.
echo "== venvs"; ls -d ~/venvs/*/ 2>/dev/null; ls -d ~/*/.venv ~/*/venv ~/miniconda3 ~/anaconda3 2>/dev/null
echo "== site-packages with opencv / cudnn / cublas / ctranslate2 / ultralytics"
for sp in $(find ~ /usr/local/lib /usr/lib/python3* -maxdepth 6 -type d -name site-packages 2>/dev/null | grep -v '/venvs/a3tn/'); do
  hits=$(ls "$sp" 2>/dev/null | grep -iE '^(cv2|opencv_python[^/]*dist-info|ultralytics|ctranslate2|faster_whisper|piper)$|^nvidia$' | tr '\n' ' ')
  [ -n "$hits" ] && echo "$sp : $hits" && ls "$sp/nvidia" 2>/dev/null | tr '\n' ' ' && echo
done
echo "== pip / uv caches"; du -sh ~/.cache/pip ~/.cache/uv 2>/dev/null
echo "== model caches"
du -sh ~/.cache/huggingface ~/.cache/whisper ~/.cache/torch 2>/dev/null
find ~ -maxdepth 6 \( -name 'model.bin' -path '*whisper*' -o -name '*.onnx' -path '*piper*' -o -name 'yolo11n.pt' -o -name 'yolov8n.pt' \) 2>/dev/null | head
echo "== system cuda libs"; ls /usr/local/cuda*/lib64/libcudnn* /usr/lib/x86_64-linux-gnu/libcudnn* 2>/dev/null | head -3
