// Building interiors: floor plans, live multi-room zone fire model, cutaway view,
// indoor scout-drone scans and occupants (hidden until a thermal scan finds them).
import {
  THREE, CSS2DObject, S, scene, camera, controls, sim, units, unitById, W1, ASSETS, sample, addLog, setVisorEvent,
  emitEv, onEv, fires, clamp, rand, tasks, newTaskId, assignTask,
} from './core.js';
import { makeHuman, setLying } from './human.js';

const A1 = ASSETS.find(a => a.id === 'A1');
const WALL_H = 3.2;

/* ---------------- floor plans (world coordinates, metres) ---------------- */
export const BUILDINGS = {
  W1: {
    id:'W1', name:'Warehouse W-1', short:'W-1', asset:W1, fireRoom:'hall', Qmax:8000,
    rooms:[
      { id:'hall',   name:'Storage hall', x0:-25, x1:-7,  z0:-41, z1:-32, h:9 },
      { id:'bay',    name:'Loading bay',  x0:-15, x1:-7,  z0:-32, z1:-27, h:6 },
      { id:'corr',   name:'Corridor',     x0:-19, x1:-15, z0:-32, z1:-27, h:3 },
      { id:'office', name:'Office',       x0:-25, x1:-19, z0:-32, z1:-27, h:3 },
    ],
    doors:[
      { a:'hall', b:'bay',  x:-11, z:-32,   w:4, area:12 },
      { a:'hall', b:'corr', x:-17, z:-32,   w:1, area:2 },
      { a:'corr', b:'office', x:-19, z:-29.5, w:1, area:2, axis:'x' },
      { a:'bay',  b:null, x:-7,  z:-29.5, w:3, area:9, axis:'x', name:'East roller door' },
      { a:'corr', b:null, x:-17, z:-27,   w:1, area:2, name:'South door' },
      { a:'office', b:null, x:-25, z:-29.5, w:1, area:0, axis:'x', jammed:true, name:'West fire exit' },
    ],
    people:[ { room:'office', x:-23.2, z:-30.4, lying:true }, { room:'office', x:-21.3, z:-28.6 } ],
    furniture:(add) => {
      for (let i = 0; i < 4; i++) add(-23 + i * 3.6, -38.5, 1.2, 2.8, 4.5, 0x5b4a36);   // pallet racks
      for (let i = 0; i < 4; i++) add(-23 + i * 3.6, -34.6, 1.2, 2.8, 4.5, 0x5b4a36);
      add(-22, -27.9, 3, 0.8, 0.9, 0x39424f); add(-24.2, -31, 0.8, 0.8, 1.6, 0x39424f);  // desk, cabinet
      add(-11, -29, 2.5, 1.4, 1.6, 0x2c4a7a);                                             // pallets in bay
    },
  },
  A1: {
    id:'A1', name:'Admin block', short:'Admin', asset:A1, fireRoom:null, Qmax:0,
    rooms:[
      { id:'lobby', name:'Lobby',     x0:-52, x1:-44, z0:44, z1:50, h:3.5 },
      { id:'offA',  name:'Office A',  x0:-61, x1:-52, z0:44, z1:56, h:3.5 },
      { id:'offB',  name:'Office B',  x0:-44, x1:-35, z0:44, z1:56, h:3.5 },
      { id:'wc',    name:'Archive / WC', x0:-52, x1:-44, z0:50, z1:56, h:3.5 },
    ],
    doors:[
      { a:'lobby', b:'offA', x:-52, z:47, w:1, area:2, axis:'x' },
      { a:'lobby', b:'offB', x:-44, z:47, w:1, area:2, axis:'x' },
      { a:'lobby', b:'wc',   x:-48, z:50, w:1, area:2 },
      { a:'lobby', b:null,   x:-48, z:44, w:2, area:3.6, name:'Main entrance' },
      { a:'offA',  b:null,   x:-61, z:51, w:1, area:0, axis:'x', name:'West exit' },
    ],
    people:[ { room:'wc', x:-46.5, z:54.2, lying:true } ],
    furniture:(add) => {
      for (let i = 0; i < 3; i++){ add(-58, 46.5 + i * 3.3, 2.2, 0.75, 1, 0x39424f); add(-38, 46.5 + i * 3.3, 2.2, 0.75, 1, 0x39424f); }
      add(-50.5, 53, 2.5, 2, 0.6, 0x4a4f58);
    },
  },
};

