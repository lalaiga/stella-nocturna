// Entry / rescue planner with forecast + time-scrub preview.
// For each exterior door it builds a route to the casualties, forecasts the building with the GNN
// (or the zone model as fallback), simulates a two-firefighter team through that forecast and grades it.
import {
  THREE, S, scene, sim, units, unitById, tasks, newTaskId, assignTask, findPath, addLog, emitEv, onEv,
  sample, clamp, tplus,
} from './core.js';
import {
  BUILDINGS, extDoors, doorNormal, roomPath, roomAt, zoneGraph, sOutside, fireQ, zoneStep, roomReadings, fedRate, figure,
  enterBuilding,
} from './interior.js';
import { setLying } from './human.js';

const STEP = 5, HORIZON = 900, ALPHA = 0.0469;
const AIR_L = 2040;                 // 6.8 L cylinder at 300 bar
const CREW_PREF = { W1:['E1', 'E2', 'R1'], A1:['R1', 'E1', 'E2'] };
export const P = { b:null, plans:[], sel:0, tau:0, playing:false, open:false, forecast:null, busy:false };

/* ---------------- forecast ---------------- */
function qSchedule(b, n){
  const steps = HORIZON / STEP, out = [];
  const q0 = b.rooms.map(r => r.id === b.fireRoom ? fireQ(b) : 0);
  for (let k = 0; k <= steps; k++){
    out.push(q0.map((q, i) => {
      if (q <= 0) return 0;
      const t0 = Math.sqrt(q / ALPHA);                      // t-squared growth continues from today's HRR
      return Math.min(b.Qmax, ALPHA * (t0 + k * STEP) ** 2);
    }));
  }
  return out;
}
async function forecast(b, openDoor){
  const g = zoneGraph(b);
  if (openDoor){ g.ext = g.ext.slice(); g.ext[b.idx[openDoor.a]] += Math.max(openDoor.area, 2); }   // crews open the entry door
  const s_out = sOutside(b), Q = qSchedule(b);
  const body = { V:g.V, edges:g.edges, ext:g.ext, s_out, s:[...b.state.s], T:[...b.state.T], Q };
  const t0 = performance.now();
  try {
    const r = await fetch('/api/spread', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body), signal:AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    return { s:j.s, T:j.T, src:'GNN', ms:Math.round(performance.now() - t0) };
  } catch {
    const s = [...b.state.s], T = [...b.state.T], S_ = [s.slice()], T_ = [T.slice()];
    for (let k = 0; k < Q.length - 1; k++){ for (let j = 0; j < STEP; j++) zoneStep(s, T, Q[k], g, s_out, 1); S_.push(s.slice()); T_.push(T.slice()); }
    return { s:S_, T:T_, src:'zone model', ms:Math.round(performance.now() - t0) };
  }
}
function fcAt(fc, i, t){
  const k = clamp(t / STEP, 0, fc.s.length - 1), a = Math.floor(k), c = Math.min(a + 1, fc.s.length - 1), f = k - a;
  return { s:fc.s[a][i] * (1 - f) + fc.s[c][i] * f, T:fc.T[a][i] * (1 - f) + fc.T[c][i] * f };
}
function fcFrame(fc, t){
  const k = clamp(Math.round(t / STEP), 0, fc.s.length - 1);
  return { s:fc.s[k], T:fc.T[k] };
}

