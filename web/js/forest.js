// A3TN Forest — wildfire command.
// Cellular wildfire spread (10 m cells) driven by fuel, wind, slope and fuel moisture, with ember spotting;
// dispatchable crews, engines, bulldozers, Canadair water bombers and helicopters; a faster-than-real-time
// forecast of containment / extinction under the current resources; and a leader dashboard.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
let rand = Math.random;                    // swapped for a seeded generator while forecasting
const seeded = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const fmtT = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };
const clock = s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;
const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];
const compass = d => COMPASS[Math.round(((d % 360) + 360) % 360 / 45) % 8];

/* ================================================================
   World grid
   ================================================================ */
const N = 128, CS = 10, HALF = N * CS / 2, NN = N * N;
const ix = (i, j) => j * N + i;
const cx = i => (i + 0.5) * CS - HALF;          // cell centre → world
const cellAt = (x, z) => { const i = Math.floor((x + HALF) / CS), j = Math.floor((z + HALF) / CS); return i < 0 || j < 0 || i >= N || j >= N ? -1 : ix(i, j); };

// fuel models: ros = no-wind spread on flat ground (m/min), load (kg/m²), dur = flaming residence (s)
const F = { NONE:0, GRASS:1, SHRUB:2, FOREST:3, ROCK:4, WATER:5, ROAD:6, VILLAGE:7 };
const FUEL = [
  { name:'cleared',  ros:0,   load:0,   dur:0,    burn:false, col:[0.30, 0.22, 0.14] },
  { name:'grass',    ros:5,   load:0.4, dur:90,   burn:true,  col:[0.44, 0.45, 0.22] },
  { name:'shrubland',ros:2.2, load:1.6, dur:420,  burn:true,  col:[0.28, 0.32, 0.16] },
  { name:'forest',   ros:0.9, load:3.5, dur:1500, burn:true,  col:[0.13, 0.20, 0.11] },
  { name:'rock',     ros:0,   load:0,   dur:0,    burn:false, col:[0.38, 0.36, 0.34] },
  { name:'water',    ros:0,   load:0,   dur:0,    burn:false, col:[0.08, 0.14, 0.20] },
  { name:'road',     ros:0,   load:0,   dur:0,    burn:false, col:[0.24, 0.23, 0.22] },
  { name:'village',  ros:1.4, load:2.5, dur:1800, burn:true,  col:[0.40, 0.37, 0.33] },
];
const H_COMB = 18000;                       // kJ/kg heat of combustion

function hash(a, b){ const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y){ const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return lerp(lerp(hash(i, j), hash(i + 1, j), u), lerp(hash(i, j + 1), hash(i + 1, j + 1), u), v); }
function fbm(x, y, o = 5){ let s = 0, a = 0.5, f = 1; for (let k = 0; k < o; k++){ s += a * vnoise(x * f, y * f); a *= 0.5; f *= 2.03; } return s; }

const VILLAGE = { i0:14, i1:30, j0:50, j1:68 };
const LAKE = { i:42, j:100, r:11 };
const STATION = { i:33, j:59 };
const AIRBASE = { x:-HALF - 700, z:250 };
const height = new Float32Array(NN), fuel0 = new Uint8Array(NN);
{
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++){
    let h = fbm(i / 38 + 3.1, j / 38 + 7.7) * 120 + (i / N) * 45;                  // hills rising to the east
    const dv = Math.hypot(i - 22, j - 59); h = lerp(10, h, clamp((dv - 10) / 22, 0, 1));      // flat valley floor for the village
    const dl = Math.hypot(i - LAKE.i, j - LAKE.j); if (dl < LAKE.r + 8) h = lerp(-2, h, clamp((dl - LAKE.r + 3) / 11, 0, 1));
    height[ix(i, j)] = h;
  }
  const road = new Uint8Array(NN);
  const line = (pts) => { for (let k = 0; k < pts.length - 1; k++){ const [a, b] = [pts[k], pts[k + 1]]; const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    for (let s = 0; s <= n; s++){ const i = Math.round(lerp(a[0], b[0], s / n)), j = Math.round(lerp(a[1], b[1], s / n)); road[ix(i, j)] = 1; } } };
  line([[2, 60], [22, 59], [45, 56], [70, 50], [95, 52], [125, 47]]);           // valley road west → east
  line([[24, 60], [26, 82], [36, 96], [40, 126]]);                               // south road past the lake
  line([[22, 52], [30, 30], [52, 12], [70, 2]]);                                 // north forest track
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++){
    const k = ix(i, j), h = height[k], n2 = fbm(i / 14 + 11, j / 14 + 5, 4);
    let f;
    if (Math.hypot(i - LAKE.i, j - LAKE.j) < LAKE.r) f = F.WATER;
    else if (road[k]) f = F.ROAD;
    else if (i >= VILLAGE.i0 && i <= VILLAGE.i1 && j >= VILLAGE.j0 && j <= VILLAGE.j1) f = F.VILLAGE;
    else if (h > 150) f = F.ROCK;
    else if (Math.hypot(i - 22, j - 59) < 17) f = F.GRASS;                       // pasture around the village
    else f = n2 < 0.36 ? F.GRASS : n2 < 0.5 ? F.SHRUB : F.FOREST;
    fuel0[k] = f;
  }
}

/* ================================================================
   Fire state + spread model
   ================================================================ */
// state: 0 unburned, 1 burning, 2 burnt out, 3 extinguished
function newWorld(){
  return { t:0, fuel:fuel0.slice(), state:new Uint8Array(NN), prog:new Float32Array(NN), left:new Float32Array(NN), inten:new Float32Array(NN),
           wet:new Float32Array(NN), igT:new Float32Array(NN).fill(-1), outT:new Float32Array(NN).fill(-1), burning:[], wetList:[], burnedCount:0, changed:new Set() };
}
const W = newWorld();
const env = { windSpeed:6, windFrom:75, moist:7 };
const windVec = () => { const th = env.windFrom * Math.PI / 180; return { x:-Math.sin(th), z:Math.cos(th) }; };
const D8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

function ignite(w, k, ros = 0.02){
  const f = w.fuel[k]; if (!FUEL[f].burn || w.state[k] !== 0) return false;
  w.state[k] = 1; w.left[k] = FUEL[f].dur * (0.7 + 0.6 * rand()); w.igT[k] = w.t;
  w.inten[k] = FUEL[f].load * H_COMB * Math.max(ros, FUEL[f].ros / 60 * 0.4);   // Byram fireline intensity, kW/m
  w.burning.push(k); w.changed.add(k);
  return true;
}
/* one spread step. ROS(direction) = R0(fuel) · moisture · wind · slope, with
   wind factor exp(0.1783·U·cosθ) (U midflame, mph — Rothermel-style), slope factor exp(3.533·tanφ^1.2) (Butler / Rothermel) */
function spread(w, dt, en = env){
  const wv = windVec(), Umid = en.windSpeed * 2.237 * 0.45;                    // midflame wind, mph (canopy reduction ≈0.45)
  const mf = clamp(1 - en.moist / 28, 0, 1) ** 1.4;
  const next = [], cur = w.burning; w.burning = [];          // iterate a snapshot: cells ignited now spread from the next step
  for (const b of cur){
    if (w.state[b] !== 1) continue;
    w.left[b] -= dt;
    if (w.wet[b] > 0) w.inten[b] *= Math.exp(-dt / 90);
    if (w.left[b] <= 0 || w.inten[b] < 60){ w.state[b] = w.left[b] <= 0 ? 2 : 3; w.outT[b] = w.t; w.burnedCount++; w.changed.add(b); continue; }
    next.push(b);
    const bi = b % N, bj = (b / N) | 0, hb = height[b];
    for (const [di, dj] of D8){
      const i = bi + di, j = bj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const n = ix(i, j); if (w.state[n] !== 0 || w.wet[n] > 0) continue;
      const f = w.fuel[n]; if (!FUEL[f].burn) continue;
      const dist = di && dj ? 14.142 : 10;
      const cos = (di * wv.x + dj * wv.z) / (di && dj ? 1.4142 : 1);
      const windF = Math.min(25, Math.exp(0.1783 * Umid * cos));
      const tan = (height[n] - hb) / dist;
      const slopeF = tan > 0 ? Math.min(8, Math.exp(3.533 * Math.pow(tan, 1.2))) : Math.max(0.3, Math.exp(1.2 * tan));
      const ros = FUEL[f].ros / 60 * mf * windF * slopeF;                         // m/s
      w.prog[n] += ros * dt / dist * (0.6 + 0.8 * rand());
      if (w.prog[n] >= 1 && ignite(w, n, ros)) next.push(n);
    }
    // ember spotting from intense crown fire, carried downwind
    if (w.inten[b] > 6000 && en.windSpeed > 4 && rand() < dt * 0.00025 * (w.inten[b] / 6000)){
      const d = (40 + rand() * 220) * en.windSpeed / 8, lat = (rand() - 0.5) * 60;
      const s = cellAt(cx(bi) + wv.x * d - wv.z * lat, cx(bj) + wv.z * d + wv.x * lat);
      if (s >= 0 && w.wet[s] <= 0 && ignite(w, s, 0.05)){ next.push(s); w.spots = (w.spots || 0) + 1; }
    }
  }
  // dedupe (cells ignited this step were pushed twice: once by ignite, once here)
  const seen = new Uint8Array(NN); w.burning = [];
  for (const k of next) if (!seen[k] && w.state[k] === 1){ seen[k] = 1; w.burning.push(k); }
  // retardant / water dries out
  if (w.wetList.length){
    const keep = [];
    for (const k of w.wetList){ w.wet[k] -= dt; if (w.wet[k] > 0) keep.push(k); else { w.wet[k] = 0; w.changed.add(k); } }
    w.wetList = keep;
  }
  w.t += dt;
}
function frontCells(w){
  const out = [];
  for (const b of w.burning){
    const bi = b % N, bj = (b / N) | 0;
    for (const [di, dj] of D8){ const i = bi + di, j = bj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const n = ix(i, j); if (w.state[n] === 0 && FUEL[w.fuel[n]].burn && w.wet[n] <= 0){ out.push(b); break; } }
  }
  return out;
}