/* ---------------- graph helpers ---------------- */
for (const b of Object.values(BUILDINGS)){
  b.idx = Object.fromEntries(b.rooms.map((r, i) => [r.id, i]));
  for (const r of b.rooms){
    r.cx = (r.x0 + r.x1) / 2; r.cz = (r.z0 + r.z1) / 2;
    r.V = (r.x1 - r.x0) * (r.z1 - r.z0) * r.h;
    r.scanned = false; r.scanT = null;
  }
  b.state = { s:new Float64Array(b.rooms.length), T:new Float64Array(b.rooms.length).fill(20) };
  b.missing = 0; b.scanned = false;
  b.persons = b.people.map((p, i) => ({ ...p, id:`${b.id}-p${i}`, building:b.id, found:false, prob:0, fed:0, rescued:false, carried:null }));
}
export const roomAt = (b, x, z) => b.rooms.find(r => x >= r.x0 - 0.01 && x <= r.x1 + 0.01 && z >= r.z0 - 0.01 && z <= r.z1 + 0.01);
export function buildingAt(x, z){
  for (const b of Object.values(BUILDINGS)){ const a = b.asset; if (x > a.minX && x < a.maxX && z > a.minZ && z < a.maxZ) return b; }
  return null;
}
export const extDoors = b => b.doors.filter(d => !d.b);
// outward unit normal of an exterior door
export function doorNormal(b, d){
  const a = b.asset;
  if (Math.abs(d.x - a.minX) < 0.2) return { x:-1, z:0 };
  if (Math.abs(d.x - a.maxX) < 0.2) return { x:1, z:0 };
  if (Math.abs(d.z - a.minZ) < 0.2) return { x:0, z:-1 };
  return { x:0, z:1 };
}
// shortest room path (BFS over doors); returns list of {room, door} hops
export function roomPath(b, fromId, toId){
  const prev = { [fromId]:null }, q = [fromId];
  while (q.length){
    const r = q.shift(); if (r === toId) break;
    for (const d of b.doors){
      if (!d.b) continue;
      const o = d.a === r ? d.b : d.b === r ? d.a : null;
      if (o && !(o in prev)){ prev[o] = { r, d }; q.push(o); }
    }
  }
  if (!(toId in prev)) return null;
  const hops = []; for (let r = toId; prev[r]; r = prev[r].r) hops.unshift({ room:r, door:prev[r].d });
  return hops;
}