/* ---------------- routes ---------------- */
function targets(b){
  const found = b.persons.filter(p => p.found && !p.rescued);
  if (found.length) return { kind:'rescue', persons:found, rooms:[...new Set(found.map(p => p.room))] };
  const unknown = b.rooms.filter(r => !r.scanned).map(r => r.id);
  return { kind:'search', persons:[], rooms:unknown.length ? unknown : b.rooms.map(r => r.id) };
}
function buildRoute(b, door, tg){
  const n = doorNormal(b, door);
  const out = { x:door.x + n.x * 7, z:door.z + n.z * 7 };
  const step = { x:door.x + n.x * 1.2, z:door.z + n.z * 1.2 };
  const wp = [{ ...out }, { ...step, act:door.jammed ? 'force' : 'open', dur:door.jammed ? 60 : (door.area > 0 || door.open) ? 2 : 10, door }, { x:door.x, z:door.z, act:'enter', door }];
  let cur = door.a;
  const remaining = [...tg.rooms];
  while (remaining.length){
    remaining.sort((a, c) => (roomPath(b, cur, a) || []).length - (roomPath(b, cur, c) || []).length);
    const id = remaining.shift();
    for (const h of roomPath(b, cur, id) || []) wp.push({ x:h.door.x, z:h.door.z });
    const r = b.rooms[b.idx[id]];
    const ps = tg.persons.filter(p => p.room === id);
    if (ps.length) for (const p of ps) wp.push({ x:p.x, z:p.z, act:'pickup', dur:20, person:p });
    else wp.push({ x:r.cx, z:r.cz, act:'search', dur:15 });
    cur = id;
  }
  for (const h of roomPath(b, cur, door.a) || []) wp.push({ x:h.door.x, z:h.door.z });
  wp.push({ x:door.x, z:door.z, act:'exit' }, { ...step }, { ...out, act:'out' });
  return { wp, out, door };
}
const speedIn = (s, carry) => (s < 0.3 ? 1.0 : s < 0.7 ? 0.6 : 0.35) * (carry ? 0.5 : 1);

/* simulate a crew along a route; env(t, x, z) -> {s, T} or null outside */
function walk(b, route, env, t0){
  const kf = [], ev = [];
  let t = t0, x = route.wp[0].x, z = route.wp[0].z, i = 1, dwell = 0, carry = 0, air = AIR_L;
  let maxT = 20, minVis = 50, maxQ = 0;
  const vf = {};
  for (const p of route.wp.filter(w => w.person)) vf[p.person.id] = p.person.fed;
  ev.push({ t, label:'Crew at door' });
  let guard = 0;
  while (i < route.wp.length && guard++ < 20000){
    const w = route.wp[i];
    const room = roomAt(b, x, z);
    const e = room ? env(t, b.idx[room.id]) : null;
    const rr = e ? roomReadings(e.s, e.T) : null;
    if (rr){ maxT = Math.max(maxT, rr.T); minVis = Math.min(minVis, rr.vis); maxQ = Math.max(maxQ, rr.q); }
    const dt = 0.5;
    const dx = w.x - x, dz = w.z - z, d = Math.hypot(dx, dz);
    const v = speedIn(e ? e.s : 0, carry) * (room ? 1 : 1.4);
    const work = dwell > 0 || carry ? 70 : 40;                  // L/min
    air -= work * dt / 60;
    // casualties keep breathing whatever room they are in
    for (const w2 of route.wp){
      if (!w2.person) continue; const p = w2.person;
      const pr = w2.picked ? room : b.rooms[b.idx[p.room]];
      if (w2.out) continue;
      const pe = pr ? env(t, b.idx[pr.id]) : null;
      if (pe) vf[p.id] += fedRate(roomReadings(pe.s, pe.T)) * dt / 60;
    }
    if (d > 0.05){ const s = Math.min(d, v * dt); x += dx / d * s; z += dz / d * s; }
    else if (w.dur && dwell < w.dur){ dwell += dt; }
    else {
      if (w.act === 'pickup'){ carry++; w.picked = true; ev.push({ t, label:'Casualty reached' }); }
      if (w.act === 'enter') ev.push({ t, label:'Entry' });
      if (w.act === 'search') ev.push({ t, label:'Room searched' });
      if (w.act === 'out'){ for (const w2 of route.wp) if (w2.person) w2.out = true; ev.push({ t, label:carry ? 'Casualties out' : 'Crew out' }); }
      dwell = 0; i++;
    }
    kf.push({ t, x, z, carry });
    t += dt;
  }
  for (const w of route.wp){ delete w.picked; delete w.out; }
  return { kf, ev, end:t, maxT, minVis, maxQ, airPct:Math.max(0, air / AIR_L), victimFed:vf };
}

