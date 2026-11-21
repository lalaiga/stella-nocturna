// DOM: top bar, roster, incident, buildings, context card, log, camera feed, plan timeline, voice widget, picking.
import {
  THREE, S, sim, units, unitById, unitHits, tasks, fires, cells, W1, camera, renderer, LIM, DRONE_T, LVL_NAME, lvlOf, fmt, tplus,
  cellOf, cellName, compass, COMPASS, updateWind, WV, assignTask, moveUnit, pullBack, onEv, emitEv, primaryFire, HALF, CELLS, overlayMat,
  DRONE_KINDS, clamp, addLog,
} from './core.js';
import { BUILDINGS, buildingAt, roomAt, enterBuilding, exitBuilding, startScan, roomReadings } from './interior.js';
import { P, makePlans, closePlans, selectPlan, commitPlan, setTau } from './planner.js';
import { V, startTalk, stopTalk, handle, say } from './voice.js';
import { toggleSound } from './sound.js';

/* text that decodes into place, like a radio signal locking on */
const GLYPHS = '#%&*+=-/\<>[]{}_01';
export function decode(el, html, ms = 520){
  el.innerHTML = html;
  const nodes = [], walk = n => { for (const c of n.childNodes){ if (c.nodeType === 3){ if (c.nodeValue.trim()) nodes.push({ n:c, s:c.nodeValue }); } else walk(c); } };
  walk(el);
  if (!nodes.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const t0 = performance.now(), id = (el._dec = (el._dec || 0) + 1);
  const tick = now => {
    if (el._dec !== id) return;
    const k = Math.min(1, (now - t0) / ms);
    for (const { n, s } of nodes){
      const cut = Math.floor(s.length * k);
      n.nodeValue = s.slice(0, cut) + [...s.slice(cut)].map(ch => ch === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0]).join('');
    }
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const $ = id => document.getElementById(id);
export const UI = { sel:null, moveFor:null };
const LV = ['ok', 'warn', 'bad', 'bad'];

/* ---------------- top ---------------- */
function renderTop(){
  $('clock').textContent = tplus(sim.t);
  $('playLbl').textContent = sim.paused ? 'play' : 'pause';
  document.querySelectorAll('#speedSeg button').forEach(b => b.classList.toggle('on', +b.dataset.v === sim.speed));
  $('windArrow').style.transform = `rotate(${sim.windFrom + 180}deg)`;
  $('windTxt').textContent = `${sim.windSpeed} m/s ${compass(sim.windFrom)}`;
}
function topReason(u){
  const s = u.sens, p = [];
  if (lvlOf(s.T, u.isDrone ? DRONE_T : LIM.T.v)) p.push(fmt.T(s.T));
  if (lvlOf(s.q, LIM.q.v)) p.push(fmt.q(s.q));
  if (!u.isDrone && lvlOf(s.co, LIM.co.v)) p.push('CO ' + fmt.co(s.co));
  return p.join(' · ');
}
function renderVisor(){
  const alerts = units.filter(u => u.level > 0).sort((a, b) => b.level - a.level || b.sens.q - a.sens.q);
  const top = alerts[0], ev = S.visorEvent && S.clock < S.visorEvent.until ? S.visorEvent : null;
  let lvl = 0, html, btn = null;
  if (top && top.level >= 2){
    lvl = top.level;
    html = `<b>${lvl === 3 ? 'Hazard' : 'Warning'}</b>${top.id} · ${topReason(top)}${top.mode === 'pullback' ? ' · withdrawing' : ''}`;
    if (top.mode !== 'pullback') btn = { id:top.id, label:`Pull back ${top.id}` };
  } else if (ev){ lvl = 3; html = ev.html; }
  else if (top){ lvl = 1; html = `<b>Advisory</b>${top.id} · ${topReason(top)}`; }
  else html = `<b>Visor quiet</b>all ${units.length} units in safe envelope`;
  if (alerts.length > 1 && lvl > 0) html += `  <span class="dim">+${alerts.length - 1}</span>`;
  $('visor').className = 'l' + lvl;
  const vk = html.replace(/[\d.,]+/g, '#');                 // ignore changing numbers: decode only on a new message
  if (vk !== renderVisor.key){ renderVisor.key = vk; decode($('visorText'), html); }
  else if (html !== renderVisor.last){ const el = $('visorText'); el._dec = (el._dec || 0) + 1; el.innerHTML = html; }
  renderVisor.last = html;
  const b = $('visorBtn'); b.hidden = !btn; if (btn){ b.textContent = btn.label; b.dataset.id = btn.id; }
  $('vignette').classList.toggle('on', lvl >= 2);
}

/* ---------------- left column ---------------- */
const shortStatus = u => u.status.replace(/^En route · /, '→ ').replace('Standby at staging', 'standby');
function renderRoster(){
  $('roster').innerHTML = units.map(u => `
    <div class="u l${u.level} ${UI.sel && UI.sel.type === 'unit' && UI.sel.u === u ? 'sel' : ''}" data-act="sel-unit" data-id="${u.id}">
      <i class="bar"></i><span class="id">${u.id}</span><span class="st">${shortStatus(u)}</span><span class="v">${Math.round(u.sens.T)}°</span>
    </div>`).join('');
}
function renderSite(){
  let h = '';
  for (const f of fires){
    h += `<div class="kv"><span class="k">${f.name}</span><span class="v ${f.out ? 'ok' : 'bad'}">${f.out ? 'out' : (f.Q / 1000).toFixed(0) + ' MW'}</span></div>
      <div class="meter"><i style="width:${f.out ? 0 : Math.round(f.I * 100)}%"></i></div>`;
  }
  if (!W1.burning){ const pct = Math.round(W1.dose / W1.doseMax * 100); h += `<div class="kv"><span class="k">W-1 ignition risk</span><span class="v ${pct > 60 ? 'bad' : pct > 20 ? 'warn' : ''}">${pct}%</span></div><div class="meter"><i style="width:${pct}%;background:var(--warn)"></i></div>`; }
  h += `<div class="kv"><span class="k">Red cells</span><span class="v ${S.redCells ? 'bad' : ''}">${S.redCells || 0}</span></div>`;
  const missing = Object.values(BUILDINGS).reduce((a, b) => a + Math.max(0, b.missing - b.persons.filter(p => p.rescued).length), 0);
  h += `<div class="kv"><span class="k">People missing</span><span class="v big ${missing ? 'bad' : 'ok'}">${missing}</span></div>`;
  $('site').innerHTML = h;
}
function bState(b){
  const found = b.persons.filter(p => p.found && !p.rescued).length, saved = b.persons.filter(p => p.rescued).length;
  const scanning = tasks.find(t => t.kind === 'scan' && t.building === b.id && !['done', 'cancelled'].includes(t.status));
  const rescuing = tasks.find(t => t.kind === 'rescue' && t.plan.b === b.id && !['done', 'cancelled'].includes(t.status));
  return { found, saved, scanning, rescuing, missing:Math.max(0, b.missing - saved) };
}
function renderBuildings(){
  $('blds').innerHTML = Object.values(BUILDINGS).map(b => {
    const st = bState(b);
    const tags = [];
    if (b.asset.burning) tags.push('<span class="tag solid">fire</span>');
    if (st.missing) tags.push(`<span class="tag bad">${st.missing} missing</span>`);
    if (st.found) tags.push(`<span class="tag warn">${st.found} located</span>`);
    if (st.saved) tags.push(`<span class="tag ok">${st.saved} saved</span>`);
    const inside = S.view === b.id;
    return `<div class="b"><div class="top"><span class="name">${b.name}</span><span>${tags.join(' ')}</span></div>
      <div class="acts">
        <button class="btn" data-act="scan" data-id="${b.id}" ${st.scanning ? 'disabled' : ''}>${st.scanning ? 'Scanning…' : 'Scan'}</button>
        <button class="btn" data-act="${inside ? 'outside' : 'inside'}" data-id="${b.id}">${inside ? 'Outside' : 'Inside'}</button>
        <button class="btn ${st.found ? 'primary' : ''}" data-act="plan" data-id="${b.id}" ${st.rescuing ? 'disabled' : ''}>${st.rescuing ? 'Rescue on' : 'Plan entry'}</button>
      </div></div>`;
  }).join('');
}

/* ---------------- right: context card ---------------- */
function reading(k, v, unit, cls = ''){ return `<div class="${cls}"><div class="k">${k}</div><div class="v">${v}<small>${unit}</small></div></div>`; }
function spark(hist, lim){
  if (hist.length < 2) return '';
  const maxT = Math.max(100, ...hist.map(h => h.T));
  const pts = hist.map((h, i) => `${(i / (hist.length - 1) * 100).toFixed(1)},${(32 - (h.T - 20) / (maxT - 20) * 30).toFixed(1)}`).join(' ');
  const ly = (32 - (lim - 20) / (maxT - 20) * 30).toFixed(1);
  return `<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"><line x1="0" x2="100" y1="${ly}" y2="${ly}" stroke="#ff3b30" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/><polyline points="${pts}" fill="none" stroke="#ff5a1f" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}
function unitCard(u){
  const s = u.sens, tl = u.isDrone ? DRONE_T : LIM.T.v;
  const c = (v, arr) => LV[lvlOf(v, arr)] === 'ok' ? '' : LV[lvlOf(v, arr)];
  const pend = tasks.filter(t => ['queued', 'withdrawn', 'blocked'].includes(t.status) && t.kind !== 'move' && (u.isDrone ? DRONE_KINDS.includes(t.kind) && t.kind !== 'scan' : !DRONE_KINDS.includes(t.kind) && t.kind !== 'rescue'));
  return `<h3><em>—</em>Unit<button class="x" data-act="close">×</button></h3>
    <div class="card-title">${u.name}</div><div class="card-sub">${u.status}</div>
    <div class="readings">
      ${reading('Air', Math.round(s.T), '°C', c(s.T, tl))}${reading('Heat flux', s.q.toFixed(1), 'kW/m²', c(s.q, LIM.q.v))}
      ${reading('CO', Math.round(s.co), 'ppm', u.isDrone ? '' : c(s.co, LIM.co.v))}${reading('Visibility', s.vis >= 1000 ? '>1k' : s.vis < 10 ? s.vis.toFixed(1) : Math.round(s.vis), 'm')}
    </div>
    ${spark(u.hist, tl[1])}
    <div class="acts">
      <button class="btn" data-act="move" data-id="${u.id}">Move</button>
      <button class="btn danger" data-act="pull" data-id="${u.id}">Pull back</button>
      ${u.indoor ? Object.values(BUILDINGS).map(b => `<button class="btn" data-act="scan" data-id="${b.id}">Scan ${b.short}</button>`).join('') : ''}
      ${pend.slice(0, 3).map(t => `<button class="btn ghost" data-act="assign" data-id="${u.id}" data-task="${t.id}">${t.title}</button>`).join('')}
    </div>`;
}
function cellCard(c){
  const items = [];
  if (c.burning) items.push('Active fire in this cell');
  for (const k of ['q', 'T', 'co']){ const L = LIM[k], lv = lvlOf(c[k], L.v); if (lv) items.push(`${L.label} ${fmt[k](c[k])} &gt; ${L.v[lv - 1]} ${L.unit}`); }
  const f = fires.filter(f => f.active).sort((a, b) => Math.hypot(a.x - c.cx, a.z - c.cz) - Math.hypot(b.x - c.cx, b.z - c.cz))[0];
  let cause = '';
  if (f){ const dx = c.cx - f.x, dz = c.cz - f.z, d = Math.hypot(dx, dz), cs = d > 0.1 ? (dx * WV.x + dz * WV.z) / d : 0;
    cause = `${Math.round(d)} m ${cs > 0.5 ? 'downwind' : cs < -0.5 ? 'upwind' : 'crosswind'} of ${f.name}`; }
  const lvTag = ['ok', 'warn', 'bad', 'solid'][c.level];
  return `<h3><em>—</em>Cell<button class="x" data-act="close">×</button></h3>
    <div style="display:flex;justify-content:space-between;align-items:baseline"><div class="card-title mono">${c.name}</div><span class="tag ${lvTag}">${LVL_NAME[c.level]}</span></div>
    <div class="card-sub">${cause || 'no active fire nearby'}${c.assets.length ? ' · ' + c.assets.map(a => a.short || a.name).join(', ') : ''}</div>
    <div class="readings">
      ${reading('Temp (fused)', `${Math.round(c.Tf)}<small>±${c.Tsd.toFixed(0)}</small>`, '°C', LV[lvlOf(c.Tf, LIM.T.v)])}
      ${reading('Fire prob.', Math.round(c.fireP * 100), '%', c.fireP > 0.8 ? 'bad' : c.fireP > 0.5 ? 'warn' : '')}
      ${reading('Heat flux', c.q.toFixed(1), 'kW/m²', LV[lvlOf(c.q, LIM.q.v)])}
      ${reading('CO', Math.round(c.co), 'ppm', LV[lvlOf(c.co, LIM.co.v)])}
    </div>
    ${items.length ? `<ul class="why">${items.map(i => `<li>${i}</li>`).join('')}</ul>` : ''}
    <div class="src">fused: ${c.src.join(' + ')}</div>`;
}
function buildingCard(b){
  const st = bState(b);
  return `<h3><em>—</em>Building<button class="x" data-act="close">×</button></h3>
    <div class="card-title">${b.name}</div><div class="card-sub">${b.asset.desc}${b.asset.burning ? ' · burning' : ''}</div>
    ${b.rooms.map((r, i) => { const v = roomReadings(b.state.s[i], b.state.T[i]); const np = b.persons.filter(p => p.room === r.id && p.found && !p.rescued).length;
      return `<div class="kv"><span class="k">${r.name}${np ? ` · <b style="color:var(--warn)">${np} person${np > 1 ? 's' : ''}</b>` : ''}</span><span class="v ${r.scanned ? (v.T > 60 || v.s > 0.6 ? 'bad' : '') : ''}">${r.scanned ? `${Math.round(v.T)}° · ${v.vis >= 30 ? 'clear' : v.vis.toFixed(1) + ' m'}` : '—'}</span></div>`; }).join('')}
    <div class="acts">
      <button class="btn" data-act="scan" data-id="${b.id}" ${st.scanning ? 'disabled' : ''}>Scan with D3</button>
      <button class="btn" data-act="inside" data-id="${b.id}">Go inside</button>
      <button class="btn ${st.found ? 'primary' : ''}" data-act="plan" data-id="${b.id}">Plan entry</button>
    </div>`;
}
function roomCard(b, r){
  const i = b.idx[r.id], v = roomReadings(b.state.s[i], b.state.T[i]);
  const ps = b.persons.filter(p => p.room === r.id && p.found && !p.rescued);
  return `<h3><em>—</em>${b.short} · room<button class="x" data-act="close">×</button></h3>
    <div class="card-title">${r.name}</div><div class="card-sub">${r.scanned ? `scanned T+${tplus(r.scanT || 0)}` : 'not scanned yet'}</div>
    ${r.scanned ? `<div class="readings">
      ${reading('Air', Math.round(v.T), '°C', LV[lvlOf(v.T, LIM.T.v)])}${reading('Visibility', v.vis >= 30 ? '>30' : v.vis.toFixed(1), 'm', v.vis < 3 ? 'bad' : '')}
      ${reading('CO', Math.round(v.co), 'ppm', LV[lvlOf(v.co, LIM.co.v)])}${reading('Persons', ps.length, '', ps.length ? 'warn' : '')}
    </div>` : ''}
    ${ps.map(p => `<div class="kv"><span class="k">Casualty · p=${p.prob.toFixed(2)}</span><span class="v ${p.fed >= 0.3 ? 'bad' : 'warn'}">dose ${p.fed.toFixed(2)}</span></div>`).join('')}
    <div class="src">dose = ISO 13571 fractional effective dose (1.0 = incapacitation)</div>`;
}
function plansCard(){
  const b = P.b;
  if (P.busy) return `<h3><em>—</em>Entry plans</h3><div class="card-title">${b.short}</div><div class="card-sub">forecasting smoke spread…</div>`;
  const p0 = P.plans[0];
  return `<h3><em>—</em>Entry plans<button class="x" data-act="plans-close">×</button></h3>
    <div class="card-title">${b.name}</div>
    <div class="card-sub mono">forecast ${p0 ? p0.fc.src : ''} · ${p0 ? p0.fc.ms + ' ms' : ''} · crew ${p0 ? p0.crew : ''}</div>
    ${P.plans.map((p, k) => `<div class="plan ${k === P.sel ? 'sel' : ''}" data-act="plan-sel" data-k="${k}">
      <span class="lt">${p.id}</span><span class="nm">${p.door.name}</span><span class="tag ${p.verdict === 'GO' ? 'ok' : p.verdict === 'CAUTION' ? 'warn' : 'bad'}">${p.verdict}</span>
      <span class="meta">${tplus(p.end)} · max ${Math.round(p.maxT)}° · vis ${p.minVis >= 30 ? '>30' : p.minVis.toFixed(1)} m · air ${Math.round(p.airPct * 100)}%${p.kind === 'rescue' ? ` · casualty dose ${p.vMax.toFixed(2)}` : ''}${p.notes.length ? '<br>' + p.notes.join(' · ') : ''}</span>
    </div>`).join('')}
    <div class="acts"><button class="btn primary" data-act="commit">Commit plan ${P.plans[P.sel] ? P.plans[P.sel].id : ''}</button><button class="btn ghost" data-act="plans-close">Cancel</button></div>`;
}
function suggestions(){
  const out = [];
  for (const b of Object.values(BUILDINGS)){
    const st = bState(b);
    if (st.missing && !b.scanned && !st.scanning) out.push({ text:`Scan ${b.short} · ${st.missing} missing`, act:'scan', id:b.id, hot:true });
    if (st.found && !st.rescuing) out.push({ text:`Plan rescue · ${b.short}`, act:'plan', id:b.id, hot:true });
  }
  for (const t of tasks.filter(t => ['queued', 'withdrawn', 'blocked'].includes(t.status) && !t.adhoc).slice(0, 5))
    out.push({ text:t.title, act:'dispatch', id:t.id, unit:t.unit, label:t.status === 'withdrawn' ? 'Resume' : t.unit });
  return out;
}
let cardKey = '';
function renderCard(force){
  let html, key;
  const sel = UI.sel;
  if (P.open){ key = 'plans' + P.sel + P.busy + P.plans.length; html = plansCard(); }
  else if (sel && sel.type === 'unit'){ key = null; html = unitCard(sel.u); }
  else if (sel && sel.type === 'cell'){ key = null; html = cellCard(cells[sel.i]); }
  else if (sel && sel.type === 'building'){ key = null; html = buildingCard(BUILDINGS[sel.id]); }
  else if (sel && sel.type === 'room'){ const b = BUILDINGS[sel.b]; key = null; html = roomCard(b, b.rooms[b.idx[sel.r]]); }
  else {
    const sg = suggestions();
    html = `<h3><em>—</em>Next actions</h3><div class="pending">${sg.length ? sg.map(s => `<div class="row"><span>${s.text}</span><button class="btn ${s.hot ? 'primary' : ''}" data-act="${s.act}" data-id="${s.id}">${s.label || (s.act === 'scan' ? 'Scan' : 'Plan')}</button></div>`).join('') : '<div class="card-sub">Nothing pending.</div>'}</div>`;
  }
  if (force || key === null || key !== cardKey){
    cardKey = key; $('card').innerHTML = html;
    const t = $('card').querySelector('.card-title');
    if (t && t.textContent !== renderCard.title){ renderCard.title = t.textContent; decode(t, t.innerHTML); }
  }
}
let logN = -1;
function renderLog(){
  if (S.logs.length === logN && S.logs[0] === renderLog.top) return;
  logN = S.logs.length; renderLog.top = S.logs[0];
  $('log').innerHTML = S.logs.slice(0, 30).map(l => `<div><span class="t">${tplus(l.t)}</span><span class="${l.cls}">${l.text}</span></div>`).join('');
}

/* ---------------- timeline (plan preview) ---------------- */
function renderTimeline(){
  const tl = $('timeline');
  const on = P.open && P.plans.length > 0 && !P.busy;
  tl.hidden = !on; $('cam').style.display = on ? 'none' : '';
  if (!on) return;
  const p = P.plans[P.sel];
  const pct = t => `${(t / p.end * 100).toFixed(2)}%`;
  $('tlFill').style.width = pct(P.tau); $('tlHead').style.left = pct(P.tau);
  $('tlNow').textContent = '+' + tplus(P.tau); $('tlEnd').textContent = tplus(p.end);
  $('tlLbl').textContent = P.playing ? 'pause' : 'play';
  const key = P.sel + ':' + P.plans.length;
  if ($('tlTicks').dataset.k !== key){
    $('tlTicks').dataset.k = key;
    const ev = [{ t:0, label:'Dispatch', cls:'app' }, ...p.ev];
    $('tlTicks').innerHTML = ev.filter((e, i, a) => i === 0 || e.t - a[i - 1].t > p.end * 0.1).map(e => `<span class="${e.cls || ''}" style="left:${pct(e.t)}">${e.label}</span>`).join('');
    $('tlPlans').innerHTML = P.plans.map((q, k) => `<button class="${q.verdict} ${k === P.sel ? 'on' : ''}" data-act="plan-sel" data-k="${k}" title="${q.door.name}: ${q.verdict}">${q.id}</button>`).join('');
  }
}
{
  const track = $('tlTrack'); let drag = false;
  const seek = e => { const r = track.getBoundingClientRect(); const p = P.plans[P.sel]; if (p){ P.playing = false; setTau((e.clientX - r.left) / r.width * p.end); } };
  track.addEventListener('pointerdown', e => { drag = true; track.setPointerCapture(e.pointerId); seek(e); });
  track.addEventListener('pointermove', e => { if (drag) seek(e); });
  track.addEventListener('pointerup', () => { drag = false; });
}

/* ---------------- D1 camera feed with live YOLO ---------------- */
const cam = { frames:[], i:0, busy:false, last:0, img:new Image(), ok:null };
fetch('assets/feed/index.json').then(r => r.ok ? r.json() : []).then(f => { cam.frames = f; }).catch(() => {});
async function camTick(){
  const d1 = unitById('D1');
  const on = d1.task && d1.task.kind === 'recon' && d1.mode === 'working' && cam.frames.length && primaryFire();
  $('cam').hidden = !on; if (!on || cam.busy || performance.now() - cam.last < 2600) return;
  cam.busy = true; cam.last = performance.now();
  const name = cam.frames[cam.i++ % cam.frames.length];
  try {
    const blob = await (await fetch(`assets/feed/${name}`)).blob();
    const bmp = await createImageBitmap(blob);
    const cv = $('camCanvas'), g = cv.getContext('2d');
    // letterbox every frame into the fixed 16:10 panel
    const sc = Math.min(cv.width / bmp.width, cv.height / bmp.height), dw = bmp.width * sc, dh = bmp.height * sc, ox = (cv.width - dw) / 2, oy = (cv.height - dh) / 2;
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bmp, ox, oy, dw, dh);
    const fd = new FormData(); fd.append('image', blob, name);
    const r = await fetch('/api/detect', { method:'POST', body:fd, signal:AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('detect');
    const j = await r.json();
    let fire = 0, smoke = 0;
    g.lineWidth = 2; g.font = '600 11px IBM Plex Mono, monospace';
    for (const b of j.boxes){
      const [x0, y0, x1, y1] = b.xyxyn.map((v, k) => k % 2 ? oy + v * dh : ox + v * dw);
      const col = b.cls === 'fire' ? '#ff5a1f' : '#cfd3da';
      g.strokeStyle = col; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.fillStyle = col; const lab = `${b.cls} ${b.conf.toFixed(2)}`; g.fillRect(x0, y0 - 14, g.measureText(lab).width + 6, 14);
      g.fillStyle = '#0b0c0e'; g.fillText(lab, x0 + 3, y0 - 3);
      if (b.cls === 'fire') fire = Math.max(fire, b.conf); else smoke = Math.max(smoke, b.conf);
    }
    emitEv('yolo', { fire, smoke });
    $('camMeta').textContent = `YOLO11n · ${j.ms} ms · ${j.boxes.length} det`;
  } catch { $('camMeta').textContent = 'YOLO offline'; }
  cam.busy = false;
}

/* ---------------- voice widget ---------------- */
function renderVoice(){
  const p = $('ptt'); p.className = V.state + (V.speaking ? ' speaking' : '');
  const b = $('bubble');
  if (V.last && (V.last.heard || V.last.error)){
    b.hidden = false;
    b.querySelector('.heard').textContent = V.last.error || `“${V.last.heard}”`;
    b.querySelector('.reply').textContent = V.state === 'thinking' ? '…' : (V.last.reply || '');
  }
}
onEv('voice', renderVoice);
onEv('speaking', t => { V.speaking = !!t; renderVoice(); });
const ptt = $('ptt');
ptt.addEventListener('pointerdown', e => { e.preventDefault(); startTalk(); });
ptt.addEventListener('pointerup', () => stopTalk());
ptt.addEventListener('pointerleave', () => { if (V.state === 'listening') stopTalk(); });
$('typeForm').addEventListener('submit', e => { e.preventDefault(); const v = $('typeInput').value; $('typeInput').value = ''; handle(v, 'text'); });

/* ---------------- picking ---------------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down) return; const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null; if (moved > 6) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (!UI.moveFor){ const h = ray.intersectObjects(unitHits, false); if (h.length){ select({ type:'unit', u:h[0].object.userData.unit }); return; } }
  const p = new THREE.Vector3();
  if (!ray.ray.intersectPlane(ground, p) || Math.abs(p.x) > HALF || Math.abs(p.z) > HALF) return;
  if (UI.moveFor){ moveUnit(UI.moveFor, p.x, p.z); setMove(null); return; }
  const b = buildingAt(p.x, p.z);
  if (S.view && b && b.id === S.view){ const rm = roomAt(b, p.x, p.z); if (rm){ select({ type:'room', b:b.id, r:rm.id }); return; } }
  // buildings: test against the visible boxes first (clicks on walls/roofs)
  if (!S.view){
    const metas = Object.values(BUILDINGS).map(b => b.asset.mesh);
    const hb = ray.intersectObjects(metas, false)[0];
    if (hb){ const bb = Object.values(BUILDINGS).find(b => b.asset.mesh === hb.object); select({ type:'building', id:bb.id }); return; }
  }
  const [c, rr] = cellOf(p.x, p.z);
  select({ type:'cell', i:rr * CELLS + c });
});
export function select(s){
  UI.sel = s;
  if (s && s.type === 'cell'){ const c = cells[s.i]; overlayMat.uniforms.uSel.value.set(c.c, c.r); S.gridTarget = 1; }
  else S.gridTarget = 0;          // the grid fades out; keep the last cell so the fade happens in place
  renderCard(true); renderRoster();
}
onEv('select-unit', u => select({ type:'unit', u }));
function setMove(u){ UI.moveFor = u; const h = $('hint'); h.textContent = u ? `Tap the map to send ${u.id} · Esc cancels` : ''; h.classList.toggle('on', !!u); }

/* ---------------- actions ---------------- */
function act(el){
  const a = el.dataset.act, id = el.dataset.id;
  switch (a){
    case 'play': sim.paused = !sim.paused; break;
    case 'speed': sim.speed = +el.dataset.v; break;
    case 'wind': sim.windFrom = (sim.windFrom + 45) % 360; updateWind(); break;
    case 'settings': $('settings').hidden = !$('settings').hidden; break;
    case 'reset': location.reload(); break;
    case 'visor': case 'pull': { const u = unitById(id); if (u) pullBack(u); break; }
    case 'sel-unit': select({ type:'unit', u:unitById(id) }); break;
    case 'close': select(null); break;
    case 'move': setMove(unitById(id)); break;
    case 'assign': { const t = tasks.find(t => t.id === el.dataset.task), u = unitById(id); if (t && u) assignTask(t, u); break; }
    case 'dispatch': { const t = tasks.find(t => t.id === id), u = t && unitById(t.unit); if (u) assignTask(t, u); break; }
    case 'scan': if (!startScan(unitById('D3'), id)) say('No open door for the scout drone.'); break;
    case 'inside': enterBuilding(id); select({ type:'building', id }); break;
    case 'outside': if (P.open) closePlans(); exitBuilding(); select(null); break;
    case 'plan': makePlans(id); break;
    case 'plan-sel': selectPlan(+el.dataset.k); break;
    case 'plans-close': closePlans(); break;
    case 'commit': commitPlan(); break;
    case 'tl-play': { const p = P.plans[P.sel]; if (p){ if (P.tau >= p.end) P.tau = 0; P.playing = !P.playing; } break; }
    case 'log': $('log').hidden = !$('log').hidden; $('logState').textContent = $('log').hidden ? '[+]' : '[−]'; break;
    case 'sound': $('soundBtn').textContent = `sound: ${toggleSound() ? 'on' : 'off'}`; break;
    case 'type': $('typeForm').hidden = !$('typeForm').hidden; if (!$('typeForm').hidden) $('typeInput').focus(); break;
  }
  renderAll(true);
}
document.addEventListener('pointerdown', e => { const el = e.target.closest('[data-act]'); if (el && e.button === 0 && !el.disabled){ e.preventDefault(); act(el); } });
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'v' || e.key === 'V'){ if (!e.repeat) startTalk(); e.preventDefault(); return; }
  if (e.key === 'Escape'){ if (UI.moveFor) setMove(null); else if (P.open) closePlans(); else if (S.view) exitBuilding(); else select(null); renderAll(true); }
  if (e.key === ' '){ e.preventDefault(); if (P.open && P.plans.length) act({ dataset:{ act:'tl-play' } }); else sim.paused = !sim.paused; }
  if (P.open && P.plans.length && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')){ P.playing = false; setTau(P.tau + (e.key === 'ArrowRight' ? 5 : -5)); }
  if (['1', '2', '3'].includes(e.key)) sim.speed = [1, 5, 20][+e.key - 1];
});
document.addEventListener('keyup', e => { if (e.key === 'v' || e.key === 'V') stopTalk(); });
$('growth').addEventListener('input', e => { sim.growth = +e.target.value; $('growthV').textContent = sim.growth.toFixed(1) + '×'; });
$('windSpd').addEventListener('input', e => { sim.windSpeed = +e.target.value; $('windSpdV').textContent = sim.windSpeed + ' m/s'; });
$('autoW').addEventListener('change', e => { sim.autoWithdraw = e.target.checked; });

/* ---------------- real data: live wind at the Gabès industrial zone (Open-Meteo, no key) ---------------- */
const SITE = { lat:33.93, lon:10.07, name:'Gabès' };
async function liveWind(){
  if (!$('liveWind').checked) return;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${SITE.lat}&longitude=${SITE.lon}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`, { signal:AbortSignal.timeout(6000) });
    const c = (await r.json()).current;
    sim.windSpeed = Math.round(c.wind_speed_10m * 2) / 2; sim.windFrom = Math.round(c.wind_direction_10m); updateWind();
    $('windSpd').value = sim.windSpeed; $('windSpdV').textContent = sim.windSpeed + ' m/s';
    addLog(`Live wind ${SITE.name}: ${sim.windSpeed} m/s from ${compass(sim.windFrom)} (${sim.windFrom}°)`, 'ok');
  } catch { addLog('Live wind unavailable, using manual wind', 'l1'); }
}
liveWind(); setInterval(liveWind, 10 * 60 * 1000);
$('liveWind').addEventListener('change', liveWind);
$('voiceAlerts').addEventListener('change', e => { V.alerts = e.target.checked; });
onEv('plans', () => renderAll(true));
onEv('view', () => renderAll(true));
onEv('scan-done', ({ building }) => { if (!P.open) select({ type:'building', id:building }); });

export function renderAll(force){
  renderTop(); renderVisor(); renderRoster(); renderSite(); renderBuildings(); renderCard(force); renderLog(); renderTimeline();
}
export function uiTick(){ renderAll(false); camTick(); }
export function uiFast(){ renderTimeline(); }
