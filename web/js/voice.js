// Hands-free voice loop: push-to-talk -> local Whisper STT -> Gemini (actions + reply) -> local Piper TTS.
// Falls back to a rule-based parser and the browser's voice when the backend or key is missing.
import {
  S, sim, units, unitById, tasks, fires, cells, addLog, onEv, emitEv, assignTask, moveUnit, pullBack, cellCenter, cellNameAt,
  updateWind, COMPASS, compass, LVL_NAME, nav, navIdx, primaryFire, tplus, DRONE_KINDS,
} from './core.js';
import { BUILDINGS, startScan, enterBuilding, exitBuilding } from './interior.js';
import { P, makePlans, commitPlan, closePlans } from './planner.js';

export const V = { state:'idle', last:null, history:[], alerts:true, backend:null };

/* ---------------- speech output (queue) ---------------- */
const queue = []; let speaking = false; let audioCtxUnlocked = false;
export function say(text, prio = 1){
  if (!text) return;
  if (prio >= 2) queue.unshift(text); else queue.push(text);
  if (queue.length > 4) queue.length = 4;
  pump();
}
async function pump(){
  if (speaking || !queue.length) return;
  speaking = true; const text = queue.shift();
  emitEv('speaking', text);
  try {
    const r = await fetch('/api/tts', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ text }), signal:AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('tts');
    const url = URL.createObjectURL(await r.blob());
    await new Promise(res => { const a = new Audio(url); a.onended = a.onerror = res; a.play().catch(res); });
    URL.revokeObjectURL(url);
  } catch {
    await new Promise(res => { if (!('speechSynthesis' in window)) return res(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; u.onend = u.onerror = res; speechSynthesis.speak(u); });
  }
  speaking = false; emitEv('speaking', null); pump();
}
onEv('say', ({ text, prio }) => { if (V.alerts) say(text, prio); });

/* ---------------- push to talk ---------------- */
let rec = null, chunks = [];
export async function startTalk(){
  if (V.state === 'listening') return;
  try {
    const stream = V.stream || (V.stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true } }));
    chunks = []; rec = new MediaRecorder(stream, { mimeType:MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '' });
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.start(); V.state = 'listening'; emitEv('voice', V);
  } catch (e){ V.state = 'idle'; V.last = { error:'Microphone not available' }; emitEv('voice', V); }
}
export async function stopTalk(){
  if (!rec || V.state !== 'listening') return;
  const done = new Promise(res => rec.onstop = res); rec.stop(); await done;
  V.state = 'thinking'; emitEv('voice', V);
  const blob = new Blob(chunks, { type:'audio/webm' });
  if (blob.size < 2000){ V.state = 'idle'; emitEv('voice', V); return; }
  let text = '';
  try {
    const fd = new FormData(); fd.append('audio', blob, 'ptt.webm');
    const r = await fetch('/api/stt', { method:'POST', body:fd, signal:AbortSignal.timeout(15000) });
    text = (await r.json()).text || '';
  } catch { V.last = { error:'Speech service offline' }; V.state = 'idle'; emitEv('voice', V); return; }
  await handle(text, 'voice');
}