/* suppression actions (shared by the live sim and the forecast) */
function wetCell(w, k, secs){ if (w.wet[k] <= 0) w.wetList.push(k); w.wet[k] = Math.max(w.wet[k], secs); w.changed.add(k); }
function knock(w, k, limit){ // direct attack on one burning cell
  if (w.state[k] !== 1) return false;
  if (w.inten[k] > limit){ w.inten[k] *= 0.8; return false; }
  w.state[k] = 3; w.outT[k] = w.t; w.burnedCount++; w.changed.add(k); return true;
}
function dropStrip(w, x, z, hx, hz, len, wid, secs, limit){
  for (let s = -len / 2; s <= len / 2; s += 5) for (let q = -wid / 2; q <= wid / 2; q += 5){
    const k = cellAt(x + hx * s - hz * q, z + hz * s + hx * q); if (k < 0) continue;
    if (w.state[k] === 1){ if (w.inten[k] < limit) knock(w, k, limit); else w.inten[k] *= 0.35; }
    if (w.state[k] !== 2) wetCell(w, k, secs);
  }
}
const SPEC = {
  crew:   { name:'Hand crew',    count:4, speed:{ road:9, off:1.1 }, radius:28, rate:1 / 35, limit:900,  line:true,  icon:'crew' },
  engine: { name:'Engine',       count:3, speed:{ road:13, off:3 },  radius:40, rate:1 / 14, limit:2500, line:false, icon:'engine', noForest:true },
  dozer:  { name:'Bulldozer',    count:2, speed:{ road:5, off:1.0 }, radius:0,  rate:0,      limit:0,    icon:'dozer' },
  // pattern = circuit time per leg (approach, turn, climb-out): a CL-415 cycle near a lake is ~5–6 min
  bomber: { name:'Canadair CL-415', count:2, air:true, speed:75, scoop:14, pattern:130, cap:6000, icon:'bomber' },
  heli:   { name:'Helicopter',   count:2, air:true, speed:45, scoop:35, pattern:45, cap:1200, icon:'heli' },
};
// one suppression tick for a ground unit working at (x, z); returns cells knocked down
function groundWork(w, u, dt){
  const sp = SPEC[u.type]; let did = 0;
  u.acc = (u.acc || 0) + dt * sp.rate;
  const r = Math.ceil(sp.radius / CS), ci = Math.floor((u.x + HALF) / CS), cj = Math.floor((u.z + HALF) / CS);
  while (u.acc >= 1){
    u.acc -= 1;
    let best = -1, bd = 1e9;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++){
      const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const k = ix(i, j); if (w.state[k] !== 1) continue;
      const d = di * di + dj * dj + w.inten[k] / 2000; if (d < bd){ bd = d; best = k; }
    }
    if (best >= 0){ if (knock(w, best, sp.limit)) did++; }
    else if (sp.line){ // nothing burning in reach: cut a hand line in the unburned fuel next to the black
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++){
        const k = ix(clamp(ci + di, 0, N - 1), clamp(cj + dj, 0, N - 1));
        if (w.state[k] === 0 && FUEL[w.fuel[k]].burn && w.fuel[k] !== F.VILLAGE){ w.fuel[k] = F.NONE; w.changed.add(k); break; }
      }
    }
  }
  return did;
}
function headNear(w, x, z, maxD = 320){   // the most intense cell on the active edge near (x, z): where water does the most good
  let best = -1, bi = -1;
  for (const k of frontCells(w)){ const dx = cx(k % N) - x, dz = cx((k / N) | 0) - z; if (dx * dx + dz * dz > maxD * maxD) continue; if (w.inten[k] > bi){ bi = w.inten[k]; best = k; } }
  return best >= 0 ? best : nearestBurning(w, x, z, maxD);
}
function nearestBurning(w, x, z, maxD = 1e9){
  let best = -1, bd = maxD * maxD;
  for (const k of w.burning){ const dx = cx(k % N) - x, dz = cx((k / N) | 0) - z, d = dx * dx + dz * dz; if (d < bd){ bd = d; best = k; } }
  return best;
}

/* ================================================================
   Rendering
   ================================================================ */
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);
const labelR = new CSS2DRenderer(); labelR.domElement.className = 'labels'; stage.appendChild(labelR.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.fog = new THREE.FogExp2(0x10131a, 0.00055);
const camera = new THREE.PerspectiveCamera(42, 1, 1, 8000);
camera.position.set(-520, 520, 820);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(60, 0, -20); controls.enableDamping = true; controls.maxPolarAngle = 1.42; controls.minDistance = 60; controls.maxDistance = 2600;
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.92); composer.addPass(bloom);
composer.addPass(new OutputPass());
const uTime = { value:0 }, uScale = { value:800 };

scene.add(new THREE.HemisphereLight(0x55688a, 0x0b0c10, 0.85));
const moon = new THREE.DirectionalLight(0x9fb4dc, 0.55); moon.position.set(-600, 900, 500);
moon.castShadow = true; moon.shadow.mapSize.set(2048, 2048);
Object.assign(moon.shadow.camera, { left:-800, right:800, top:800, bottom:-800, near:100, far:2600 }); moon.shadow.bias = -0.0008;
scene.add(moon);
const fireLights = [0, 1, 2].map(() => { const L = new THREE.PointLight(0xff7a2e, 0, 320, 2); scene.add(L); return L; });

// terrain: one vertex per cell centre, colours from a state texture
const colorData = new Uint8Array(NN * 4), glowData = new Uint8Array(NN * 4);
const colorTex = new THREE.DataTexture(colorData, N, N, THREE.RGBAFormat); colorTex.magFilter = THREE.LinearFilter; colorTex.colorSpace = THREE.SRGBColorSpace;
const glowTex = new THREE.DataTexture(glowData, N, N, THREE.RGBAFormat); glowTex.magFilter = THREE.LinearFilter;
const tGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(NN * 3), uv = new Float32Array(NN * 2), idx = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++){ const k = ix(i, j); pos.set([cx(i), height[k], cx(j)], k * 3); uv.set([(i + 0.5) / N, (j + 0.5) / N], k * 2); }
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++){ const a = ix(i, j), b = ix(i + 1, j), c = ix(i, j + 1), d = ix(i + 1, j + 1); idx.push(a, c, b, b, c, d); }
  tGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); tGeo.setIndex(idx); tGeo.computeVertexNormals();
}
const terrain = new THREE.Mesh(tGeo, new THREE.MeshStandardMaterial({ map:colorTex, emissiveMap:glowTex, emissive:0xffffff, emissiveIntensity:1.4, roughness:1, metalness:0 }));
terrain.receiveShadow = true; scene.add(terrain);
const hAt = (x, z) => { const k = cellAt(x, z); return k < 0 ? 0 : height[k]; };
// lake surface
{
  const lake = new THREE.Mesh(new THREE.CircleGeometry((LAKE.r + 1.5) * CS, 48), new THREE.MeshStandardMaterial({ color:0x0c1824, roughness:0.12, metalness:0.7 }));
  lake.rotation.x = -Math.PI / 2; lake.position.set(cx(LAKE.i), 0.6, cx(LAKE.j)); scene.add(lake);
}
const tint = new Float32Array(NN);           // per-cell brightness variation
for (let k = 0; k < NN; k++) tint[k] = 0.82 + 0.36 * hash(k * 0.37, k * 1.91);
function paintCell(k){
  const s = W.state[k], f = W.fuel[k];
  let c = FUEL[f].col, g = [0, 0, 0], tn = tint[k];
  if (s === 1){ c = [0.10, 0.06, 0.04]; const a = clamp(Math.log10(W.inten[k] + 10) / 4.3, 0.25, 1); g = [1.0 * a, 0.38 * a, 0.08 * a]; }
  else if (s === 2){ c = [0.07, 0.065, 0.06]; const age = W.t - W.outT[k]; const e = clamp(1 - age / 900, 0, 1) * 0.35; g = [e, e * 0.25, 0]; }
  else if (s === 3){ c = [0.13, 0.13, 0.13]; }
  if (W.wet[k] > 0){ c = [c[0] * 0.6 + 0.10, c[1] * 0.6 + 0.14, c[2] * 0.6 + 0.22]; }
  const slope = Math.abs(height[Math.min(NN - 1, k + 1)] - height[k]) / 40;
  for (let q = 0; q < 3; q++){ colorData[k * 4 + q] = clamp(c[q] * tn * (1 - slope * 0.4) * 255, 0, 255); glowData[k * 4 + q] = clamp(g[q] * 255, 0, 255); }
  colorData[k * 4 + 3] = glowData[k * 4 + 3] = 255;
}
for (let k = 0; k < NN; k++) paintCell(k);
colorTex.needsUpdate = glowTex.needsUpdate = true;