/* ---------------- live zone model (same equations as ml/zone_model.py) ---------------- */
export const T_AMB = 20;
export function zoneGraph(b){
  const n = b.rooms.length;
  const V = b.rooms.map(r => r.V);
  const edges = b.doors.filter(d => d.b).map(d => [b.idx[d.a], b.idx[d.b], d.area]);
  const ext = new Array(n).fill(0);
  for (const d of extDoors(b)) ext[b.idx[d.a]] += d.open ? Math.max(d.area, 2) : d.area;
  return { V, edges, ext };
}
export function sOutside(b){
  const s_out = new Array(b.rooms.length).fill(0);
  for (const d of extDoors(b)){
    const nrm = doorNormal(b, d), f = sample(d.x + nrm.x * 1.5, 1.5, d.z + nrm.z * 1.5, {});
    const K = 3 / Math.max(f.vis, 0.05);
    s_out[b.idx[d.a]] = Math.max(s_out[b.idx[d.a]], 1 - Math.exp(-K / 2));
  }
  return s_out;
}
export function fireQ(b){
  if (!b.fireRoom || !b.asset.burning) return 0;
  const f = fires.find(f => f.name === b.asset.name);
  return f ? b.Qmax * clamp(f.Ieff / 0.8, 0, 1.2) : 0;
}
export function zoneStep(s, T, Q, g, s_out, dt = 1){
  const { V, edges, ext } = g, n = V.length;
  for (let i = 0; i < n; i++){ T[i] += dt * 0.6 * Q[i] / (1.2 * V[i]); s[i] += dt * 0.0035 * Q[i] / V[i] * (1 - s[i]); }
  const ds = new Float64Array(n), dT = new Float64Array(n);
  for (const [i, j, A] of edges){
    const flow = 0.35 * A * Math.sqrt(Math.abs(T[i] - T[j]) + 4);
    const a = flow * (s[i] - s[j]), c = flow * (T[i] - T[j]);
    ds[i] -= a / V[i]; ds[j] += a / V[j]; dT[i] -= c / V[i]; dT[j] += c / V[j];
  }
  for (let i = 0; i < n; i++){
    s[i] += dt * ds[i]; T[i] += dt * dT[i];
    const fo = 0.35 * ext[i] * Math.sqrt(Math.abs(T[i] - T_AMB) + 4);
    s[i] += dt * fo * (s_out[i] - s[i]) / V[i];
    T[i] += dt * fo * (T_AMB - T[i]) / V[i];
    T[i] -= dt * 0.004 * (T[i] - T_AMB);
    s[i] = clamp(s[i], 0, 1); T[i] = clamp(T[i], 15, 1200);
  }
}
// derived readings for a room state
export function roomReadings(s, T){
  const K = -Math.log(Math.max(1e-6, 1 - s)) * 2;
  const Tk = T + 273.15;
  return { T, s, vis:Math.min(50, 3 / Math.max(K, 1e-3)), co:s * 1800, co2:420 + s * 40000,
           q:Math.max(0, 5.67e-11 * (Tk ** 4 - 293.15 ** 4)) };
}
// ISO 13571 fractional effective dose (CO asphyxia + convected heat), per minute
export function fedRate(r){ return r.co / 35000 + 1 / (5e7 * Math.pow(Math.max(r.T, 25), -3.4)); }

let acc = 0;
function interiorStep(dt){
  acc += dt;
  while (acc >= 1){
    acc -= 1;
    for (const b of Object.values(BUILDINGS)){
      const g = zoneGraph(b), so = sOutside(b);
      const Q = b.rooms.map(r => r.id === b.fireRoom ? fireQ(b) : 0);
      zoneStep(b.state.s, b.state.T, Q, g, so, 1);
      for (const p of b.persons){
        if (p.rescued || p.carried) continue;
        const i = b.idx[p.room], r = roomReadings(b.state.s[i], b.state.T[i]);
        const was = p.fed; p.fed += fedRate(r) / 60;
        if (was < 0.3 && p.fed >= 0.3 && p.found) addLog(`Casualty in ${b.short} ${b.rooms[i].name} deteriorating`, 'l2', `Warning. Casualty in ${b.short} ${b.rooms[i].name} is deteriorating.`);
      }
    }
  }
}
S.hooks.step.push(interiorStep);

/* indoor sensing: a unit inside a building reads that room's state */
S.hooks.sense = u => {
  const b = buildingAt(u.pos.x, u.pos.z); if (!b) return null;
  const r = roomAt(b, u.pos.x, u.pos.z); if (!r) return null;
  const i = b.idx[r.id]; const v = roomReadings(b.state.s[i], b.state.T[i]);
  return { T:v.T, q:v.q, co2:v.co2, co:v.co, vis:v.vis };
};

/* ---------------- missing persons (roll calls from core) ---------------- */
onEv('missing', ({ building, count }) => { const b = BUILDINGS[building]; if (b) b.missing = count; });
onEv('ignite', asset => { if (S.view === asset.id) for (const f of fires) if (f.name === asset.name) f.visBaseY = 0.3; });