function grade(r){
  const vMax = Math.max(0, ...Object.values(r.victimFed));
  const notes = [];
  let verdict = 'GO';
  if (r.maxT >= 250 || r.maxQ >= 10 || r.airPct < 0.15){ verdict = 'NO-GO'; }
  else if (r.maxT >= 120 || r.minVis < 1 || r.airPct < 0.35 || vMax >= 0.5){ verdict = 'CAUTION'; }
  if (r.maxQ >= 10) notes.push(`${r.maxQ.toFixed(0)} kW/m² on route`);
  if (r.maxT >= 120) notes.push(`${Math.round(r.maxT)}° on route`);
  if (vMax >= 0.5) notes.push('casualty at risk');
  if (r.airPct < 0.35) notes.push('low air');
  return { verdict, vMax, notes };
}

/* ---------------- make plans ---------------- */
export async function makePlans(bId){
  const b = BUILDINGS[bId]; if (!b || P.busy) return;
  P.busy = true; P.b = b; P.open = true; emitEv('plans', P);
  const tg = targets(b);
  const crew = (CREW_PREF[bId] || []).map(unitById).find(u => u && !(u.task && u.task.kind === 'rescue' && u.task.status !== 'done')) || unitById('E1');
  const plans = [];
  const letters = 'ABCD';
  const doors = extDoors(b);
  for (const door of doors){
    const fc = await forecast(b, door);
    const route = buildRoute(b, door, tg);
    const path = findPath(crew.pos.x, crew.pos.z, route.out.x, route.out.z, false);
    const len = path ? path.reduce((acc, p, k) => acc + Math.hypot(p.x - (k ? path[k - 1].x : crew.pos.x), p.z - (k ? path[k - 1].z : crew.pos.z)), 0) : Infinity;
    const reach = isFinite(len);
    const approach = (reach ? len : Math.hypot(route.out.x - crew.pos.x, route.out.z - crew.pos.z) * 1.4) / crew.speed + 20;   // drive + dismount
    const r = walk(b, route, (t, i) => fcAt(fc, i, t), approach);
    const g = grade(r);
    if (!reach){ g.verdict = 'NO-GO'; g.notes.unshift('approach through hazard zone'); }
    if (door.jammed) g.notes.unshift('force door ~60 s');
    plans.push({ id:letters[plans.length], b:bId, door, route, fc, crew:crew.id, approach, kind:tg.kind, ...r, ...g });
  }
  const rank = p => (p.verdict === 'GO' ? 0 : p.verdict === 'CAUTION' ? 1e4 : 1e6) + p.end;
  plans.sort((a, c) => rank(a) - rank(c));
  plans.forEach((p, k) => { p.id = letters[k]; });
  P.plans = plans; P.sel = 0; P.tau = 0; P.playing = false; P.busy = false;
  P.wasPaused = sim.paused; sim.paused = true;               // freeze the live sim while planning
  enterBuilding(bId);
  const best = plans[0];
  const say = best ? `${plans.length} entry plans for ${b.short}. Best: ${best.door.name}, ${Math.round(best.end / 60)} minutes, ${best.verdict === 'NO-GO' ? 'no go' : best.verdict.toLowerCase()}.` : `No entry plan possible for ${b.short}.`;
  addLog(`Plans for ${b.short}: ${plans.map(p => `${p.id} ${p.door.name} ${p.verdict}`).join(' · ')}`, '', say);
  emitEv('plans', P);
  return plans;
}
export function closePlans(){
  P.open = false; P.playing = false; P.plans = []; hideGhosts();
  if (P.wasPaused === false) sim.paused = false;
  emitEv('plans', P);
}
export function selectPlan(k){ P.sel = clamp(k, 0, P.plans.length - 1); P.tau = 0; emitEv('plans', P); }