// trees (instanced) — two per forest cell, one bush per shrub cell
const treeCells = [];
for (let k = 0; k < NN; k++){ if (fuel0[k] === F.FOREST){ treeCells.push(k, k); } else if (fuel0[k] === F.SHRUB && hash(k, 3) < 0.6) treeCells.push(-k - 1); }
const trees = new THREE.InstancedMesh(new THREE.ConeGeometry(2.6, 9, 7).translate(0, 5.6, 0), new THREE.MeshStandardMaterial({ roughness:0.9 }), treeCells.length);
const trunkCol = new THREE.Color(), m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new THREE.Vector3(), p4 = new THREE.Vector3();
const cellTrees = new Map();
treeCells.forEach((code, n) => {
  const shrub = code < 0, k = shrub ? -code - 1 : code, i = k % N, j = (k / N) | 0;
  const x = cx(i) + (hash(n, 1) - 0.5) * 8, z = cx(j) + (hash(n, 2) - 0.5) * 8, sc = shrub ? 0.35 + hash(n, 4) * 0.2 : 0.8 + hash(n, 5) * 0.6;
  m4.compose(p4.set(x, height[k] - 0.5, z), q4.setFromAxisAngle(s4.set(0, 1, 0), hash(n, 6) * 6.28), s4.set(sc, sc * (shrub ? 0.6 : 1), sc));
  trees.setMatrixAt(n, m4);
  trees.setColorAt(n, trunkCol.setHSL(0.26 + hash(n, 7) * 0.06, 0.35, shrub ? 0.16 : 0.10 + hash(n, 8) * 0.05));
  if (!cellTrees.has(k)) cellTrees.set(k, []); cellTrees.get(k).push(n);
});
trees.castShadow = true; trees.receiveShadow = true; scene.add(trees);
function paintTrees(k){
  const list = cellTrees.get(k); if (!list) return;
  const s = W.state[k];
  for (const n of list){
    if (s === 1) trunkCol.setRGB(0.32, 0.08, 0.02);
    else if (s === 2 || s === 3) trunkCol.setRGB(0.035, 0.03, 0.03);
    else continue;
    trees.setColorAt(n, trunkCol);
  }
  trees.instanceColor.needsUpdate = true;
}
// village houses
const houses = [];
{
  const hg = new THREE.BoxGeometry(7, 4.5, 9), rg = new THREE.ConeGeometry(6.4, 3, 4).rotateY(Math.PI / 4);
  const wall = new THREE.MeshStandardMaterial({ color:0xc9c2b4, roughness:0.85, emissive:0xffcf8a, emissiveIntensity:0.04 });
  const roofM = new THREE.MeshStandardMaterial({ color:0x8a3a2a, roughness:0.8 });
  for (let j = VILLAGE.j0; j <= VILLAGE.j1; j += 2) for (let i = VILLAGE.i0; i <= VILLAGE.i1; i += 2){
    if (hash(i, j) < 0.35) continue; const k = ix(i, j);
    const g = new THREE.Group(); g.position.set(cx(i) + (hash(i, 9) - 0.5) * 4, height[k], cx(j)); g.rotation.y = hash(j, i) * 1.2;
    const b = new THREE.Mesh(hg, wall); b.position.y = 2.25; b.castShadow = b.receiveShadow = true; g.add(b);
    const r = new THREE.Mesh(rg, roofM); r.position.y = 6; r.scale.z = 1.3; r.castShadow = true; g.add(r);
    scene.add(g); houses.push({ g, k });
  }
}
// fire station marker
{
  const st = new THREE.Mesh(new THREE.BoxGeometry(18, 7, 12), new THREE.MeshStandardMaterial({ color:0x9a2a22, roughness:0.6 }));
  st.position.set(cx(STATION.i), height[ix(STATION.i, STATION.j)] + 3.5, cx(STATION.j)); st.castShadow = true; scene.add(st);
  const el = document.createElement('div'); el.className = 'alabel'; el.textContent = 'fire station'; const o = new CSS2DObject(el); o.position.set(st.position.x, st.position.y + 9, st.position.z); scene.add(o);
  const v = document.createElement('div'); v.className = 'alabel'; v.textContent = 'village · 340 residents'; const ov = new CSS2DObject(v); ov.position.set(cx(22), 30, cx(59)); scene.add(ov);
  const l = document.createElement('div'); l.className = 'alabel'; l.textContent = 'lake · water source'; const ol = new CSS2DObject(l); ol.position.set(cx(LAKE.i), 12, cx(LAKE.j)); scene.add(ol);
}

/* ---------------- flames: GPU-animated looping tongues, a few per burning cell ---------------- */
const MAXF = 9000;
const fPos = new Float32Array(MAXF * 3), fSeed = new Float32Array(MAXF), fInt = new Float32Array(MAXF);
const fGeo = new THREE.BufferGeometry();
fGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3).setUsage(THREE.DynamicDrawUsage));
fGeo.setAttribute('aSeed', new THREE.BufferAttribute(fSeed, 1).setUsage(THREE.DynamicDrawUsage));
fGeo.setAttribute('aInt', new THREE.BufferAttribute(fInt, 1).setUsage(THREE.DynamicDrawUsage));
const flameMat = new THREE.ShaderMaterial({
  transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, uniforms:{ uTime, uScale, uWind:{ value:new THREE.Vector2() } },
  vertexShader:`attribute float aSeed; attribute float aInt; uniform float uTime, uScale; uniform vec2 uWind; varying float vA; varying float vI; varying float vS;
    void main(){
      float ph = fract(uTime * (0.8 + aSeed * 0.9) + aSeed * 7.0);      // each point loops upward like a flame tongue
      float L = 0.0775 * pow(aInt, 0.46);                                // Byram flame length (m) from intensity (kW/m)
      vec3 p = position; p.y += ph * L * 0.9; p.xz += uWind * ph * L * 0.35 + vec2(sin(aSeed * 40.0 + uTime * 3.0), cos(aSeed * 31.0 + uTime * 2.6)) * 0.8;
      vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
      vA = ph; vI = aInt; vS = aSeed;
      gl_PointSize = (2.5 + L * 0.55) * (1.0 - ph * 0.55) * uScale / max(-mv.z, 1.0);
    }`,
  fragmentShader:`varying float vA; varying float vI; varying float vS;
    void main(){
      vec2 p = gl_PointCoord * 2.0 - 1.0; p.y = -p.y; p.x *= 1.3 + 0.8 * max(p.y, 0.0);
      float r = length(p); if (r > 1.0) discard;
      float soft = pow(1.0 - r, 1.6);
      vec3 c = mix(vec3(1.0, 0.85, 0.45), vec3(1.0, 0.38, 0.06), smoothstep(0.0, 0.45, vA));
      c = mix(c, vec3(0.55, 0.08, 0.02), smoothstep(0.45, 1.0, vA));
      float a = soft * (1.0 - smoothstep(0.6, 1.0, vA)) * smoothstep(0.0, 0.08, vA) * 0.55;
      gl_FragColor = vec4(pow(c, vec3(1.8)) * (1.2 + 0.4 * clamp(log(vI) / 9.0, 0.0, 1.0)), a);
    }`,
});
const flames = new THREE.Points(fGeo, flameMat); flames.frustumCulled = false; flames.renderOrder = 3; scene.add(flames);
function rebuildFlames(){
  let n = 0;
  for (const k of W.burning){
    const per = W.inten[k] > 4000 ? 4 : W.inten[k] > 800 ? 3 : 2;
    for (let q = 0; q < per && n < MAXF; q++, n++){
      const h = hash(k + q * 0.13, q + 0.7), h2 = hash(k * 0.7, q + 2.1);
      fPos[n * 3] = cx(k % N) + (h - 0.5) * 9; fPos[n * 3 + 2] = cx((k / N) | 0) + (h2 - 0.5) * 9; fPos[n * 3 + 1] = height[k] + 0.3 + (fuel0[k] === F.FOREST ? 2 : 0);
      fSeed[n] = hash(k, q); fInt[n] = Math.max(50, W.inten[k]);
    }
  }
  fGeo.setDrawRange(0, n);
  fGeo.attributes.position.needsUpdate = fGeo.attributes.aSeed.needsUpdate = fGeo.attributes.aInt.needsUpdate = true;
}

/* ---------------- smoke: CPU particles from block centroids ---------------- */
const MAXS = 2200, sPos = new Float32Array(MAXS * 3), sVel = new Float32Array(MAXS * 3), sAge = new Float32Array(MAXS).fill(-1), sLife = new Float32Array(MAXS), sSize = new Float32Array(MAXS);
const sGeo = new THREE.BufferGeometry();
sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3).setUsage(THREE.DynamicDrawUsage));
sGeo.setAttribute('aAge', new THREE.BufferAttribute(sAge, 1).setUsage(THREE.DynamicDrawUsage));
sGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1).setUsage(THREE.DynamicDrawUsage));
const smokeMat = new THREE.ShaderMaterial({
  transparent:true, depthWrite:false, uniforms:{ uScale, uTime },
  vertexShader:`attribute float aAge; attribute float aSize; uniform float uScale; varying float vA;
    void main(){ vA = aAge; if (aAge < 0.0){ gl_Position = vec4(2.0); gl_PointSize = 0.0; return; }
      vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * (0.35 + aAge * 1.8) * uScale / max(-mv.z, 1.0); }`,
  fragmentShader:`varying float vA; uniform float uTime;
    void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
      float soft = pow(1.0 - r, 2.0);
      vec3 c = mix(vec3(0.28, 0.24, 0.2), vec3(0.11, 0.11, 0.12), smoothstep(0.0, 0.6, vA));
      c += vec3(0.6, 0.22, 0.05) * (1.0 - smoothstep(0.0, 0.2, vA)) * 0.5;
      gl_FragColor = vec4(c, soft * smoothstep(0.0, 0.08, vA) * (1.0 - smoothstep(0.55, 1.0, vA)) * 0.42); }`,
});
const smoke = new THREE.Points(sGeo, smokeMat); smoke.frustumCulled = false; smoke.renderOrder = 2; scene.add(smoke);
let sHead = 0, sources = [];
function computeSources(){
  const B = 8, acc = new Map();
  for (const k of W.burning){ const bk = ((((k / N) | 0) / B) | 0) * 100 + (((k % N) / B) | 0); const a = acc.get(bk) || { x:0, z:0, y:0, w:0, n:0 };
    const wgt = Math.log10(W.inten[k] + 10); a.x += cx(k % N) * wgt; a.z += cx((k / N) | 0) * wgt; a.y += height[k] * wgt; a.w += wgt; a.n++; acc.set(bk, a); }
  sources = [...acc.values()].map(a => ({ x:a.x / a.w, z:a.z / a.w, y:a.y / a.w, n:a.n, w:a.w })).sort((a, b) => b.w - a.w);
}
function updateSmoke(dt){
  const wv = windVec();
  for (const s of sources.slice(0, 24)){
    s.acc = (s.acc || 0) + dt * Math.min(28, 2 + s.n * 0.8);
    while (s.acc >= 1){ s.acc -= 1; const i = sHead; sHead = (sHead + 1) % MAXS;
      sPos[i * 3] = s.x + (rand() - 0.5) * 30; sPos[i * 3 + 1] = s.y + 8 + rand() * 6; sPos[i * 3 + 2] = s.z + (rand() - 0.5) * 30;
      sVel[i * 3] = (rand() - 0.5) * 1.5; sVel[i * 3 + 1] = 6 + rand() * 5; sVel[i * 3 + 2] = (rand() - 0.5) * 1.5;
      sAge[i] = 0; sLife[i] = 40 + rand() * 30; sSize[i] = 30 + rand() * 30; }
  }
  for (let i = 0; i < MAXS; i++){ if (sAge[i] < 0) continue; const a = sAge[i] + dt / sLife[i]; if (a >= 1){ sAge[i] = -1; continue; } sAge[i] = a;
    const j = i * 3, w = env.windSpeed * (0.5 + a * 1.6);
    sPos[j] += (sVel[j] + wv.x * w) * dt; sPos[j + 1] += sVel[j + 1] * (1 - a * 0.6) * dt; sPos[j + 2] += (sVel[j + 2] + wv.z * w) * dt; }
  sGeo.attributes.position.needsUpdate = sGeo.attributes.aAge.needsUpdate = sGeo.attributes.aSize.needsUpdate = true;
}