/* ---------------- 3D cutaway geometry ---------------- */
const MAT = {
  floor: new THREE.MeshStandardMaterial({ color:0x2a2e35, roughness:0.95 }),
  unknown: new THREE.MeshStandardMaterial({ color:0x15171b, roughness:1 }),
  wall: new THREE.MeshStandardMaterial({ color:0xb9b4aa, roughness:0.85 }),
  wallTop: new THREE.MeshBasicMaterial({ color:0xe8e4dc }),
};
function hatchTex(){
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.fillStyle = '#121418'; g.fillRect(0, 0, 64, 64); g.strokeStyle = '#2b2f36'; g.lineWidth = 3;
  for (let i = -64; i < 128; i += 12){ g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
const HATCH = hatchTex();

// people are articulated humans (human.js): firefighters for crews, workers for casualties
function figure(color = 0xffb020){
  const h = makeHuman(color === 0xff5a1f ? 'ff' : 'worker');
  h.userData.mat = { color:{ setHex(){} }, emissive:{ setHex(){} } };   // status is shown by the ground ring
  return h;
}
export { figure };

function buildInterior(b){
  const G = new THREE.Group(); G.visible = false; scene.add(G); b.group = G; b.labels = [];
  const addBox = (x, z, w, d, h, color, parent = G) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness:0.8 }));
    m.position.set(x, h / 2 + 0.02, z); m.castShadow = m.receiveShadow = true; parent.add(m); return m;
  };
  // floors (known / unknown), smoke volumes, labels
  for (const r of b.rooms){
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(w, d), MAT.floor.clone());
    fl.rotation.x = -Math.PI / 2; fl.position.set(r.cx, 0.04, r.cz); fl.receiveShadow = true; G.add(fl); r.floor = fl;
    const tex = HATCH.clone(); tex.needsUpdate = true; tex.repeat.set(w / 3, d / 3);
    const un = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map:tex, transparent:true, opacity:0.96 }));
    un.rotation.x = -Math.PI / 2; un.position.set(r.cx, 3.3, r.cz); un.renderOrder = 6; G.add(un); r.fog = un;
    const sm = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, WALL_H - 0.1, d - 0.1),
      new THREE.MeshBasicMaterial({ color:0x8d8a86, transparent:true, opacity:0, depthWrite:false }));
    sm.position.set(r.cx, WALL_H / 2, r.cz); sm.renderOrder = 5; G.add(sm); r.smoke = sm;
    const heat = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color:0xff5a1f, transparent:true, opacity:0, depthWrite:false, blending:THREE.AdditiveBlending }));
    heat.rotation.x = -Math.PI / 2; heat.position.set(r.cx, 0.06, r.cz); G.add(heat); r.heat = heat;
    const el = document.createElement('div'); el.className = 'rlabel'; el.innerHTML = `<b>${r.name}</b><span></span>`;
    const lo = new CSS2DObject(el); lo.position.set(r.cx, WALL_H + 0.6, r.cz); lo.visible = false; G.add(lo); b.labels.push(lo); r.labelEl = el;
  }
  // walls with door gaps
  const T = 0.18;
  const segs = [];
  for (const r of b.rooms){
    segs.push([r.x0, r.z0, r.x1, r.z0], [r.x0, r.z1, r.x1, r.z1], [r.x0, r.z0, r.x0, r.z1], [r.x1, r.z0, r.x1, r.z1]);
  }
  const key = s => s.map(v => v.toFixed(2)).join(',');
  const seen = new Set();
  for (const [x0, z0, x1, z1] of segs){
    const k = key([x0, z0, x1, z1]); if (seen.has(k)) continue; seen.add(k);
    const horiz = Math.abs(z0 - z1) < 1e-6;
    let cuts = b.doors.filter(d => horiz ? Math.abs(d.z - z0) < 0.05 && d.x > x0 && d.x < x1 && d.axis !== 'x'
                                         : Math.abs(d.x - x0) < 0.05 && d.z > z0 && d.z < z1 && d.axis === 'x')
                      .map(d => [(horiz ? d.x : d.z) - d.w / 2, (horiz ? d.x : d.z) + d.w / 2]).sort((a, c) => a[0] - c[0]);
    let a = horiz ? x0 : z0; const end = horiz ? x1 : z1;
    const pieces = [];
    for (const [c0, c1] of cuts){ if (c0 > a) pieces.push([a, c0]); a = Math.max(a, c1); }
    if (end > a) pieces.push([a, end]);
    for (const [p0, p1] of pieces){
      const len = p1 - p0; if (len < 0.05) continue;
      const m = new THREE.Mesh(new THREE.BoxGeometry(horiz ? len : T, WALL_H, horiz ? T : len), MAT.wall);
      m.position.set(horiz ? (p0 + p1) / 2 : x0, WALL_H / 2, horiz ? z0 : (p0 + p1) / 2); m.castShadow = m.receiveShadow = true; G.add(m);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(horiz ? len : T + 0.02, 0.04, horiz ? T + 0.02 : len), MAT.wallTop);
      cap.position.set(m.position.x, WALL_H + 0.02, m.position.z); G.add(cap);
    }
  }
  // exterior door markers
  for (const d of extDoors(b)){
    const along = d.axis === 'x';
    const m = new THREE.Mesh(new THREE.BoxGeometry(along ? 0.35 : d.w, 0.08, along ? d.w : 0.35), new THREE.MeshBasicMaterial({ color:0x3ddc97 }));
    m.position.set(d.x, 0.1, d.z); G.add(m); d.marker = m;
    const el = document.createElement('div'); el.className = 'dlabel'; el.textContent = d.name;
    const lo = new CSS2DObject(el); const n = doorNormal(b, d); lo.position.set(d.x + n.x * 2.2, 0.4, d.z + n.z * 2.2); lo.visible = false; G.add(lo); b.labels.push(lo);
  }
  b.furniture((x, z, w, d, h, color) => addBox(x, z, w, d, h, color));
  // people
  for (const p of b.persons){
    const f = figure(0xffb020); f.position.set(p.x, 0, p.z);
    if (p.lying) setLying(f); else f.rotation.y = 2.4;
    f.visible = false; G.add(f); p.mesh = f;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.9, 32), new THREE.MeshBasicMaterial({ color:0xffb020, transparent:true, opacity:0.8, depthWrite:false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, 0.08, p.z); ring.visible = false; G.add(ring); p.ring = ring;
  }
}
for (const b of Object.values(BUILDINGS)) buildInterior(b);

