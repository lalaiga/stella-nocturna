// Silent video recorder for the scripted scenario (open the app with #record).
// Composites the 3D canvas with a produced overlay (brand + clock, step caption, Visor message, unit labels and
// burned-in subtitles) onto a 1280x720 canvas, records it with MediaRecorder (no audio track) and saves the file
// and a matching .srt through the local server. Starts when the scenario starts, stops a few seconds after it ends.
import { THREE, sim, units, camera, controls, renderer, composer, uScale, onEv, tplus } from './core.js';
import { scenarioStatus } from './scenario.js';
import { V } from './voice.js';

export const REC_MODE = location.hash === '#record';
const NO_SUBS = new URLSearchParams(location.search).has('nosubs');   // ?nosubs=1 : no subtitle bar, separate output file
const OUT = NO_SUBS ? 'scenario_nosubs' : 'scenario';
const W = 1280, H = 720, FPS = 30;
const R = { canvas:null, ctx:null, mr:null, chunks:[], t0:0, queue:[], cur:null, srt:[], visor:'', visorCls:'l0', visorAt:0, endAt:0, state:'idle' };
const INK = '#14181e', MUTE = '#4c5562', HOT = '#e0501a', BAD = '#d4301f', WARN = '#b8770e';
const _v = new THREE.Vector3();
if (REC_MODE){
  V.alerts = false;                       // never speak while recording
  controls.enabled = false;               // the director camera owns the view
  const st = document.createElement('style');   // hide the dashboard so a stray click cannot interrupt the take
  st.textContent = '#left,#right,.corner,#cam,#timeline,#voice,#hint,#shade{visibility:hidden!important;pointer-events:none!important} .labels{display:none!important}';
  document.head.appendChild(st);
}

onEv('say', ({ text }) => { if (REC_MODE && (R.state === 'idle' || R.state === 'recording')) R.queue.push(text); });

const fmtSrt = s => { const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), sec = Math.floor(ms % 60000 / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };

function begin(){
  R.canvas = document.createElement('canvas'); R.canvas.width = W; R.canvas.height = H; R.ctx = R.canvas.getContext('2d');
  const stream = R.canvas.captureStream(FPS);                       // video only: there is no audio track to mute
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  R.mr = new MediaRecorder(stream, { mimeType:mime, videoBitsPerSecond:5_000_000 });
  R.mr.ondataavailable = e => { if (e.data.size) R.chunks.push(e.data); };
  R.mr.onstop = upload;
  R.mr.start(1000); R.t0 = performance.now(); R.state = 'recording';
  R.queue.unshift('A3TN Command. Full scenario: silent run, with subtitles.');
}
async function upload(){
  R.state = 'uploading';
  const blob = new Blob(R.chunks, { type:'video/webm' });
  const srt = R.srt.map((s, i) => `${i + 1}\n${fmtSrt(s.start)} --> ${fmtSrt(s.end)}\n${s.text}\n`).join('\n');
  const send = async (name, data) => {
    const CH = 4 * 1024 * 1024;
    for (let off = 0, part = 0; off < data.size || part === 0; off += CH, part++){
      const r = await fetch(`/api/save_video?name=${name}&part=${part}`, { method:'POST', body:data.slice(off, off + CH) });
      if (!r.ok) throw new Error('upload failed ' + r.status);
    }
  };
  try { if (!NO_SUBS) await send(OUT + '.srt', new Blob([srt])); await send(OUT + '.webm', blob); R.state = 'done'; }
  catch (e){ R.state = 'error: ' + e.message; }
  window.__recorder = { state:R.state, bytes:blob.size, seconds:Math.round((performance.now() - R.t0) / 1000), subtitles:R.srt.length };
}