/* ================================================================
   Resources: ground units + aircraft
   ================================================================ */
const units = [];
const pools = Object.fromEntries(Object.entries(SPEC).map(([k, s]) => [k, s.count]));
let unitSeq = 1;
const M_ = (c, r = 0.6, m = 0.3) => new THREE.MeshStandardMaterial({ color:c, roughness:r, metalness:m });
function unitMesh(type){
  const g = new THREE.Group(), add = (geo, mat, x, y, z, ry = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.y = ry; o.castShadow = true; g.add(o); return o; };
  if (type === 'engine'){ add(new THREE.BoxGeometry(3, 3, 8), M_(0xb3231c), 0, 2.2, 0); add(new THREE.BoxGeometry(2.8, 0.6, 2), M_(0xeeeeee), 0, 3.9, -1); }
  else if (type === 'crew'){ add(new THREE.BoxGeometry(2.6, 2.4, 5), M_(0xd9a521), 0, 1.8, 0); for (let q = 0; q < 4; q++) add(new THREE.CapsuleGeometry(0.35, 1.1, 3, 6), M_(0xd6c040), -2 + q * 1.3, 1, 4.5); }
  else if (type === 'dozer'){ add(new THREE.BoxGeometry(3.4, 2.6, 5), M_(0xe0b020), 0, 1.9, 0); add(new THREE.BoxGeometry(4.6, 1.6, 0.5), M_(0x555555, 0.4, 0.8), 0, 1.0, 3.2); add(new THREE.BoxGeometry(3.8, 0.9, 5.4), M_(0x222222), 0, 0.5, 0); }
  else if (type === 'bomber'){ // Canadair-style amphibious bomber, yellow and red, scaled up for legibility
    add(new THREE.CylinderGeometry(1.4, 1.1, 20, 12).rotateX(Math.PI / 2), M_(0xe8c21e, 0.45), 0, 0, 0);
    add(new THREE.BoxGeometry(29, 0.5, 3.4), M_(0xe8c21e, 0.45), 0, 1.6, 0.5);
    add(new THREE.BoxGeometry(9, 0.4, 2.2), M_(0xc5281c, 0.45), 0, 4.2, -9);
    add(new THREE.BoxGeometry(0.4, 4.5, 2.6), M_(0xc5281c, 0.45), 0, 2.3, -9);
    for (const x of [-5, 5]) add(new THREE.CylinderGeometry(0.7, 0.7, 3.6, 10).rotateX(Math.PI / 2), M_(0xc5281c), x, 1.2, 2.5);
    g.scale.setScalar(2.2);
  } else if (type === 'heli'){
    add(new THREE.SphereGeometry(2.2, 14, 10).scale(1, 0.9, 1.6), M_(0xc5281c, 0.45), 0, 0, 0);
    add(new THREE.CylinderGeometry(0.3, 0.5, 8, 8).rotateX(Math.PI / 2), M_(0xc5281c), 0, 0.4, -5.5);
    const rotor = add(new THREE.BoxGeometry(14, 0.12, 0.5), M_(0x222222), 0, 2.4, 0); g.userData.rotor = rotor;
    const bucket = add(new THREE.CylinderGeometry(0.8, 0.6, 1.2, 10), M_(0xe8c21e), 0, -6, 0); g.userData.bucket = bucket;
    g.scale.setScalar(2.0);
  }
  return g;
}
function routeGround(u, tx, tz){
  // A* over the grid: road fast, off-road slow, water / burning impassable; engines stay out of dense forest
  const sp = SPEC[u.type], s = cellAt(u.x, u.z), t = cellAt(tx, tz); if (s < 0 || t < 0) return null;
  const cost = k => { const f = W.fuel[k]; if (f === F.WATER || W.state[k] === 1) return Infinity;
    if (f === F.ROAD) return CS / sp.speed.road; if (sp.noForest && f === F.FOREST) return CS / (sp.speed.off * 0.25);
    return CS / (sp.speed.off * (f === F.ROCK ? 0.4 : 1) * (1 / (1 + Math.abs(height[k] - height[s]) * 0)) ); };
  const g = new Float32Array(NN).fill(Infinity), from = new Int32Array(NN).fill(-1), done = new Uint8Array(NN);
  const open = [[0, s]]; g[s] = 0;
  const hsc = k => Math.hypot(k % N - t % N, ((k / N) | 0) - ((t / N) | 0)) * CS / sp.speed.road;
  while (open.length){
    let bi = 0; for (let q = 1; q < open.length; q++) if (open[q][0] < open[bi][0]) bi = q;
    const [, k] = open.splice(bi, 1)[0]; if (k === t) break; if (done[k]) continue; done[k] = 1;
    const ki = k % N, kj = (k / N) | 0;
    for (const [di, dj] of D8){ const i = ki + di, j = kj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue; const n = ix(i, j); if (done[n]) continue;
      const c = cost(n); if (!isFinite(c) && n !== t) continue;
      const ng = g[k] + (isFinite(c) ? c : 60) * (di && dj ? 1.414 : 1);
      if (ng < g[n]){ g[n] = ng; from[n] = k; open.push([ng + hsc(n), n]); } }
    if (open.length > 6000) open.sort((a, b) => a[0] - b[0]).length = 3000;
  }
  if (from[t] < 0 && s !== t) return null;
  const path = []; for (let k = t; k !== -1 && k !== s; k = from[k]) path.unshift({ x:cx(k % N), z:cx((k / N) | 0) });
  path.push({ x:tx, z:tz });
  u.eta = g[t];
  return path;
}
function dispatch(type, tx, tz, tx2, tz2){
  if (pools[type] <= 0) return say(`No ${SPEC[type].name.toLowerCase()} available.`);
  pools[type]--;
  const sp = SPEC[type];
  const u = { id:`${{ crew:'C', engine:'E', dozer:'B', bomber:'CL', heli:'H' }[type]}${unitSeq++}`, type, x:0, z:0, y:0, tx, tz, tx2, tz2, state:'transit', heading:0, water:0, drops:0, acc:0, did:0 };
  if (sp.air){ u.x = AIRBASE.x; u.z = AIRBASE.z; u.y = 160; u.state = 'toLake'; const k = headNear(W, tx, tz); if (k >= 0){ u.tx = cx(k % N); u.tz = cx((k / N) | 0); } }
  else { u.x = cx(STATION.i); u.z = cx(STATION.j); u.path = routeGround(u, tx, tz) || [{ x:tx, z:tz }]; }
  u.mesh = unitMesh(type); scene.add(u.mesh);
  const el = document.createElement('div'); el.className = 'ulabel2'; el.textContent = u.id; el.addEventListener('pointerdown', e => { e.stopPropagation(); selectUnit(u); });
  u.label = new CSS2DObject(el); u.labelEl = el; scene.add(u.label);
  u.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color:0xd8dce2, dashSize:10, gapSize:8, transparent:true, opacity:0.5 }));
  u.line.frustumCulled = false; scene.add(u.line);
  units.push(u);
  log(`${u.id} ${sp.name} dispatched${sp.air ? '' : ` · ETA ${fmtT(u.eta || 0)}`}`);
  return u;
}
function recall(u){
  const sp = SPEC[u.type];
  u.state = 'return';
  if (!sp.air) u.path = routeGround(u, cx(STATION.i), cx(STATION.j)) || [{ x:cx(STATION.i), z:cx(STATION.j) }];
  log(`${u.id} recalled`);
}
function moveAlong(u, dt){
  const sp = SPEC[u.type];
  let budget = dt;
  while (budget > 0 && u.path && u.path.length){
    const w = u.path[0], k = cellAt(u.x, u.z), f = k >= 0 ? W.fuel[k] : F.GRASS;
    const v = f === F.ROAD ? sp.speed.road : sp.speed.off * (f === F.FOREST && sp.noForest ? 0.25 : 1);
    const dx = w.x - u.x, dz = w.z - u.z, d = Math.hypot(dx, dz);
    if (d < 0.01){ u.path.shift(); continue; }
    const step = Math.min(d, v * budget); u.x += dx / d * step; u.z += dz / d * step; budget -= step / v; u.heading = Math.atan2(dx, dz);
    if (step >= d - 1e-6) u.path.shift();
  }
  return !u.path || !u.path.length;
}
function updateGround(u, dt){
  const sp = SPEC[u.type];
  readSensors(u, dt);
  // crew safety: withdraw on critical sensor readings, or when a very intense front is close
  if ((u.state === 'working' || u.state === 'transit') && u.type !== 'dozer' && u.level >= 3){
    u.state = 'retreat'; const wv = windVec(); const rx = u.x - wv.x * 160, rz = u.z - wv.z * 160;
    u.path = routeGround(u, rx, rz) || [{ x:rx, z:rz }];
    alert(3, `<b>Auto-withdraw</b>${u.id} · ${Math.round(u.sens.T)} °C · ${u.sens.q.toFixed(1)} kW/m² · CO ${Math.round(u.sens.co)} ppm`);
    log(`${u.id} auto-withdrawn on sensor limits`, 'l2'); say(`${SPEC[u.type].name} ${u.id}, auto withdraw. Heat flux ${u.sens.q.toFixed(0)} kilowatts.`);
  }
  if (u.state === 'working' || u.state === 'transit'){
    const k = cellAt(u.x, u.z);
    let danger = false;
    if (k >= 0){ const ci = k % N, cj = (k / N) | 0;
      for (let dj = -3; dj <= 3 && !danger; dj++) for (let di = -3; di <= 3; di++){ const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const n = ix(i, j); if (W.state[n] === 1 && W.inten[n] > (sp.limit || 1500) * 3){ danger = true; break; } } }
    if (danger && u.type !== 'dozer'){ u.state = 'retreat'; const wv = windVec(); const rx = u.x - wv.x * 160, rz = u.z - wv.z * 160;
      u.path = routeGround(u, rx, rz) || [{ x:rx, z:rz }]; alert(2, `<b>Crew safety</b>${u.id} withdrawing: ${(maxNear(u) / 1000).toFixed(1)} MW/m fire front within 30 m`); log(`${u.id} withdrew from intense fire`, 'l2'); }
  }
  if (u.state === 'transit'){
    if (moveAlong(u, dt)){
      if (u.type === 'dozer'){ u.state = 'line'; u.path = [{ x:u.tx2 ?? u.tx, z:u.tz2 ?? u.tz }]; }
      else u.state = 'working';
    }
  } else if (u.state === 'line'){                       // bulldozer cuts a firebreak as it moves
    const k = cellAt(u.x, u.z);
    if (k >= 0) for (const [di, dj] of [[0, 0], [1, 0], [0, 1]]){ const n = k + di + dj * N; if (n >= 0 && n < NN && W.state[n] === 0 && FUEL[W.fuel[n]].burn){ W.fuel[n] = F.NONE; W.changed.add(n); } }
    if (moveAlong(u, dt)){ u.state = 'idle'; log(`${u.id} firebreak complete`, 'ok'); }
  } else if (u.state === 'working'){
    u.did += groundWork(W, u, dt);
    // chase the nearest flank within 250 m once the area is quiet
    const near = nearestBurning(W, u.x, u.z, sp.radius * 1.2);
    if (near < 0){ const k = nearestBurning(W, u.x, u.z, 250); if (k >= 0){ const tx = cx(k % N), tz = cx((k / N) | 0); const d = Math.hypot(tx - u.x, tz - u.z);
      const v = sp.speed.off; u.x += (tx - u.x) / d * Math.min(d - sp.radius * 0.6, v * dt) * (d > sp.radius * 0.6 ? 1 : 0); u.z += (tz - u.z) / d * Math.min(d - sp.radius * 0.6, v * dt) * (d > sp.radius * 0.6 ? 1 : 0); u.heading = Math.atan2(tx - u.x, tz - u.z); } }
  } else if (u.state === 'retreat'){
    if (moveAlong(u, dt)){ u.state = 'working'; }
  } else if (u.state === 'return'){
    if (moveAlong(u, dt)){ removeUnit(u); pools[u.type]++; log(`${u.id} back at station`); }
  }
  u.y = hAt(u.x, u.z);
}
function maxNear(u){ let m = 0; const k = cellAt(u.x, u.z); if (k < 0) return 0; const ci = k % N, cj = (k / N) | 0;
  for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++){ const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue; const n = ix(i, j); if (W.state[n] === 1) m = Math.max(m, W.inten[n]); } return m; }