/* ---------------- enter / exit cutaway view ---------------- */
let camTween = null, saved = null;
export function enterBuilding(id){
  const b = BUILDINGS[id]; if (!b) return;
  if (S.view && S.view !== id) exitBuilding(true);
  if (!saved) saved = { pos:camera.position.clone(), target:controls.target.clone(), min:controls.minDistance };
  S.view = id;
  const a = b.asset;
  a.mesh.visible = a.trim.visible = false; a.labelObj.visible = false;
  b.group.visible = true; b.labels.forEach(l => l.visible = true);
  const cx = (a.minX + a.maxX) / 2, cz = (a.minZ + a.maxZ) / 2, span = Math.max(a.maxX - a.minX, a.maxZ - a.minZ);
  camTween = { t:0, fromP:camera.position.clone(), fromT:controls.target.clone(),
               toP:new THREE.Vector3(cx - span * 0.55, span * 1.15, cz + span * 0.95), toT:new THREE.Vector3(cx, 0, cz) };
  controls.minDistance = 6;
  for (const f of fires) if (f.name === b.asset.name) f.visBaseY = 0.3;   // show the fire inside the cutaway
  emitEv('view', id);
}
export function exitBuilding(keepCam){
  if (!S.view) return;
  const b = BUILDINGS[S.view]; const a = b.asset;
  a.mesh.visible = a.trim.visible = true; a.labelObj.visible = true;
  b.group.visible = false; b.labels.forEach(l => l.visible = false);
  for (const f of fires) f.visBaseY = undefined;
  S.view = null;
  if (!keepCam && saved){ camTween = { t:0, fromP:camera.position.clone(), fromT:controls.target.clone(), toP:saved.pos, toT:saved.target }; controls.minDistance = saved.min; saved = null; }
  emitEv('view', null);
}