function forceSize(){
  if (renderer.domElement.width === W && renderer.domElement.height === H) return true;
  renderer.setPixelRatio(1); renderer.setSize(W, H, false); composer.setPixelRatio && composer.setPixelRatio(1); composer.setSize(W, H);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  uScale.value = H / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  return false;
}
function panel(ctx, x, y, w, h, fill = 'rgba(255,255,255,.84)'){ ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
function wrap(ctx, text, maxW){
  const words = text.split(/\s+/), lines = []; let line = '';
  for (const w of words){ const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line){ lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line); return lines;
}

export function recorderTick(dt){
  if (!REC_MODE) return;
  const st = scenarioStatus();
  if (R.state === 'idle' && st.running) begin();
  if (R.state !== 'recording' || !R.ctx) return;
  if (!forceSize()) return;
  const t = (performance.now() - R.t0) / 1000, ctx = R.ctx;
  ctx.drawImage(renderer.domElement, 0, 0, W, H);

  // ---- brand + clock (top-left)
  panel(ctx, 20, 18, 300, 92);
  ctx.fillStyle = INK; ctx.font = '700 40px "IBM Plex Mono", monospace'; ctx.fillText('A3TN', 34, 62);
  ctx.fillStyle = MUTE; ctx.font = '500 18px "IBM Plex Mono", monospace'; ctx.fillText('T+', 34, 96);
  ctx.fillStyle = INK; ctx.font = '500 30px "IBM Plex Mono", monospace'; ctx.fillText(tplus(sim.t), 66, 98);
  ctx.fillStyle = MUTE; ctx.font = '400 15px "IBM Plex Mono", monospace'; ctx.fillText(sim.paused ? 'paused · planning' : `${sim.speed}× speed`, 168, 98);

  // ---- step caption (top, between the brand and the Visor panels)
  const steps = st.steps, idx = steps.findIndex(s => s.state === 'todo'), n = steps.length;
  const capHead = st.finished || idx < 0 ? 'COMPLETE' : `STEP ${idx + 1} / ${n}`, capBody = st.finished || idx < 0 ? (st.summary || '') : steps[idx].title;
  ctx.font = '500 17px "IBM Plex Mono", monospace';
  const cl = wrap(ctx, capBody, 470).slice(0, 3), ch = 40 + cl.length * 22;
  panel(ctx, 340, 18, 500, ch);
  ctx.fillStyle = HOT; ctx.font = '700 19px "IBM Plex Mono", monospace'; ctx.fillText(capHead, 356, 44);
  ctx.fillStyle = INK; ctx.font = '500 17px "IBM Plex Mono", monospace'; cl.forEach((l, i) => ctx.fillText(l, 356, 68 + i * 22));

  // ---- Visor (top-right)
  if (t - R.visorAt > 0.3){ R.visorAt = t; const el = document.getElementById('visorText'); R.visor = el ? el.innerHTML.replace(/<\/b>/i, ' · ').replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : ''; const vb = document.getElementById('visor'); R.visorCls = vb ? vb.className : 'l0'; }
  ctx.font = '500 20px "IBM Plex Mono", monospace';
  const vl = wrap(ctx, R.visor, 370).slice(0, 4), vh = 44 + vl.length * 26;
  panel(ctx, W - 20 - 400, 18, 400, vh);
  ctx.fillStyle = MUTE; ctx.font = '600 14px "IBM Plex Mono", monospace'; ctx.fillText('VISOR', W - 20 - 390, 38);
  ctx.font = '500 20px "IBM Plex Mono", monospace';
  ctx.fillStyle = /l[23]/.test(R.visorCls) ? BAD : /l1/.test(R.visorCls) ? WARN : INK;
  vl.forEach((l, i) => ctx.fillText(l, W - 20 - 390, 66 + i * 26));

  // ---- unit labels
  ctx.font = '600 16px "IBM Plex Mono", monospace'; ctx.textAlign = 'center';
  for (const u of units){
    if (!u.mesh.visible) continue;
    _v.set(u.pos.x, (u.isDrone ? u.pos.y : 3) + 3.4, u.pos.z).project(camera); if (_v.z > 1 || Math.abs(_v.x) > 1 || Math.abs(_v.y) > 1) continue;
    const x = (_v.x * 0.5 + 0.5) * W, y = (-_v.y * 0.5 + 0.5) * H;
    if (y < 125 || y > H - 110) continue;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(u.id, x, y);
    ctx.fillStyle = u.level >= 2 ? BAD : u.level === 1 ? WARN : INK; ctx.fillText(u.id, x, y);
  }
  ctx.textAlign = 'left';

  // ---- subtitles (burned in, bottom-centre)
  if (R.cur && t >= R.cur.end){ R.srt.push({ start:R.cur.start, end:R.cur.end, text:R.cur.text }); R.cur = null; }
  if (!R.cur && R.queue.length){ const text = R.queue.shift(); const dur = Math.min(7, Math.max(2.6, 1.8 + text.length * 0.05)) * (R.queue.length > 2 ? 0.7 : 1); R.cur = { text, start:t, end:t + dur }; }
  if (R.cur && !NO_SUBS){
    ctx.font = '600 32px "IBM Plex Sans Condensed", "IBM Plex Mono", sans-serif';
    const lines = wrap(ctx, R.cur.text, 1100), lh = 42, bh = lines.length * lh + 22, by = H - 36 - bh;
    const bw = Math.min(1140, Math.max(...lines.map(l => ctx.measureText(l).width)) + 44);
    panel(ctx, (W - bw) / 2, by, bw, bh, 'rgba(10,12,16,.78)');
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, by + 11 + (i + 1) * lh - 10));
    ctx.textAlign = 'left';
  }

  // ---- stop a few seconds after the scenario ends (the summary stays on screen)
  if (st.finished && !R.endAt) R.endAt = t + 7;
  if (R.endAt && t >= R.endAt && R.state === 'recording'){
    if (R.cur){ R.srt.push({ start:R.cur.start, end:t, text:R.cur.text }); R.cur = null; }
    R.state = 'stopping'; R.mr.stop();
  }
  window.__recorder = { state:R.state, t:Math.round(t), subtitles:R.srt.length, queue:R.queue.length };
}