/* ---------------- understanding ---------------- */
function situation(){
  const L = [];
  L.push(`Time T+${tplus(sim.t)}. Wind ${sim.windSpeed} m/s from ${compass(sim.windFrom)}. Red cells: ${S.redCells || 0}. Sim ${sim.paused ? 'paused' : 'running'} at ${sim.speed}x.`);
  for (const f of fires) L.push(`Fire ${f.name}: ${f.out ? 'out' : `${Math.round(f.I * 100)}% intensity, ${(f.Q / 1000).toFixed(0)} MW, cell ${cellNameAt(f.x, f.z)}`}.`);
  for (const u of units) L.push(`Unit ${u.id} (${u.name}) at ${cellNameAt(u.pos.x, u.pos.z)}: ${u.status}; alert ${LVL_NAME[u.level]}; ${Math.round(u.sens.T)}°C, ${u.sens.q.toFixed(1)} kW/m², CO ${Math.round(u.sens.co)} ppm.`);
  for (const b of Object.values(BUILDINGS)){
    const found = b.persons.filter(p => p.found && !p.rescued);
    L.push(`Building ${b.id} (${b.name}): missing ${b.missing}, scanned ${b.scanned ? 'yes' : 'no'}, people found ${found.length}${found.length ? ' in ' + [...new Set(found.map(p => b.rooms[b.idx[p.room]].name))].join(', ') : ''}, rescued ${b.persons.filter(p => p.rescued).length}.`);
  }
  const open = tasks.filter(t => ['queued', 'withdrawn', 'blocked'].includes(t.status)).map(t => `${t.title} (${t.unit})`);
  if (open.length) L.push(`Pending tasks: ${open.join('; ')}.`);
  if (P.open && P.plans.length) L.push(`Entry plans for ${P.b.id}: ${P.plans.map(p => `${p.id} via ${p.door.name}: ${p.verdict}, ${Math.round(p.end)} s`).join('; ')}.`);
  return L.join('\n');
}
export async function handle(text, via = 'text'){
  text = (text || '').trim(); if (!text) { V.state = 'idle'; emitEv('voice', V); return; }
  V.state = 'thinking'; V.last = { heard:text }; emitEv('voice', V);
  let out = null;
  try {
    const r = await fetch('/api/assist', { method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ text, situation:situation(), history:V.history }), signal:AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(await r.text());
    out = await r.json();
  } catch {
    out = localParse(text);
  }
  const done = execute(out.actions || []);
  V.history.push({ role:'user', text }, { role:'model', text:out.reply });
  V.history = V.history.slice(-8);
  V.last = { heard:text, reply:out.reply, actions:done, model:out.model || 'offline parser', ms:out.ms };
  V.state = 'idle'; emitEv('voice', V);
  addLog(`“${text}” → ${out.reply}`, '');
  say(out.reply, 2);
}

/* ---------------- actions ---------------- */
const normUnit = s => { if (!s) return null; const m = String(s).toUpperCase().replace(/\s+/g, '').match(/^(?:ENGINE|E)([12])$|^(?:HAZMAT|H)1$|^(?:RESCUE|R)1$|^(?:DRONE|SCOUT|D)?D?([123])$/);
  if (!m) return unitById(String(s).toUpperCase()); if (m[1]) return unitById('E' + m[1]); if (/^H/.test(m[0])) return unitById('H1'); if (/^R/.test(m[0])) return unitById('R1'); return unitById('D' + m[2]); };
const normB = s => { s = String(s || '').toUpperCase(); return /W|WARE/.test(s) ? 'W1' : /A|ADMIN/.test(s) ? 'A1' : null; };
export function execute(actions){
  const done = [];
  for (const a of actions){
    const u = normUnit(a.unit), type = (a.type || '').toLowerCase();
    try {
      if (type === 'move' && u){ const c = cellCenter(a.target); if (c){ moveUnit(u, c.x, c.z); done.push(`${u.id}→${a.target}`); } }
      else if (type === 'pull_back'){ const list = u ? [u] : units.filter(x => x.level >= 2 || nav.level[navIdx(x.pos.x, x.pos.z)] >= 2 || /all/i.test(a.unit || '')); list.forEach(x => pullBack(x)); done.push(`pull back ${list.map(x => x.id).join(',') || 'none'}`); }
      else if (type === 'task'){
        const kind = (a.value || '').toLowerCase(); const unit = u || unitById({ foam:'E2', cool:'E1', recon:'D1', survey:'D2', evac:'R1', contain:'H1' }[kind]);
        const open = tasks.filter(t => t.kind === kind && !['done', 'cancelled'].includes(t.status));
        const t = open.find(t => t.unit === unit.id && t.status !== 'working') || open.find(t => t.status === 'queued') || open[0];
        if (t && unit && unit.isDrone === DRONE_KINDS.includes(kind)){ assignTask(t, unit); done.push(`${unit.id}: ${t.title}`); }
      }
      else if (type === 'scan'){ const b = normB(a.target) || 'W1'; const d = u && u.indoor ? u : unitById('D3'); if (startScan(d, b)) done.push(`${d.id} scan ${b}`); }
      else if (type === 'plan'){ const b = normB(a.target) || (P.b && P.b.id) || 'W1'; makePlans(b); done.push(`plans ${b}`); }
      else if (type === 'commit_plan'){ if (P.plans.length){ const k = a.value && /^[A-D]$/i.test(a.value) ? P.plans.findIndex(p => p.id === a.value.toUpperCase()) : P.sel; commitPlan(Math.max(0, k)); done.push('commit plan'); } }
      else if (type === 'enter'){ const b = normB(a.target); if (b){ enterBuilding(b); done.push(`enter ${b}`); } }
      else if (type === 'exit'){ if (P.open) closePlans(); exitBuilding(); done.push('exit'); }
      else if (type === 'wind'){ const m = String(a.value || '').toUpperCase().match(/(N|NE|E|SE|S|SW|W|NW)\b\D*(\d+(?:\.\d+)?)?/); if (m){ sim.windFrom = COMPASS.indexOf(m[1]) * 45; if (m[2]) sim.windSpeed = Math.min(12, +m[2]); updateWind(); done.push(`wind ${m[1]}`); } }
      else if (type === 'speed'){ const v = parseFloat(a.value); if ([1, 5, 20].includes(v)){ sim.speed = v; done.push(`speed ${v}x`); } }
      else if (type === 'pause'){ sim.paused = true; done.push('pause'); }
      else if (type === 'resume'){ sim.paused = false; done.push('resume'); }
    } catch (e){ console.warn('action failed', a, e); }
  }
  emitEv('acted', done);
  return done;
}