/* ---------------- scout drone scan ---------------- */
export function startScan(u, bId){
  const b = BUILDINGS[bId]; if (!b || !u) return false;
  // choose the coolest open exterior door
  const open = extDoors(b).filter(d => d.area > 0 || d.open);
  if (!open.length) return false;
  let best = null, bt = Infinity;
  for (const d of open){ const n = doorNormal(b, d); const T = sample(d.x + n.x * 3, 3, d.z + n.z * 3, {}).T; if (T < bt){ bt = T; best = d; } }
  const n = doorNormal(b, best);
  const wp = [{ x:best.x + n.x * 4, z:best.z + n.z * 4, y:4 }, { x:best.x, z:best.z, y:2.2 }];
  // visit every room (BFS order), travelling through doors
  const order = [], seen = new Set([best.a]), q = [best.a];
  while (q.length){ const r = q.shift(); order.push(r); for (const d of b.doors){ if (!d.b) continue; const o = d.a === r ? d.b : d.b === r ? d.a : null; if (o && !seen.has(o)){ seen.add(o); q.push(o); } } }
  let cur = best.a;
  const pushRoom = id => { const r = b.rooms[b.idx[id]]; wp.push({ x:r.cx, z:r.cz, y:2.2, scan:id }); };
  pushRoom(cur);
  for (const id of order.slice(1)){
    for (const h of roomPath(b, cur, id) || []){ wp.push({ x:h.door.x, z:h.door.z, y:2.2 }); if (h.room !== id) wp.push({ x:b.rooms[b.idx[h.room]].cx, z:b.rooms[b.idx[h.room]].cz, y:2.2 }); }
    pushRoom(id); cur = id;
  }
  for (const h of roomPath(b, cur, best.a) || []) wp.push({ x:h.door.x, z:h.door.z, y:2.2 });
  wp.push({ x:best.x, z:best.z, y:2.2 }, { x:best.x + n.x * 5, z:best.z + n.z * 5, y:6 });
  const t = { id:newTaskId(), title:`Scan ${b.short} for people`, kind:'scan', building:bId, unit:u.id, status:'queued', progress:0, wp, i:0, dwell:0, door:best.name };
  tasks.push(t); assignTask(t, u);
  addLog(`${u.id} scanning ${b.short} via ${best.name}`, '', `${u.name}, launching into ${b.short} through the ${best.name}.`);
  return true;
}
S.hooks.drone.scan = (u, t, dt) => {
  const b = BUILDINGS[t.building];
  // phase 1: fly to the first waypoint at cruise height, then follow indoor waypoints
  const w = t.wp[t.i];
  if (!w){ // done: return to staging
    t.status = 'done'; t.progress = 1; u.mode = 'idle'; u.task = null; u.status = `${b.short} scanned`;
    finishScan(u, b); return;
  }
  const cruise = t.i === 0 ? Math.max(w.y, 8) : w.y;
  const dx = w.x - u.pos.x, dz = w.z - u.pos.z, d = Math.hypot(dx, dz);
  const wantY = t.i === 0 && d > 4 ? cruise : w.y;
  u.pos.y += clamp(wantY - u.pos.y, -3 * dt, 3 * dt);
  const sp = t.i <= 1 ? u.speed : 2.2;
  if ((u.pos.y > 3 || t.i > 0) && d > 0.05){ const s = Math.min(d, sp * dt); u.pos.x += dx / d * s; u.pos.z += dz / d * s; u.targetHeading = Math.atan2(dx, dz); }
  u.mode = 'enroute'; t.status = t.i > 1 ? 'working' : 'en route';
  if (d < 0.4 && Math.abs(u.pos.y - w.y) < 0.6){
    if (w.scan){
      t.dwell += dt; u.mode = 'working'; u.targetHeading += dt * 2.4;  // spin = lidar/thermal sweep
      u.status = `Scanning ${b.rooms[b.idx[w.scan]].name}`;
      if (t.dwell >= 3){ scanRoom(b, w.scan); t.dwell = 0; t.i++; }
    } else t.i++;
    const nScan = t.wp.filter(x => x.scan).length, done = t.wp.slice(0, t.i).filter(x => x.scan).length;
    t.progress = done / nScan;
  }
};
function scanRoom(b, roomId){
  const r = b.rooms[b.idx[roomId]]; r.scanned = true; r.scanT = sim.t;
  for (const p of b.persons.filter(p => p.room === roomId && !p.rescued)){
    // thermal camera sees through smoke; small miss probability
    const hit = rand() < 0.95;
    emitEv('observe-person', { person:p, hit });
  }
  emitEv('room-scanned', { building:b.id, room:roomId });
}
function finishScan(u, b){
  b.scanned = true;
  const found = b.persons.filter(p => p.found && !p.rescued);
  const rooms = [...new Set(found.map(p => b.rooms[b.idx[p.room]].name))];
  const worst = found.length ? Math.max(...found.map(p => b.state.T[b.idx[p.room]])) : null;
  const words = ['No one', 'One person', 'Two people', 'Three people', 'Four people'];
  const say = found.length
    ? `${u.name}. ${b.short} scan complete. ${words[found.length] || found.length + ' people'} in the ${rooms.join(' and ')}, not moving. Room temperature ${Math.round(worst)} degrees.`
    : `${u.name}. ${b.short} scan complete. No one found.`;
  addLog(`${b.short} scan: ${found.length} person${found.length === 1 ? '' : 's'} found${rooms.length ? ' in ' + rooms.join(', ') : ''}`, found.length ? 'l2' : 'ok', say);
  setVisorEvent(`<b>SCAN</b> ${b.short} · ${found.length} found${rooms.length ? ' · ' + rooms.join(', ') : ''}`, 8);
  emitEv('scan-done', { building:b.id, found:found.length });
}