/* ---------------- preview: ghosts + forecast override ---------------- */
const ghosts = [0, 1].map(() => { const f = figure(0xff5a1f); f.visible = false; scene.add(f); return f; });
const carried = [0, 1].map(() => { const f = figure(0xffb020); setLying(f); f.visible = false; scene.add(f); return f; });
const routeLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color:0xff5a1f, dashSize:0.8, gapSize:0.5 }));
routeLine.frustumCulled = false; scene.add(routeLine);
function hideGhosts(){ ghosts.forEach(g => g.visible = false); carried.forEach(g => g.visible = false); routeLine.visible = false; }

function kfAt(kf, t){
  if (!kf.length) return null;
  let lo = 0, hi = kf.length - 1;
  if (t <= kf[0].t) return kf[0]; if (t >= kf[hi].t) return kf[hi];
  while (hi - lo > 1){ const m = (lo + hi) >> 1; if (kf[m].t <= t) lo = m; else hi = m; }
  const a = kf[lo], c = kf[hi], f = (t - a.t) / (c.t - a.t);
  return { t, x:a.x + (c.x - a.x) * f, z:a.z + (c.z - a.z) * f, carry:a.carry };
}
export function previewOverride(){
  if (!P.open || !P.plans.length) return null;
  const p = P.plans[P.sel];
  return { building:p.b, ...fcFrame(p.fc, P.tau) };
}
let lastSel = -1;
export function updatePlanner(dt){
  if (!P.open || !P.plans.length){ if (!live.length) hideGhosts(); return; }
  const p = P.plans[P.sel];
  if (P.playing){ P.tau += dt * 12; if (P.tau >= p.end){ P.tau = p.end; P.playing = false; } }
  if (lastSel !== P.sel){
    lastSel = P.sel;
    const pts = [p.route.wp[0], ...p.route.wp].map(w => new THREE.Vector3(w.x, 0.18, w.z));
    routeLine.geometry.setFromPoints(pts); routeLine.computeLineDistances();
    routeLine.material.color.setHex(p.verdict === 'GO' ? 0x3ddc97 : p.verdict === 'CAUTION' ? 0xffb020 : 0xff3b30);
  }
  routeLine.visible = true;
  // crew drives up during the approach phase, then walks
  const k1 = kfAt(p.kf, Math.max(P.tau, p.approach)), k2 = kfAt(p.kf, Math.max(P.tau - 1.6, p.approach));
  const onFoot = P.tau >= p.approach;
  [k1, k2].forEach((k, j) => {
    const g = ghosts[j]; g.visible = onFoot && !!k;
    if (k){ const prev = kfAt(p.kf, k.t - 0.5) || k; g.position.set(k.x + (j ? 0.5 : 0), 0, k.z + (j ? 0.5 : 0)); g.rotation.y = Math.atan2(k.x - prev.x, k.z - prev.z) || g.rotation.y; }
    const c = carried[j]; c.visible = onFoot && k && k.carry > j; if (c.visible) c.position.set(k.x + (j ? 0.5 : 0) + 0.35, 0.9, k.z + (j ? 0.5 : 0));
  });
}
export function setTau(t){ if (!P.plans.length) return; P.tau = clamp(t, 0, P.plans[P.sel].end); }