const LAKEPT = () => ({ x:cx(LAKE.i), z:cx(LAKE.j) });
/* crew sensors in the wildfire: radiant heat from every burning cell (point source, chi_r 0.3, Q = I x cell width),
   air temperature from nearby flames, CO from the downwind smoke plumes, visibility from smoke density */
const LIMS = { T:[45, 60, 100], q:[1.6, 4.7, 10], co:[35, 200, 1200] };
const lvlOf = (v, a) => v >= a[2] ? 3 : v >= a[1] ? 2 : v >= a[0] ? 1 : 0;
function senseAt(x, z){
  let q = 0, dT = 0, co = 0;
  const wv = windVec(), r = 15, ci = Math.floor((x + HALF) / CS), cj = Math.floor((z + HALF) / CS);
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++){
    const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
    const k = ix(i, j); if (W.state[k] !== 1) continue;
    const dx = cx(i) - x, dz = cx(j) - z, d2 = dx * dx + dz * dz, L = 0.0775 * Math.pow(W.inten[k], 0.46);
    q += 0.3 * W.inten[k] * CS / (4 * Math.PI * Math.max(d2 + L * L, 16));
    const d = Math.sqrt(d2), down = d > 1 ? (dx * -wv.x + dz * -wv.z) / d : 0;     // >0 when the crew is downwind of the cell
    dT += 260 * Math.min(1, W.inten[k] / 2500) * Math.exp(-d / (10 + 8 * Math.max(0, down)));
  }
  for (const s of sources.slice(0, 16)){
    const dx = x - s.x, dz = z - s.z, xd = dx * wv.x + dz * wv.z, yc = -dx * wv.z + dz * wv.x;
    const sig = 15 + 0.22 * Math.max(0, xd);
    co += 18 * s.w * Math.exp(-(yc * yc) / (2 * sig * sig)) / (1 + Math.max(0, xd) / 40) * (xd > -30 ? 1 : 0.1);
  }
  return { T:22 + Math.min(dT, 900), q, co, vis:Math.min(2000, 3 / Math.max(1e-3, co / 500)) };
}
function readSensors(u, dt){
  const s = senseAt(u.x, u.z), k = 1 - Math.exp(-dt / 2);
  u.sens = u.sens || { T:22, q:0, co:0, vis:2000 };
  for (const key of ['T', 'q', 'co', 'vis']) u.sens[key] += (s[key] - u.sens[key]) * k;
  u.level = Math.max(lvlOf(u.sens.T, LIMS.T), lvlOf(u.sens.q, LIMS.q), lvlOf(u.sens.co, LIMS.co));
}
function flyTo(u, x, z, y, dt){
  const sp = SPEC[u.type], dx = x - u.x, dz = z - u.z, d = Math.hypot(dx, dz);
  const s = Math.min(d, sp.speed * dt); if (d > 0.01){ u.x += dx / d * s; u.z += dz / d * s; u.heading = Math.atan2(dx, dz); }
  u.y += clamp(y - u.y, -14 * dt, 14 * dt);
  return d < 6;
}
function updateAir(u, dt){
  const sp = SPEC[u.type], lake = LAKEPT();
  if (u.state === 'pattern'){ u.t0 += dt; const a = u.t0 / sp.pattern * Math.PI * 2;      // fly the circuit around the current point
    flyTo(u, u.px + Math.cos(a) * 260, u.pz + Math.sin(a) * 260, 90, dt); if (u.t0 >= sp.pattern) u.state = u.water ? 'toFire' : 'toLake'; }
  else if (u.state === 'toLake'){ if (flyTo(u, lake.x, lake.z, 6, dt)){ u.state = 'scoop'; u.t0 = 0; } }
  else if (u.state === 'scoop'){ u.t0 += dt; u.y = lerp(u.y, 3, 0.2); if (u.t0 >= sp.scoop){ u.water = sp.cap; u.state = 'pattern'; u.t0 = 0; u.px = u.x; u.pz = u.z; } }
  else if (u.state === 'toFire'){
    // approach along the wind so the drop line lies on the flank of the head fire
    if (flyTo(u, u.tx, u.tz, u.type === 'bomber' ? 35 : 25, dt)){
      const hx = Math.sin(u.heading), hz = Math.cos(u.heading);
      if (u.type === 'bomber') dropStrip(W, u.tx, u.tz, hx, hz, 120, 25, 1800, 5000);
      else dropStrip(W, u.tx, u.tz, hx, hz, 30, 25, 900, 3000);
      spawnDrop(u); u.water = 0; u.drops++; u.state = 'pattern'; u.t0 = 0; u.px = u.x; u.pz = u.z;
      // next drop: the hottest part of the active edge near the assigned target
      const k = headNear(W, u.tx, u.tz); if (k >= 0){ u.tx = cx(k % N); u.tz = cx((k / N) | 0); }
    }
  } else if (u.state === 'return'){ if (flyTo(u, AIRBASE.x, AIRBASE.z, 160, dt)){ removeUnit(u); pools[u.type]++; log(`${u.id} landed at base`); } }
}
function removeUnit(u){ scene.remove(u.mesh, u.label, u.line); units.splice(units.indexOf(u), 1); if (selUnit === u) selectUnit(null); }

// water drop curtain
const MAXD = 1500, dPos = new Float32Array(MAXD * 3), dVel = new Float32Array(MAXD * 3), dLife = new Float32Array(MAXD);
const dGeo = new THREE.BufferGeometry(); dGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3).setUsage(THREE.DynamicDrawUsage));
const drops = new THREE.Points(dGeo, new THREE.PointsMaterial({ color:0xcfe3f5, size:2.2, transparent:true, opacity:0.55, depthWrite:false }));
drops.frustumCulled = false; scene.add(drops); let dHead = 0;
function spawnDrop(u){
  const n = u.type === 'bomber' ? 500 : 160, hx = Math.sin(u.heading), hz = Math.cos(u.heading);
  for (let q = 0; q < n; q++){ const i = dHead; dHead = (dHead + 1) % MAXD; const s = (rand() - 0.5) * (u.type === 'bomber' ? 120 : 20);
    dPos[i * 3] = u.tx + hx * s + (rand() - 0.5) * 8; dPos[i * 3 + 1] = hAt(u.tx, u.tz) + 30 + rand() * 10; dPos[i * 3 + 2] = u.tz + hz * s + (rand() - 0.5) * 8;
    dVel[i * 3] = hx * 8; dVel[i * 3 + 1] = -6 - rand() * 6; dVel[i * 3 + 2] = hz * 8; dLife[i] = 3 + rand() * 2; }
}
function updateDrops(dt){
  for (let i = 0; i < MAXD; i++){ if (dLife[i] <= 0){ dPos[i * 3 + 1] = -999; continue; } dLife[i] -= dt; dVel[i * 3 + 1] -= 9.8 * dt;
    dPos[i * 3] += dVel[i * 3] * dt; dPos[i * 3 + 1] += dVel[i * 3 + 1] * dt; dPos[i * 3 + 2] += dVel[i * 3 + 2] * dt; }
  dGeo.attributes.position.needsUpdate = true;
}