/* ---------------- per-frame visuals ---------------- */
export function updateInterior(dt, time, override){
  for (const b of Object.values(BUILDINGS)){
    if (!b.group.visible) continue;
    const ov = override && override.building === b.id ? override : null;   // forecast preview from the planner
    b.rooms.forEach((r, i) => {
      const s = ov ? ov.s[i] : b.state.s[i], T = ov ? ov.T[i] : b.state.T[i];
      const known = r.scanned || ov;
      r.fog.visible = !known;
      r.smoke.material.opacity = known ? Math.min(0.82, s * 0.9) : 0;
      r.smoke.material.color.setHex(ov ? 0x8796ad : 0x8d8a86);
      r.heat.material.opacity = known ? clamp((T - 40) / 300, 0, 0.75) * (0.85 + 0.15 * Math.sin(time * 6 + i)) : 0;
      const v = roomReadings(s, T), np = b.persons.filter(p => p.room === r.id && p.found && !p.rescued && !p.carried).length;
      r.labelEl.lastElementChild.textContent = known ? ` ${Math.round(T)}°  ${v.vis >= 30 ? 'clear' : v.vis.toFixed(v.vis < 10 ? 1 : 0) + ' m'}${np ? `  ·  ${np} ●` : ''}` : '  not scanned';
      r.labelEl.classList.toggle('hot', known && (T > 60 || s > 0.6));
    });
    for (const p of b.persons){
      const show = p.found && !p.rescued && !p.carried;
      p.mesh.visible = show; p.ring.visible = show;
      if (show){
        const c = p.fed >= 1 ? 0x6b6f76 : p.fed >= 0.3 ? 0xff3b30 : 0xffb020;
        p.mesh.userData.mat.color.setHex(c); p.mesh.userData.mat.emissive.setHex(c);
        p.ring.material.color.setHex(c); const k = 1 + 0.25 * Math.sin(time * 4); p.ring.scale.set(k, k, k);
      }
    }
    for (const d of extDoors(b)) d.marker.material.color.setHex(d.jammed ? 0xff3b30 : (d.area > 0 || d.open) ? 0x3ddc97 : 0x7d8088);
  }
  if (camTween){
    camTween.t = Math.min(1, camTween.t + dt / 1.1);
    const e = 1 - Math.pow(1 - camTween.t, 3);
    camera.position.lerpVectors(camTween.fromP, camTween.toP, e);
    controls.target.lerpVectors(camTween.fromT, camTween.toT, e);
    if (camTween.t >= 1) camTween = null;
  }
}