/* ---------------- live execution of a committed plan ---------------- */
const live = [];   // { task, unit, plan, crew:[figure, figure], wi, dwell, carry, x, z, air }
export function commitPlan(k = P.sel){
  const plan = P.plans[k]; if (!plan) return;
  const b = BUILDINGS[plan.b], u = unitById(plan.crew);
  const t = { id:newTaskId(), title:`${plan.kind === 'rescue' ? 'Rescue' : 'Search'} ${b.short} via ${plan.door.name}`, kind:'rescue', plan, unit:u.id, status:'queued', progress:0 };
  tasks.push(t); assignTask(t, u);
  addLog(`${u.id} committed to plan ${plan.id}: ${plan.door.name}`, 'l1',
    `${u.name}, ${t.title}. ${plan.kind === 'rescue' ? `${plan.route.wp.filter(w => w.person).length} casualties.` : ''} Estimated ${Math.max(1, Math.round((plan.end) / 60))} minutes.`);
  closePlans();
  sim.paused = false;
}
S.hooks.target.rescue = t => t.plan.route.out;
S.hooks.arrive.rescue = (u, t) => {
  const crew = [figure(0xff5a1f), figure(0xff5a1f)];
  crew.forEach(c => scene.add(c));
  const cv = [figure(0xffb020), figure(0xffb020)]; cv.forEach(c => { setLying(c); c.visible = false; scene.add(c); });
  const w0 = t.plan.route.wp[0];
  live.push({ task:t, unit:u, plan:t.plan, crew, cv, wi:1, dwell:-20, carry:[], x:w0.x, z:w0.z, air:AIR_L });
  u.status = 'Crew dismounting';
};
S.hooks.ground.rescue = (u, t, dt) => {
  const L = live.find(l => l.task === t); if (!L) return;
  const b = BUILDINGS[t.plan.b], wp = t.plan.route.wp;
  if (L.dwell < 0){ L.dwell += dt; return; }                 // dismount / don SCBA
  const w = wp[L.wi]; if (!w) return;
  const room = roomAt(b, L.x, L.z);
  const s = room ? b.state.s[b.idx[room.id]] : 0;
  const v = speedIn(s, L.carry.length) * (room ? 1 : 1.4);
  L.air -= (L.carry.length ? 70 : 40) * dt / 60;
  const dx = w.x - L.x, dz = w.z - L.z, d = Math.hypot(dx, dz);
  if (d > 0.05){ const st = Math.min(d, v * dt); L.x += dx / d * st; L.z += dz / d * st; L.h = Math.atan2(dx, dz); }
  else if (w.dur && (L.wd = (L.wd || 0) + dt) < w.dur){ /* working at this waypoint */ }
  else {
    L.wd = 0;
    if (w.act === 'force' || w.act === 'open'){ w.door.jammed = false; w.door.open = true; }
    if (w.act === 'pickup' && !w.person.rescued){ w.person.carried = true; L.carry.push(w.person); addLog(`${u.id} reached casualty in ${b.short}`, 'l1', `${u.name}, casualty reached.`); }
    if (w.act === 'search'){ const r = roomAt(b, w.x, w.z); if (r){ r.scanned = true; for (const p of b.persons) if (p.room === r.id) { p.found = true; } } }
    if (w.act === 'out'){
      for (const p of L.carry){ p.rescued = true; p.carried = false; }
      const n = L.carry.length;
      addLog(`${u.id}: ${n ? n + ' casualt' + (n > 1 ? 'ies' : 'y') + ' out of ' + b.short : b.short + ' search complete'}`, 'ok',
        n ? `${u.name}. ${n === 1 ? 'One casualty' : n + ' casualties'} out of ${b.short}, handing over to medics.` : `${u.name}. ${b.short} search complete.`);
      t.status = 'done'; t.progress = 1; u.mode = 'idle'; u.status = n ? 'Casualties handed to medics' : 'Search complete';
      L.crew.forEach(c => scene.remove(c)); L.cv.forEach(c => scene.remove(c)); live.splice(live.indexOf(L), 1);
      return;
    }
    L.wi++;
  }
  t.progress = L.wi / wp.length;
  u.status = `Crew ${room ? 'inside ' + room.name : 'outside'} · air ${Math.round(L.air / AIR_L * 100)} %`;
};
export function updateLive(time){
  for (const L of live){
    L.crew.forEach((c, j) => { c.position.set(L.x + (j ? 0.6 : 0), 0, L.z + (j ? 0.6 : 0)); if (L.h != null) c.rotation.y = L.h; c.visible = L.dwell >= 0; });
    L.cv.forEach((c, j) => { c.visible = j < L.carry.length; if (c.visible) c.position.set(L.x + (j ? 0.6 : 0) + 0.35, 0.9, L.z + (j ? 0.6 : 0)); });
  }
}
export { live };