/* ================================================================
   Forecast: run the fire forward with the current resources (faster than real time)
   ================================================================ */
function cloneWorld(w){
  return { t:w.t, fuel:w.fuel.slice(), state:w.state.slice(), prog:w.prog.slice(), left:w.left.slice(), inten:w.inten.slice(), wet:w.wet.slice(),
           igT:w.igT.slice(), outT:new Float32Array(NN), spots:w.spots || 0, burning:w.burning.slice(), wetList:w.wetList.slice(), burnedCount:w.burnedCount, changed:{ add(){} } };
}
function forecast(extra = null, horizon = 24 * 3600, dt = 90){
  // same random sequence for every forecast, so 'current' vs '+1 aircraft' is a fair comparison
  const liveRand = rand; rand = seeded(1234 + Math.floor(W.t / 600));
  try { return forecastRun(extra, horizon, dt); } finally { rand = liveRand; }
}
function forecastRun(extra, horizon, dt){
  const w = cloneWorld(W), t0 = w.t;
  const crews = units.filter(u => !SPEC[u.type].air && u.type !== 'dozer' && u.state !== 'return').map(u => ({ type:u.type, x:u.state === 'working' ? u.x : u.tx, z:u.state === 'working' ? u.z : u.tz, acc:0, arrive:u.state === 'working' ? 0 : (u.eta || 300) }));
  const lake = LAKEPT();
  const air = units.filter(u => SPEC[u.type].air && u.state !== 'return').map(u => ({ type:u.type, tx:u.tx, tz:u.tz, next:0 }));
  if (extra){ const p = sources[0] || { x:0, z:0 }; for (const e of extra) air.push({ type:e, tx:p.x, tz:p.z, next:Math.hypot(lake.x - AIRBASE.x, lake.z - AIRBASE.z) / SPEC[e].speed }); }
  for (const a of air){ const sp = SPEC[a.type]; a.cycle = 2 * Math.hypot(a.tx - lake.x, a.tz - lake.z) / sp.speed + sp.scoop + 2 * sp.pattern; }
  const series = []; let contained = null, out = null, village = null;
  const vil = []; for (let j = VILLAGE.j0; j <= VILLAGE.j1; j++) for (let i = VILLAGE.i0; i <= VILLAGE.i1; i++) vil.push(ix(i, j));
  let burnedArea = 0;
  for (let t = 0; t <= horizon; t += dt){
    spread(w, dt);
    for (const c of crews){ if (t < c.arrive) continue; const sp = SPEC[c.type];
      if (nearestBurning(w, c.x, c.z, sp.radius * 1.2) < 0){ const k = nearestBurning(w, c.x, c.z, 250); if (k >= 0){ const tx = cx(k % N), tz = cx((k / N) | 0), d = Math.hypot(tx - c.x, tz - c.z); const s = Math.min(Math.max(0, d - sp.radius * 0.6), sp.speed.off * dt); c.x += (tx - c.x) / d * s; c.z += (tz - c.z) / d * s; } }
      groundWork(w, c, dt); }
    for (const a of air){ if (t >= a.next){ const k = headNear(w, a.tx, a.tz); if (k >= 0){ a.tx = cx(k % N); a.tz = cx((k / N) | 0); }
      const hx = a.tx - lake.x, hz = a.tz - lake.z, L = Math.hypot(hx, hz) || 1;
      if (k >= 0) dropStrip(w, a.tx, a.tz, hx / L, hz / L, a.type === 'bomber' ? 120 : 30, 25, a.type === 'bomber' ? 1800 : 900, a.type === 'bomber' ? 5000 : 3000);
      a.next = t + a.cycle; } }
    if (village === null && vil.some(k => w.state[k] === 1)) village = t;
    if (t % 630 < dt){
      let burnt = 0; for (let k = 0; k < NN; k++) if (w.state[k]) burnt++;
      burnedArea = burnt * CS * CS / 1e4; series.push({ t:t0 + t, ha:burnedArea });
      if (contained === null && frontCells(w).length === 0) contained = t;
    }
    if (!w.burning.length){ out = t; let burnt = 0; for (let k = 0; k < NN; k++) if (w.state[k]) burnt++; burnedArea = burnt * CS * CS / 1e4; series.push({ t:t0 + t, ha:burnedArea }); if (contained === null) contained = t; break; }
  }
  return { contained, out, village, finalHa:burnedArea, series, horizon };
}

/* ================================================================
   UI
   ================================================================ */
let paused = false, speed = 60, tool = null, selUnit = null, vis = { lvl:0, html:'<b>Visor quiet</b>no active fire', until:0 }, nowT = 0, evac = { on:false, done:0 };
const history = [];
function log(text, cls = ''){ const L = $('ulog'); history.push({ t:W.t, text, cls }); }
function alert(lvl, html, secs = 12){ if (lvl >= vis.lvl || nowT > vis.until){ vis = { lvl, html, until:nowT + secs }; } }
let speakQ = [];
function say(text){ try { fetch('/api/tts', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ text }) }).then(r => r.ok ? r.blob() : null).then(b => { if (b) new Audio(URL.createObjectURL(b)).play().catch(() => {}); }); } catch {} }
function setHint(t){ const h = $('hint'); h.textContent = t || ''; h.classList.toggle('on', !!t); }
function selectUnit(u){ selUnit = u; renderUnits(true); }