/* ---------------- offline fallback parser ---------------- */
function localParse(raw){
  const s = raw.toLowerCase();
  const um = s.match(/\b(engine\s*[12]|e\s*[12]|hazmat\s*1?|h1|rescue\s*1?|r1|drone\s*d?[123]|d[123]|scout)\b/);
  const unit = um ? (um[1] === 'scout' ? 'D3' : um[1].replace(/\s+/g, '')) : null;
  const tail = s.includes(' to ') ? s.slice(s.lastIndexOf(' to ') + 4) : s;
  const cm = tail.match(/\b([a-j])\s*(10|[1-9])\b/);
  const bld = /ware|w-?1|w one/.test(s) ? 'W1' : /admin/.test(s) ? 'A1' : null;
  const A = [];
  if (/pull ?back|withdraw|retreat/.test(s)) A.push({ type:'pull_back', unit:unit || 'all' });
  else if (/scan|search/.test(s)) A.push({ type:'scan', unit:'D3', target:bld || 'W1' });
  else if (/commit|execute|go with/.test(s)) A.push({ type:'commit_plan', value:(s.match(/plan\s+([abcd])\b/) || [])[1] });
  else if (/plan|rescue|get (them|people) out/.test(s)) A.push({ type:'plan', target:bld || 'W1' });
  else if (/\b(inside|enter|zoom in)\b/.test(s) && bld) A.push({ type:'enter', target:bld });
  else if (/\b(outside|exit|zoom out|back out)\b/.test(s)) A.push({ type:'exit' });
  else if (/(send|move|go|fly)\b/.test(s) && unit && cm) A.push({ type:'move', unit, target:cm[1].toUpperCase() + cm[2] });
  else if (/foam|attack|extinguish/.test(s)) A.push({ type:'task', unit, value:'foam' });
  else if (/cool/.test(s)) A.push({ type:'task', unit, value:'cool' });
  else if (/pause|freeze/.test(s)) A.push({ type:'pause' });
  else if (/resume|continue|play/.test(s)) A.push({ type:'resume' });
  const reply = A.length ? 'Copy.' : unit ? `${unitById(unit.toUpperCase().replace('ENGINE', 'E').replace('DRONE', ''))?.status || 'No data'}.` : 'Say again?';
  return { reply, actions:A, model:'offline parser' };
}

/* ---------------- backend capabilities ---------------- */
export async function probe(){
  try { V.backend = await (await fetch('/api/health', { signal:AbortSignal.timeout(3000) })).json(); }
  catch { V.backend = null; }
  emitEv('voice', V);
  return V.backend;
}