function stats(){
  let burning = 0, burnt = 0, maxI = 0, villageHit = 0;
  for (const k of W.burning){ burning++; maxI = Math.max(maxI, W.inten[k]); }
  for (let k = 0; k < NN; k++) if (W.state[k] >= 2) burnt++;
  const front = frontCells(W);
  // containment: share of the active edge that has a crew, engine or wet line within reach
  let covered = 0;
  for (const k of front){ const x = cx(k % N), z = cx((k / N) | 0);
    if (units.some(u => u.state === 'working' && !SPEC[u.type].air && Math.hypot(u.x - x, u.z - z) < SPEC[u.type].radius + 10)) covered++; }
  const ha = (burning + burnt) * CS * CS / 1e4;
  return { burning, burnt, ha, maxI, front:front.length, contain:front.length ? covered / front.length : 1, perim:front.length * CS / 1000 };
}
let lastHa = 0, lastT = 0, rate = 0;
function renderFire(){
  const s = stats();
  if (W.t - lastT >= 300){ rate = (s.ha - lastHa) / ((W.t - lastT) / 3600); lastHa = s.ha; lastT = W.t; }
  const type = s.maxI > 10000 ? 'crown fire' : s.maxI > 4000 ? 'intense surface fire' : s.maxI > 500 ? 'surface fire' : s.burning ? 'smouldering' : 'none';
  $('fireNow').innerHTML = `
    <div class="kv"><span class="k">Burned</span><span class="v big">${s.ha.toFixed(1)} ha</span></div>
    <div class="kv"><span class="k">Burning now</span><span class="v ${s.burning ? 'bad' : 'ok'}">${(s.burning * CS * CS / 1e4).toFixed(1)} ha</span></div>
    <div class="kv"><span class="k">Active front</span><span class="v">${s.perim.toFixed(2)} km</span></div>
    <div class="kv"><span class="k">Spread rate</span><span class="v">${rate.toFixed(1)} ha/h</span></div>
    <div class="kv"><span class="k">Max intensity</span><span class="v ${s.maxI > 4000 ? 'bad' : ''}">${(s.maxI / 1000).toFixed(1)} MW/m · ${type}</span></div>
    <div class="kv"><span class="k">Contained</span><span class="v ${s.contain > 0.9 ? 'ok' : ''}">${Math.round(clamp(s.contain, 0, 1) * 100)} %</span></div>
    <div class="meter"><i style="width:${Math.round(clamp(s.contain, 0, 1) * 100)}%;background:var(--ok)"></i></div>
    ${W.spots ? `<div class="kv"><span class="k">Spot fires (embers)</span><span class="v bad">${W.spots}</span></div>` : ''}
    <div class="kv"><span class="k">Village</span><span class="v ${evac.on ? 'warn' : ''}">${evac.on ? `evacuating · ${Math.floor(evac.done)}/340` : '340 residents'}</span></div>`;
  return s;
}
let FC = null, FCplus = null, fcBusy = false;
function renderForecast(){
  if (!FC){ $('forecast').innerHTML = '<div class="dim">computing…</div>'; return; }
  const elapsed = W.t;
  const line = (lab, v, cls = '') => `<div class="kv"><span class="k">${lab}</span><span class="fc ${cls}">${v}</span></div>`;
  let h = '';
  if (!W.burning.length) h += line('Status', 'fire out', 'ok');
  else {
    h += line('Contained in', FC.contained === null ? '> 24 h' : fmtT(FC.contained), FC.contained === null ? 'bad' : FC.contained < 3600 ? 'ok' : 'warn');
    h += line('Fully out in', FC.out === null ? '> 24 h' : fmtT(FC.out), FC.out === null ? 'bad' : '');
    h += `<div class="kv"><span class="k">Final burned area</span><span class="v">${FC.finalHa.toFixed(0)} ha</span></div>`;
    if (FC.village !== null) h += `<div class="kv"><span class="k">Reaches the village</span><span class="v bad">in ${fmtT(FC.village)}</span></div>`;
    if (FCplus){
      const gain = (FC.contained ?? 86400) - (FCplus.contained ?? 86400);
      h += `<div class="kv"><span class="k">With +1 Canadair</span><span class="v ${gain > 0 ? 'ok' : ''}">${FCplus.contained === null ? 'still > 24 h' : `contained in ${fmtT(FCplus.contained)}`}${gain > 300 ? ` · −${fmtT(gain)}` : ''}</span></div>`;
    }
  }
  $('forecast').innerHTML = h;
}
function runForecast(){
  if (fcBusy || !W.burning.length){ if (!W.burning.length){ FC = { contained:0, out:0, village:null, finalHa:stats().ha, series:[] }; FCplus = null; } return; }
  fcBusy = true;
  setTimeout(() => {
    const t0 = performance.now();
    FC = forecast();
    FCplus = forecast(['bomber']);
    $('chartMeta').textContent = `forecast ${Math.round(performance.now() - t0)} ms`;
    fcBusy = false;
    if (FC.village !== null && FC.village < 2 * 3600 && !evac.on) alert(2, `<b>Village threat</b>fire reaches the village in ${fmtT(FC.village)} · order evacuation`, 20);
    if (FC.contained === null && units.length) alert(1, `<b>Not containable</b>with current resources · forecast says add aircraft`, 15);
  }, 0);
}
function renderPrecautions(){
  const el = $('prec'); if (!el) return;
  const row = (st, text, note = '') => `<div class="${st}"><i>${st === 'ok' ? '✓' : st === 'warn' ? '!' : '×'}</i><span>${text}</span><em>${note}</em></div>`;
  const ground = units.filter(u => !SPEC[u.type].air && u.state !== 'return');
  const crews = ground.filter(u => u.type !== 'dozer');
  const air = units.filter(u => SPEC[u.type].air && u.state !== 'return');
  // a safe cell: burnt black, cleared line, road or water, with nothing burning next to it
  const safeNear = (x, z, R) => { const ci = Math.floor((x + HALF) / CS), cj = Math.floor((z + HALF) / CS), r = Math.ceil(R / CS);
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++){ const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N || di * di + dj * dj > r * r) continue;
      const k = ix(i, j), f = W.fuel[k]; if (!(W.state[k] >= 2 || f === F.ROAD || f === F.WATER || f === F.NONE)) continue;
      let hot = false; for (const [a, b] of D8){ const n = ix(clamp(i + a, 0, N - 1), clamp(j + b, 0, N - 1)); if (W.state[n] === 1){ hot = true; break; } } if (!hot) return true; }
    return false; };
  const noEscape = crews.filter(u => !safeNear(u.x, u.z, 150));
  const noAnchor = crews.filter(u => u.state === 'working' && !safeNear(u.x, u.z, 100));
  let black = 0; for (let k = 0; k < NN; k++) if (W.state[k] >= 2) black++;
  const uphill = crews.filter(u => { const k = nearestBurning(W, u.x, u.z, 150); const c = cellAt(u.x, u.z); return k >= 0 && c >= 0 && height[c] - height[k] > 12; });
  const hot = crews.filter(u => (u.level || 0) >= 2);
  const villageSoon = FC && FC.village !== null && FC.village < 2 * 3600;
  el.innerHTML = [
    '<div class="dim" style="grid-template-columns:1fr">// LACES</div>',
    row(air.length ? 'ok' : W.burning.length ? 'warn' : 'ok', 'Lookouts', air.length ? `${air.length} aircraft observing` : 'no aerial lookout'),
    row(noAnchor.length ? 'warn' : 'ok', 'Anchor points', noAnchor.length ? `${noAnchor.map(u => u.id).join(' ')} not anchored` : crews.length ? 'all crews anchored' : 'no crews'),
    row('ok', 'Communications', 'radio + Visor link'),
    row(noEscape.length ? 'bad' : 'ok', 'Escape routes (150 m)', noEscape.length ? `${noEscape.map(u => u.id).join(' ')} cut off` : crews.length ? 'all crews' : 'no crews'),
    row('ok', 'Safety zones', `${(black * CS * CS / 1e4).toFixed(1)} ha black · road · lake`),
    '<div class="dim" style="grid-template-columns:1fr;margin-top:4px">// watch-outs</div>',
    row(env.windSpeed > 8 ? 'bad' : env.windSpeed > 5 ? 'warn' : 'ok', 'Wind', `${env.windSpeed} m/s from ${compass(env.windFrom)}`),
    row(env.moist < 8 ? 'warn' : 'ok', 'Fuel moisture', `${env.moist} % ${env.moist < 8 ? '(critical)' : ''}`),
    row(W.spots ? 'warn' : 'ok', 'Spot fires', W.spots ? `${W.spots} across the line` : 'none'),
    row(uphill.length ? 'bad' : 'ok', 'Crews above the fire', uphill.length ? `${uphill.map(u => u.id).join(' ')} uphill: fire runs upslope` : 'none'),
    row(hot.length ? 'bad' : 'ok', 'Crew exposure', hot.length ? hot.map(u => `${u.id} ${Math.round(u.sens.T)}°C ${u.sens.q.toFixed(1)} kW/m²`).join(' ') : 'all in limits'),
    row(villageSoon && !evac.on ? 'bad' : villageSoon ? 'warn' : 'ok', 'Residents', villageSoon ? (evac.on ? `evacuating ${Math.floor(evac.done)}/340` : `fire in ${fmtT(FC.village)}: evacuate`) : 'not threatened'),
  ].join('');
}
function renderPools(){
  $('pools').innerHTML = Object.entries(SPEC).map(([k, s]) => `<div class="pool"><span class="n">${s.name}</span><span class="c">${pools[k]}/${s.count}</span>
    <button class="txt ${tool === 'd:' + k ? 'hot' : ''}" data-act="tool" data-v="d:${k}" ${pools[k] ? '' : 'disabled'}>dispatch</button></div>`).join('');
}
const STATE_TXT = { pattern:'flying the circuit', transit:'en route', working:'attacking the fire', line:'cutting firebreak', idle:'line done, standing by', retreat:'withdrawing (too intense)', return:'returning', toLake:'flying to the lake', scoop:'scooping water', toFire:'flying to the fire' };
function renderUnits(force){
  $('units').innerHTML = units.length ? units.map(u => {
    const cls = u.state === 'retreat' || (u.level || 0) >= 2 ? 'r' : u.state === 'working' || u.state === 'line' || u.state === 'toFire' ? 'w' : 't';
    const tele = !SPEC[u.type].air && u.sens ? ` · ${Math.round(u.sens.T)}°C ${u.sens.q.toFixed(1)} kW/m²` : '';
    const extra = (SPEC[u.type].air ? ` · ${u.drops} drops` : u.state === 'working' ? ` · ${u.did} cells out` : u.state === 'transit' && u.path ? ` · ${Math.round(u.path.length * CS)} m` : '') + tele;
    return `<div class="unit ${selUnit === u ? 'sel' : ''}" data-act="unit" data-id="${u.id}"><i class="d ${cls}"></i><span><b>${u.id}</b> ${SPEC[u.type].name}</span><button class="txt" data-act="recall" data-id="${u.id}">recall</button><span class="st">${STATE_TXT[u.state] || u.state}${extra}</span></div>`;
  }).join('') : '<div class="dim">nothing deployed</div>';
  const c = $('ucard');
  if (selUnit){ const S_ = selUnit.sens, lv = (v, a) => ['', 'warn', 'bad', 'bad'][lvlOf(v, a)];
    const tele = S_ && !SPEC[selUnit.type].air ? `<div class="readings">
      <div class="${lv(S_.T, LIMS.T)}"><div class="k">air</div><div class="v">${Math.round(S_.T)}<small>°C</small></div></div>
      <div class="${lv(S_.q, LIMS.q)}"><div class="k">radiant heat</div><div class="v">${S_.q.toFixed(1)}<small>kW/m²</small></div></div>
      <div class="${lv(S_.co, LIMS.co)}"><div class="k">smoke (co)</div><div class="v">${Math.round(S_.co)}<small>ppm</small></div></div>
      <div class="${S_.vis < 10 ? 'bad' : ''}"><div class="k">visibility</div><div class="v">${S_.vis >= 1000 ? '>1k' : Math.round(S_.vis)}<small>m</small></div></div></div>` : '';
    c.hidden = false; c.innerHTML = `<div class="kicker">// ${selUnit.id} · ${SPEC[selUnit.type].name}</div><div>${STATE_TXT[selUnit.state] || selUnit.state}</div>${tele}
    <div class="tools"><button class="txt" data-act="retarget">new target</button><button class="txt" data-act="recall" data-id="${selUnit.id}">recall</button><button class="txt" data-act="unsel">close</button></div>`; }
  else c.hidden = true;
  for (const u of units){ u.labelEl.className = 'ulabel2' + (u.state === 'retreat' || (u.level || 0) >= 2 ? ' r' : u.state === 'working' || u.state === 'toFire' ? ' w' : '') + (selUnit === u ? ' sel' : ''); }
}
function renderVisor(){
  if (nowT > vis.until && vis.lvl){ vis = { lvl:0, html:W.burning.length ? `<b>Visor watching</b>${units.length} unit${units.length === 1 ? '' : 's'} deployed` : '<b>Visor quiet</b>no active fire', until:0 }; }
  if (!vis.lvl) vis.html = W.burning.length ? `<b>Visor watching</b>${units.length} unit${units.length === 1 ? '' : 's'} deployed · wind ${env.windSpeed} m/s from ${compass(env.windFrom)}` : '<b>Visor quiet</b>no active fire';
  $('visor').className = 'l' + vis.lvl; $('visorText').innerHTML = vis.html;
  $('vignette').classList.toggle('on', vis.lvl >= 2);
}
function drawChart(){
  const cv = $('chart'), r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(r.width * dpr)){ cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const g = cv.getContext('2d'), Wd = cv.width, Hd = cv.height; g.clearRect(0, 0, Wd, Hd);
  const actual = chartHist, fc = FC ? FC.series : [];
  const tMax = Math.max(3600, W.t, ...(fc.length ? [fc[fc.length - 1].t] : []));
  const hMax = Math.max(1, ...actual.map(p => p.ha), ...fc.map(p => p.ha)) * 1.1;
  const X = t => 40 * dpr + (t / tMax) * (Wd - 50 * dpr), Y = h => Hd - 16 * dpr - h / hMax * (Hd - 26 * dpr);
  g.font = `${10 * dpr}px IBM Plex Mono, monospace`; g.fillStyle = '#545c68';
  for (let q = 0; q <= 2; q++){ const h = hMax * q / 2; g.fillText(`${h.toFixed(0)} ha`, 0, Y(h) + 3 * dpr); }
  g.fillText(`${clock(tMax)}`, Wd - 40 * dpr, Hd - 2 * dpr);
  g.strokeStyle = 'rgba(216,220,226,.12)'; g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(Wd, Y(0)); g.stroke();
  // forecast
  if (fc.length){ g.setLineDash([5 * dpr, 4 * dpr]); g.strokeStyle = '#ff6a2b'; g.lineWidth = 1.5 * dpr; g.beginPath(); g.moveTo(X(W.t), Y(actual.length ? actual[actual.length - 1].ha : 0)); for (const p of fc) g.lineTo(X(p.t), Y(p.ha)); g.stroke(); g.setLineDash([]);
    if (FC.contained !== null){ const x = X(W.t + FC.contained); g.strokeStyle = '#9fd8c0'; g.beginPath(); g.moveTo(x, 6 * dpr); g.lineTo(x, Hd - 16 * dpr); g.stroke(); g.fillStyle = '#9fd8c0'; g.fillText('contained', x + 4 * dpr, 14 * dpr); } }
  // actual
  g.strokeStyle = '#d8dce2'; g.lineWidth = 2 * dpr; g.beginPath(); actual.forEach((p, i) => i ? g.lineTo(X(p.t), Y(p.ha)) : g.moveTo(X(p.t), Y(p.ha))); g.stroke();
  g.fillStyle = '#d8dce2'; g.fillText('now', X(W.t) - 10 * dpr, Hd - 2 * dpr);
}
const chartHist = [{ t:0, ha:0 }];

/* ---------------- input ---------------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let down = null, pending = null;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return; down = null;
  const r = renderer.domElement.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ndc, camera); const hit = ray.intersectObject(terrain)[0]; if (!hit) return;
  const { x, z } = hit.point, k = cellAt(x, z); if (k < 0) return;
  if (tool === 'ignite'){ ignite(W, k, 0.05); log(`Ignition at ${Math.round(x)}, ${Math.round(z)}`, 'l2'); if (!running0) running0 = true; FC = null; runForecast(); return; }
  if (tool && tool.startsWith('d:')){
    const type = tool.slice(2);
    if (type === 'dozer' && !pending){ pending = { x, z }; setHint('Bulldozer: now click where the firebreak should end · Esc cancels'); return; }
    if (type === 'dozer'){ dispatch('dozer', pending.x, pending.z, x, z); pending = null; }
    else dispatch(type, x, z);
    tool = null; setHint(''); renderPools(); runForecast(); return;
  }
  if (tool === 'retarget' && selUnit){
    const u = selUnit; u.tx = x; u.tz = z;
    if (SPEC[u.type].air){ if (u.state !== 'scoop') u.state = u.water ? 'toFire' : 'toLake'; }
    else { u.state = 'transit'; u.path = routeGround(u, x, z) || [{ x, z }]; }
    log(`${u.id} retargeted`); tool = null; setHint(''); runForecast(); return;
  }
});
addEventListener('keydown', e => { if (e.key === 'Escape'){ tool = null; pending = null; setHint(''); renderPools(); } if (e.key === ' '){ e.preventDefault(); paused = !paused; } });
document.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-act]'); if (!el || e.button !== 0 || el.disabled) return; e.preventDefault();
  const a = el.dataset.act, v = el.dataset.v;
  if (a === 'play') paused = !paused;
  else if (a === 'speed') speed = +v;
  else if (a === 'tool'){ tool = tool === v ? null : v; pending = null;
    setHint(tool === 'ignite' ? 'Click the map to start a fire · Esc cancels' : tool ? `${SPEC[tool.slice(2)].name}: click the map where it should go · Esc cancels` : ''); renderPools(); }
  else if (a === 'recall'){ const u = units.find(u => u.id === el.dataset.id); if (u) recall(u); }
  else if (a === 'unit') selectUnit(units.find(u => u.id === el.dataset.id));
  else if (a === 'unsel') selectUnit(null);
  else if (a === 'retarget'){ tool = 'retarget'; setHint(`${selUnit.id}: click the new target · Esc cancels`); }
  else if (a === 'evacuate'){ if (!evac.on){ evac.on = true; log('Village evacuation ordered', 'l1'); say('Village evacuation ordered. Three hundred forty residents.'); } }
  else if (a === 'reset') location.reload();
  else if (a === 'visor'){}
  document.querySelectorAll('#speedSeg button').forEach(b => b.classList.toggle('on', +b.dataset.v === speed));
  $('playLbl').textContent = paused ? 'play' : 'pause';
  renderUnits(true);
});
const wxBind = (id, key, fmt) => { const el = $(id); const f = () => { env[key] = +el.value; $(id + 'V').textContent = fmt(env[key]); flameMat.uniforms.uWind.value.set(windVec().x * env.windSpeed / 6, windVec().z * env.windSpeed / 6); }; el.addEventListener('input', () => { f(); FC = null; runForecast(); }); f(); };
wxBind('wDir', 'windFrom', v => compass(v)); wxBind('wSpd', 'windSpeed', v => `${v} m/s`); wxBind('moist', 'moist', v => `${v} %`);

/* ---------------- boot scenario ---------------- */
let running0 = true;
for (const [i, j] of [[96, 55], [97, 55], [96, 56]]) ignite(W, ix(i, j), 0.05);
log('Smoke reported in the east forest; 3 cells burning', 'l1');
alert(1, '<b>New fire</b>east forest · wind pushing it west toward the village', 15);

function resize(){
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h); composer.setSize(w, h); labelR.setSize(w, h); bloom.resolution.set(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix(); uScale.value = renderer.getPixelRatio() * h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
addEventListener('resize', resize); resize();

/* ---------------- loop ---------------- */
const cooling = new Set(); let coolAcc = 0;
const clk = new THREE.Clock(); let acc = 0, uiAcc = 1, fcAcc = 8, histAcc = 0;
function frame(){
  const dt = Math.min(clk.getDelta(), 0.05); nowT += dt; uTime.value = nowT;
  if (!paused){
    let sdt = dt * speed;
    while (sdt > 0){
      const h = Math.min(sdt, 5);
      spread(W, h);
      for (const u of [...units]){ if (SPEC[u.type].air) updateAir(u, h); else updateGround(u, h); }
      if (evac.on) evac.done = Math.min(340, evac.done + h * 0.25);
      sdt -= h;
    }
    histAcc += dt * speed; if (histAcc >= 120){ histAcc = 0; chartHist.push({ t:W.t, ha:stats().ha }); }
  }
  // repaint changed cells
  if (W.changed.size){ for (const k of W.changed){ paintCell(k); paintTrees(k); if (W.state[k] === 2) cooling.add(k); } W.changed.clear(); colorTex.needsUpdate = glowTex.needsUpdate = true; }
  // burnt ground smoulders, then cools to black
  coolAcc += dt; if (coolAcc > 0.4 && cooling.size){ coolAcc = 0; for (const k of cooling){ paintCell(k); if (W.t - W.outT[k] > 900) cooling.delete(k); } glowTex.needsUpdate = colorTex.needsUpdate = true; }
  rebuildFlames(); computeSources(); updateSmoke(dt * Math.min(speed, 20) / 4); updateDrops(dt);
  // fire lights on the three biggest fire blocks
  fireLights.forEach((L, i) => { const s = sources[i]; if (s){ L.position.set(s.x, s.y + 25, s.z); L.intensity = (2500 + Math.min(s.w, 150) * 110) * (0.85 + 0.15 * Math.sin(nowT * 11 + i * 2) + 0.1 * Math.sin(nowT * 23 + i)); } else L.intensity = 0; });
  // units
  for (const u of units){
    u.mesh.position.set(u.x, (SPEC[u.type].air ? u.y + hAt(u.x, u.z) * 0 : u.y), u.z);
    if (SPEC[u.type].air) u.mesh.position.y = Math.max(u.y, hAt(u.x, u.z) + 3);
    u.mesh.rotation.y = u.heading;
    if (u.mesh.userData.rotor) u.mesh.userData.rotor.rotation.y += dt * 30;
    u.label.position.set(u.x, u.mesh.position.y + (SPEC[u.type].air ? 14 : 9), u.z);
    const tgt = u.state === 'return' ? null : { x:u.tx, z:u.tz };
    if (tgt && (u === selUnit || u.state === 'transit')){ u.line.visible = true; u.line.geometry.setFromPoints([new THREE.Vector3(u.x, u.mesh.position.y + 2, u.z), new THREE.Vector3(tgt.x, hAt(tgt.x, tgt.z) + 2, tgt.z)]); u.line.computeLineDistances(); }
    else u.line.visible = false;
  }
  for (const h of houses){ if (W.state[h.k] === 1 && !h.lit){ h.lit = true; h.g.children[0].material = h.g.children[0].material.clone(); h.g.children[0].material.emissive.setHex(0xff5010); h.g.children[0].material.emissiveIntensity = 0.6; } else if (W.state[h.k] >= 2 && !h.burnt){ h.burnt = true; h.g.scale.y = 0.55; h.g.children.forEach(c => { c.material = c.material.clone(); c.material.color.setHex(0x1a1816); c.material.emissiveIntensity = 0; }); } }
  uiAcc += dt; fcAcc += dt;
  if (uiAcc > 0.3){ uiAcc = 0; $('clock').textContent = clock(W.t); renderFire(); renderForecast(); renderUnits(); renderPools(); renderVisor(); renderPrecautions(); drawChart(); }
  if (fcAcc > 6 && !paused){ fcAcc = 0; runForecast(); }
  controls.update(); composer.render(); labelR.render(scene, camera);
  requestAnimationFrame(frame);
}
document.fonts.ready.then(() => setTimeout(() => $('loader').classList.add('done'), 600));
runForecast();
requestAnimationFrame(frame);
window.__forest = { W, env, units, pools, forecast, stats, dispatch, setSpeed:v => { speed = v; }, getFC:() => FC, cx, scene, trees, smoke, flames, terrain, moon, fireLights, renderer, bloom };
