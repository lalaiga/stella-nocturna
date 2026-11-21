import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ================================================================
   Constants, limits, helpers
   ================================================================ */
const HALF = 80, CELLS = 10, CELL = 16, NAV = 40, NAVC = 4;
const COLS = 'ABCDEFGHIJ';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = Math.random;
function hash1(n){ const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function noise1(x){ const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash1(i), hash1(i + 1), u); }

// Exposure limits (crew in structural PPE + SCBA). Values: [advisory, warning, critical]
const LIM = {
  T:   { v:[45, 60, 100],      label:'Air temp',   unit:'°C',    why:['heat-stress limit', 'short-exposure limit in PPE', 'untenable for crews'] },
  q:   { v:[1.6, 4.7, 10],     label:'Heat flux',  unit:'kW/m²', why:['routine PPE limit', 'short-exposure limit for firefighters', 'emergency only (≈1 min)'] },
  co2: { v:[5000, 30000, 40000], label:'CO₂',      unit:'ppm',   why:['8-h exposure limit', '15-min limit (STEL)', 'IDLH'] },
  co:  { v:[35, 200, 1200],    label:'Smoke (CO)', unit:'ppm',   why:['8-h exposure limit', 'ceiling limit', 'IDLH'] },
};
const DRONE_T = [45, 60, 80]; // airframe / battery limits
const LVL_NAME = ['Safe', 'Advisory', 'Warning', 'Critical'];
const lvlOf = (v, arr) => v >= arr[2] ? 3 : v >= arr[1] ? 2 : v >= arr[0] ? 1 : 0;

const sim = { t:0, speed:5, paused:false, windSpeed:4, windFrom:135, growth:1, autoWithdraw:true };
const WV = { x:0, z:0 };
function updateWind(){ const th = sim.windFrom * Math.PI / 180; WV.x = -Math.sin(th); WV.z = Math.cos(th); } // direction the wind blows TO
updateWind();
const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];
const compass = deg => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

const cellName = (c, r) => COLS[c] + (r + 1);
const cellOf = (x, z) => [clamp(Math.floor((x + HALF) / CELL), 0, CELLS - 1), clamp(Math.floor((z + HALF) / CELL), 0, CELLS - 1)];
const cellNameAt = (x, z) => { const [c, r] = cellOf(x, z); return cellName(c, r); };
const cellCenter = name => { const m = /^([A-Ja-j])\s*(10|[1-9])$/.exec(String(name).trim()); if (!m) return null;
  return { x:-HALF + (m[1].toUpperCase().charCodeAt(0) - 65) * CELL + CELL / 2, z:-HALF + (+m[2] - 1) * CELL + CELL / 2 }; };

/* Shared registry + event bus: other modules (interior, planner, fusion, voice, ui) plug in here */
const S = { clock:0, visorEvent:null, logs:[], hooks:{ step:[], drone:{}, ground:{}, arrive:{} } };
const bus = new EventTarget();
const emitEv = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
const onEv = (type, fn) => bus.addEventListener(type, e => fn(e.detail));
function addLog(text, cls = '', say = null){
  S.logs.unshift({ t:sim.t, text, cls }); if (S.logs.length > 80) S.logs.pop();
  emitEv('log', { text, cls });
  if (say) emitEv('say', { text:say, prio:cls === 'l3' || cls === 'l2' ? 2 : 1 });
}
function setVisorEvent(html, secs = 8, say = null){ S.visorEvent = { html, until:S.clock + secs }; if (say) emitEv('say', { text:say, prio:2 }); }
const fmt = {
  T: v => `${Math.round(v)}°C`, q: v => `${v < 10 ? v.toFixed(1) : Math.round(v)} kW/m²`,
  co2: v => `${Math.round(v).toLocaleString('en-US')} ppm`, co: v => `${Math.round(v).toLocaleString('en-US')} ppm`,
  vis: v => v >= 1000 ? '>1 km' : `${v < 10 ? v.toFixed(1) : Math.round(v)} m`,
};
const tplus = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/* ================================================================
   Renderer, scene, camera, post-processing
   ================================================================ */
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels';
stage.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ee);
scene.fog = new THREE.FogExp2(0xdfe6ee, 0.0032);   // misty night: depth through fog, fire is the only warm light

const camera = new THREE.PerspectiveCamera(46, 1, 0.5, 1500);
camera.position.set(-92, 78, 92);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, -14);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.maxPolarAngle = 1.45; controls.minDistance = 18; controls.maxDistance = 320;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.25, 0.4, 1.2);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const uScale = { value: 800 };     // point-size projection factor, shared by all particle materials
const uTime = { value: 0 };

/* ================================================================
   Lights & environment
   ================================================================ */
scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x8a8172, 1.6));
const moon = new THREE.DirectionalLight(0xfff3e0, 2.4);   // sun
moon.position.set(-90, 140, 70);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
Object.assign(moon.shadow.camera, { left:-110, right:110, top:110, bottom:-110, near:10, far:420 });
moon.shadow.bias = -0.0005; moon.shadow.normalBias = 0.03;
scene.add(moon);

// Pool of fire lights (fixed light count => no shader recompiles when fire spreads)
const lightPool = [0, 1, 2].map(i => {
  const L = new THREE.PointLight(0xff7a2e, 0, 100, 2);
  if (i < 1){                       // only the primary fire light casts (cube) shadows
    L.castShadow = true;
    L.shadow.mapSize.set(1024, 1024);
    L.shadow.camera.near = 0.5; L.shadow.camera.far = 150;
    L.shadow.bias = -0.002;
  }
  L.position.set(0, -60, 0);
  scene.add(L);
  return L;
});

// Ground
const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshStandardMaterial({ color:0x9aa08f, roughness:1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const pad = new THREE.Mesh(new THREE.PlaneGeometry(168, 168), new THREE.MeshStandardMaterial({ color:0xb4b8bc, roughness:0.95 }));
pad.rotation.x = -Math.PI / 2; pad.position.y = 0.01; pad.receiveShadow = true; scene.add(pad);
function flat(w, d, x, z, color, y = 0.025){
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color, roughness:0.9 }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true; scene.add(m); return m;
}
flat(168, 8, 0, 20, 0x5c6066); flat(8, 168, -30, 0, 0x5c6066); flat(60, 8, -110, 20, 0x161a20, 0.02); // roads + access road
flat(14, 34, -70, 26, 0x1d2a2c); // staging pad
flat(10, 10, -66, 66, 0x1d2a2c); // muster
// Road markings
for (let x = -78; x < 80; x += 8) flat(3, 0.3, x, 20, 0x3a4250, 0.03);
// Fence
{
  const pts = [[-82,-82],[82,-82],[82,82],[-82,82],[-82,-82]].map(([x, z]) => new THREE.Vector3(x, 1.4, z));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color:0x3b4656 })));
}
// Stars
{
  const n = 900, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++){
    const th = rand() * Math.PI * 2, ph = rand() * 1.2;
    p[i*3] = Math.cos(th) * Math.sin(ph) * 600; p[i*3+1] = Math.cos(ph) * 600 + 40; p[i*3+2] = Math.sin(th) * Math.sin(ph) * 600;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color:0x9fb3d1, size:1.2, sizeAttenuation:false, fog:false })));
}

function windowTex(rx, ry){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++){
    if (rand() < 0.45){ g.fillStyle = `rgba(255,${205 + rand() * 40 | 0},${140 + rand() * 60 | 0},${0.45 + rand() * 0.4})`; g.fillRect(x * 32 + 6, y * 32 + 12, 20, 9); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); return t;
}
function label3D(text, x, y, z, cls = 'alabel'){
  const el = document.createElement('div'); el.className = cls; el.textContent = text;
  const o = new CSS2DObject(el); o.position.set(x, y, z); scene.add(o); return o;
}

/* ================================================================
   Site: buildings, tanks, drum yard (assets used by sim + explanations)
   ================================================================ */
const ASSETS = [];
function building(o){
  const { x, z, w, d, h, color, lit = 0.25 } = o; const _lit = lit * 0.15;
  const side = (rx) => new THREE.MeshStandardMaterial({ color, roughness:0.85, metalness:0.05, emissive:0xffffff, emissiveMap:windowTex(rx, Math.max(1, Math.round(h / 12))), emissiveIntensity:_lit });
  const plain = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.8), roughness:0.9 });
  const mats = [side(Math.max(1, Math.round(d / 9))), side(Math.max(1, Math.round(d / 9))), plain, plain, side(Math.max(1, Math.round(w / 9))), side(Math.max(1, Math.round(w / 9)))];
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
  m.position.set(x, h / 2, z); m.castShadow = m.receiveShadow = true; scene.add(m);
  const trim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.5, d + 0.4), new THREE.MeshStandardMaterial({ color:0x2a313c, roughness:0.8 }));
  trim.position.set(x, h + 0.25, z); trim.castShadow = true; scene.add(trim);
  const lab = label3D(o.short || o.id, x, h + 2, z);
  const a = { ...o, type:'box', minX:x - w / 2, maxX:x + w / 2, minZ:z - d / 2, maxZ:z + d / 2, dose:0, burning:false, cooled:false, mesh:m, trim, labelObj:lab };
  ASSETS.push(a); return a;
}
function tank(o){
  const { x, z, r = 5, h = 11 } = o;
  const metal = new THREE.MeshStandardMaterial({ color:0xaab3bd, roughness:0.38, metalness:0.65 });
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 40), metal);
  m.position.set(x, h / 2, z); m.castShadow = m.receiveShadow = true; scene.add(m);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(r * 1.02, 1.2, 40), metal); roof.position.set(x, h + 0.6, z); roof.castShadow = true; scene.add(roof);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.01, r * 1.01, 0.7, 40), new THREE.MeshStandardMaterial({ color:0x8f1d1d, roughness:0.6 }));
  band.position.set(x, h * 0.72, z); scene.add(band);
  label3D(o.id, x, h + 3, z);
  const a = { ...o, type:'tank', r, minX:x - r, maxX:x + r, minZ:z - r, maxZ:z + r, dose:0, burning:false };
  ASSETS.push(a); return a;
}

const W1 = building({ id:'W1', short:'W-1', name:'Warehouse W-1', desc:'oxidisers & resins', x:-16, z:-34, w:18, d:14, h:9, color:0x58606d, lit:0.12,
  fuel:true, ign:{ x:-7, y:3, z:-30 }, doseMax:900, fire:{ x:-13, y:9.3, z:-32 }, Qmax:70000 });
building({ id:'P1', short:'P-1', name:'Process unit P-1', desc:'reactor hall', x:14, z:2, w:20, d:16, h:14, color:0x4b5461, lit:0.35 });
building({ id:'A1', short:'Admin', name:'Admin block', desc:'18 staff on shift', x:-48, z:50, w:26, d:12, h:11, color:0x667080, lit:1.0 });
building({ id:'L1', short:'Loading bay', name:'Loading bay', desc:'tanker loading', x:46, z:46, w:22, d:14, h:7, color:0x4f5765, lit:0.2 });
building({ id:'C1', short:'Control', name:'Control room', desc:'site control', x:-44, z:-4, w:12, d:10, h:6, color:0x6b7686, lit:1.0 });
const tankDefs = [['T1', 30, -48, 'methanol'], ['T2', 46, -48, 'toluene'], ['T3', 62, -48, 'acetone'], ['T4', 30, -64, 'methanol'], ['T5', 46, -64, 'ethanol'], ['T6', 62, -64, 'xylene']];
for (const [id, x, z, c] of tankDefs) tank({ id, name:`Tank ${id.replace('T', 'T-')}`, desc:`${c}, 400 m³`, x, z });
// Distillation columns + stack
for (const [x, z, r, h] of [[27, -6, 1.3, 24], [27, 1, 1.1, 20]]){
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), new THREE.MeshStandardMaterial({ color:0x9aa3ad, metalness:0.6, roughness:0.4 }));
  m.position.set(x, h / 2, z); m.castShadow = true; scene.add(m);
  ASSETS.push({ id:'COL', name:'Distillation column', desc:'', type:'tank', x, z, r, minX:x - r, maxX:x + r, minZ:z - r, maxZ:z + r, hidden:true });
}
const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 32, 20), new THREE.MeshStandardMaterial({ color:0x8a8f96, roughness:0.7 }));
stack.position.set(6, 16, 8); stack.castShadow = true; scene.add(stack);
const obstacleLight = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8), new THREE.MeshBasicMaterial({ color:0xff2020 }));
obstacleLight.position.set(6, 32.4, 8); scene.add(obstacleLight);
// Pipe rack P-1 -> tank farm
{
  const pm = new THREE.MeshStandardMaterial({ color:0x6d7884, metalness:0.5, roughness:0.5 });
  for (const dx of [-0.8, 0, 0.8]){
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 34, 10), pm);
    p.rotation.x = Math.PI / 2; p.position.set(34 + dx, 4.2, -23); p.castShadow = true; scene.add(p);
  }
  for (let z = -40; z <= -6; z += 6){ const s = new THREE.Mesh(new THREE.BoxGeometry(3, 4, 0.4), pm); s.position.set(34, 2, z); s.castShadow = true; scene.add(s); }
}
// Bund wall around tank farm
{
  const bm = new THREE.MeshStandardMaterial({ color:0x39404b, roughness:0.9 });
  for (const [w, d, x, z] of [[50, 0.6, 46, -40], [50, 0.6, 46, -72], [0.6, 32, 21, -56], [0.6, 32, 71, -56]]){
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, d), bm); b.position.set(x, 0.6, z); b.castShadow = b.receiveShadow = true; scene.add(b);
  }
}
// Drum yard D-1 (fire origin)
const DRUM = { id:'DY', name:'Drum yard D-1', desc:'solvent drums', type:'yard', x:4, z:-28, minX:-2, maxX:10, minZ:-33, maxZ:-23 };
ASSETS.push(DRUM);
{
  const geo = new THREE.CylinderGeometry(0.42, 0.42, 0.95, 14);
  const mat = new THREE.MeshStandardMaterial({ roughness:0.5, metalness:0.4 });
  const inst = new THREE.InstancedMesh(geo, mat, 54);
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  let k = 0;
  for (let i = 0; i < 9; i++) for (let j = 0; j < 6; j++){
    m4.makeTranslation(DRUM.x - 5.2 + i * 1.3 + (rand() - 0.5) * 0.2, 0.48, DRUM.z - 3.3 + j * 1.3 + (rand() - 0.5) * 0.2);
    inst.setMatrixAt(k, m4); inst.setColorAt(k, col.set(rand() < 0.6 ? 0x234f9e : 0xc29a1e)); k++;
  }
  inst.castShadow = inst.receiveShadow = true; scene.add(inst);
  label3D('Drum yard D-1', DRUM.x + 4, 0.6, DRUM.z + 9);
}
// Trucks at loading bay
for (const x of [40, 52]){
  const t = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3, 9), new THREE.MeshStandardMaterial({ color:0xc9ced6, roughness:0.5, metalness:0.3 }));
  t.position.set(x, 1.7, 34); t.castShadow = true; scene.add(t);
  ASSETS.push({ id:'TR', name:'Parked tanker', desc:'', type:'box', hidden:true, x, z:34, minX:x - 1.3, maxX:x + 1.3, minZ:29.5, maxZ:38.5 });
}
// Drain (hazmat target)
const DRAIN = { x:-14, z:-12 };
flat(2.4, 2.4, DRAIN.x, DRAIN.z, 0x050607, 0.035);
label3D('Drain', DRAIN.x, 1.5, DRAIN.z);
label3D('Staging', -70, 1.5, 44, 'alabel'); label3D('Muster', -66, 1.5, 72, 'alabel');
// Grid labels
const gridLabels = [];   // shown only while the grid is revealed
for (let c = 0; c < CELLS; c++) gridLabels.push(label3D(COLS[c], -HALF + c * CELL + CELL / 2, 0.5, -HALF - 4, 'glabel'));
for (let r = 0; r < CELLS; r++) gridLabels.push(label3D(String(r + 1), -HALF - 4, 0.5, -HALF + r * CELL + CELL / 2, 'glabel'));
gridLabels.forEach(l => l.visible = false);

/* ================================================================
   Particle system (CPU-simulated, GPU billboarded soft sprites)
   ================================================================ */
const PV = /* glsl */`
attribute float aAge; attribute float aSize; attribute float aSeed;
uniform float uScale, uGrow, uShrink, uMinPx;
varying float vAge; varying float vSeed;
void main(){
  vAge = aAge; vSeed = aSeed;
  if (aAge < 0.0){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = aSize * (1.0 + uGrow * aAge) * (1.0 - uShrink * aAge) * (0.45 + 0.55 * smoothstep(0.0, 0.12, aAge));
  gl_PointSize = max(uMinPx, s * uScale / max(-mv.z, 0.1));
}`;
const FLAME_FS = /* glsl */`
uniform float uTime, uHeat;
varying float vAge; varying float vSeed;
vec3 ramp(float t){
  vec3 c0 = vec3(1.00, 0.97, 0.86);   // white-yellow core
  vec3 c1 = vec3(1.00, 0.82, 0.34);   // yellow
  vec3 c2 = vec3(1.00, 0.46, 0.08);   // vibrant orange
  vec3 c3 = vec3(0.70, 0.09, 0.02);   // deep red
  vec3 c4 = vec3(0.14, 0.05, 0.04);   // charred, about to become smoke
  vec3 c = mix(c0, c1, smoothstep(0.00, 0.16, t));
  c = mix(c, c2, smoothstep(0.14, 0.40, t));
  c = mix(c, c3, smoothstep(0.38, 0.70, t));
  c = mix(c, c4, smoothstep(0.68, 1.00, t));
  return c;
}
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;                                                           // +y up
  p.x += 0.22 * sin(p.y * 3.2 + uTime * 9.0 + vSeed * 30.0) * (0.5 + 0.5 * p.y);   // licking, wavy edge
  p.x *= 1.35 + 0.9 * max(p.y, 0.0);                                    // teardrop: wide base, pointed tip
  p.y = p.y * 0.85 + 0.12;
  float r = length(p);
  if (r > 1.0) discard;
  float soft = pow(1.0 - r, 1.5);
  float n = 0.7 + 0.3 * sin(p.x * 5.0 + vSeed * 20.0 + uTime * 7.0) * sin(p.y * 4.0 - uTime * 6.0 + vSeed * 9.0);
  float fade = smoothstep(0.0, 0.06, vAge) * (1.0 - smoothstep(0.62, 1.0, vAge));
  vec3 col = pow(ramp(vAge), vec3(1.8));
  float hdr = (0.75 + 1.35 * smoothstep(0.1, 0.55, vAge)) * uHeat;  // keep the orange/red tongues luminous
  float base = mix(0.3, 1.0, smoothstep(0.0, 0.3, vAge));         // the dense base would saturate otherwise
  gl_FragColor = vec4(col * hdr, soft * n * fade * 0.4 * base);
}`;
const SMOKE_FS = /* glsl */`
uniform float uTime, uDensity, uGlow;
varying float vAge; varying float vSeed;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float soft = 1.0 - smoothstep(0.0, 1.0, r); soft *= soft;
  float n = 0.72 + 0.28 * sin(p.x * 3.0 + vSeed * 30.0 + uTime * 0.7) * sin(p.y * 3.0 + vSeed * 17.0 - uTime * 0.5);
  vec3 col = mix(vec3(0.16, 0.15, 0.14), vec3(0.06, 0.06, 0.068), smoothstep(0.1, 0.8, vAge));
  col += vec3(0.85, 0.30, 0.07) * uGlow * 0.55 * (1.0 - smoothstep(0.0, 0.28, vAge));   // under-lit by the flames
  float fade = smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge));
  gl_FragColor = vec4(col, soft * n * fade * uDensity);
}`;
const EMBER_FS = /* glsl */`
uniform float uTime;
varying float vAge; varying float vSeed;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float core = exp(-r * r * 5.0);
  float tw = 0.6 + 0.4 * sin(uTime * (14.0 + vSeed * 10.0) + vSeed * 40.0);
  vec3 col = mix(vec3(4.0, 2.2, 0.7), vec3(2.2, 0.45, 0.08), smoothstep(0.0, 0.7, vAge));
  gl_FragColor = vec4(col * tw, core * (1.0 - smoothstep(0.65, 1.0, vAge)));
}`;
const SPRAY_FS = /* glsl */`
varying float vAge; varying float vSeed;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float s = pow(1.0 - r, 2.0);
  float fade = smoothstep(0.0, 0.1, vAge) * (1.0 - smoothstep(0.7, 1.0, vAge));
  gl_FragColor = vec4(vec3(0.78, 0.88, 0.97), s * fade * 0.55);
}`;
function pMat(frag, extra = {}, blending = THREE.AdditiveBlending, opts = {}){
  return new THREE.ShaderMaterial({
    uniforms: { uScale, uTime, uGrow:{ value:opts.grow || 0 }, uShrink:{ value:opts.shrink || 0 }, uMinPx:{ value:opts.minPx || 0 }, ...extra },
    vertexShader: PV, fragmentShader: frag, transparent:true, depthWrite:false, blending,
  });
}
function makeLayer(n, material, order){
  const g = new THREE.BufferGeometry();
  const L = { n, pos:new Float32Array(n * 3), vel:new Float32Array(n * 3), age:new Float32Array(n).fill(-1), size:new Float32Array(n),
              seed:new Float32Array(n), life:new Float32Array(n), t:new Float32Array(n), head:0, acc:0, g };
  for (let i = 0; i < n; i++) L.seed[i] = rand();
  g.setAttribute('position', new THREE.BufferAttribute(L.pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aAge', new THREE.BufferAttribute(L.age, 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aSize', new THREE.BufferAttribute(L.size, 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aSeed', new THREE.BufferAttribute(L.seed, 1));
  L.pts = new THREE.Points(g, material); L.pts.frustumCulled = false; L.pts.renderOrder = order;
  scene.add(L.pts);
  return L;
}
function emit(L, rate, dt, init){
  L.acc += rate * dt;
  let n = Math.min(Math.floor(L.acc), L.n >> 2); L.acc -= Math.floor(L.acc);
  while (n-- > 0){ const i = L.head; L.head = (L.head + 1) % L.n; L.age[i] = 0; L.t[i] = 0; init(i, i * 3); }
}
function stepLayer(L, dt, fn){
  const A = L.age, T = L.t, LF = L.life;
  for (let i = 0; i < L.n; i++){
    if (A[i] < 0) continue;
    T[i] += dt; const a = T[i] / LF[i];
    if (a >= 1){ A[i] = -1; continue; }
    A[i] = a; fn(i, a, i * 3, L.pos, L.vel);
  }
  const at = L.g.attributes; at.position.needsUpdate = at.aAge.needsUpdate = at.aSize.needsUpdate = true;
}
// Divergence-free (curl) turbulence: curl of a two-octave trigonometric vector potential
const C = [0, 0, 0];
function curl(x, y, z, t, o){
  const a1 = Math.cos(x + y + t * 0.7), a2 = Math.cos(z + x + t * 1.1 + 1.3), a3 = Math.cos(y + z + t * 0.9 + 2.1);
  const X = x * 2.3 + 5.2, Y = y * 2.3 + 1.7, Z = z * 2.3 + 9.1, T = t * 1.6;
  const b1 = Math.cos(X - Y + T), b2 = Math.cos(Z - X + T * 1.3 + 0.5), b3 = Math.cos(Y - Z + T * 0.8 + 2.4);
  o[0] = 0.5 * ((a1 - a2) + 0.6 * (-b1 - b2));
  o[1] = 0.5 * ((a3 - a1) + 0.6 * (-b3 - b1));
  o[2] = 0.5 * ((a2 - a3) + 0.6 * (-b2 - b3));
}

const GLOW_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const GLOW_FS = `uniform float uAmt; varying vec2 vUv;
void main(){ float r = length(vUv - 0.5) * 2.0; float g = pow(max(0.0, 1.0 - r), 2.2) * uAmt; gl_FragColor = vec4(vec3(1.0, 0.33, 0.07) * g * 1.4, g); }`;

/* ================================================================
   Fire: physics state + visual layers + flickering light
   ================================================================ */
const fires = [];
class Fire {
  constructor(o){
    Object.assign(this, { I:0.12, fuel:1, out:false, Qmax:50000, R0:1.2, Rk:2.3, baseY:0, burnTime:3600, suppress:0, seed:rand() * 100, flick:1, born:sim.t }, o);
    this.Ieff = this.I;
    this.flames = makeLayer(1000, pMat(FLAME_FS, { uHeat:{ value:1 } }, THREE.AdditiveBlending, { shrink:0.45 }), 2);
    this.smoke  = makeLayer(800,  pMat(SMOKE_FS, { uDensity:{ value:0.5 }, uGlow:{ value:1 } }, THREE.NormalBlending, { grow:2.4 }), 1);
    this.embers = makeLayer(320,  pMat(EMBER_FS, {}, THREE.AdditiveBlending, { shrink:0.4, minPx:1.6 }), 3);
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms:{ uAmt:{ value:0 } }, vertexShader:GLOW_VS, fragmentShader:GLOW_FS, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending }));
    this.glow.rotation.x = -Math.PI / 2; this.glow.position.set(this.x, this.baseY + 0.07, this.z); this.glow.renderOrder = 0; scene.add(this.glow);
  }
  get R(){ return this.R0 + this.Rk * this.Ieff; }                        // pool radius (m)
  get Q(){ return this.Qmax * this.Ieff; }                                // heat release rate (kW)
  get H(){ const Q = this.Q; if (Q < 100) return 0; return Math.max(1.5, 0.235 * Math.pow(Q, 0.4) - 1.02 * 2 * this.R); } // Heskestad flame height (m)
  get active(){ return !this.out && this.Ieff > 0.01; }
  // radiating centre, tilted downwind by the wind
  center(){ const lean = sim.windSpeed * 0.07 * this.H * 0.5; return { x:this.x + WV.x * lean, z:this.z + WV.z * lean, y:this.baseY + this.H * 0.5 }; }

  simStep(dt){
    if (this.out) return;
    const k = 0.0078 * sim.growth * (1 + 0.04 * sim.windSpeed) * (0.4 + 0.6 * this.fuel);
    let dI = k * this.I * (1 - this.I) - this.suppress * 0.0032;
    if (this.fuel <= 0) dI -= 0.002;
    this.I = clamp(this.I + dI * dt, 0, 1);
    this.fuel = Math.max(0, this.fuel - this.I * dt / this.burnTime);
    if (this.I < 0.015){ this.out = true; this.I = 0; addLog(`${this.name} fire extinguished`, 'ok', `${this.name}, fire knocked down.`); onFireOut(this); }
  }

  visualStep(dt, time){
    const u = sim.windSpeed;
    this.flick = 1 + 0.07 * Math.sin(time * 1.3 + this.seed) + 0.10 * (noise1(time * 0.7 + this.seed) - 0.5);
    this.Ieff = this.out ? Math.max(0, this.Ieff - dt * 0.4) : clamp(this.I * this.flick, 0, 1.05);
    const I = this.Ieff, R = this.R, H = this.H, by = this.visBaseY ?? this.baseY, fx = this.x, fz = this.z, live = I > 0.01 ? 1 : 0, lean = u * 0.07;

    // --- Flames: additive, white core -> orange -> deep red, converging into a tilted cone
    const Fl = this.flames;
    emit(Fl, live * (120 + 420 * I), dt, (i, j) => {
      const a = rand() * 6.2832, rr = R * Math.sqrt(rand());
      Fl.pos[j] = fx + Math.cos(a) * rr; Fl.pos[j + 1] = by + 0.1 + rand() * 0.4; Fl.pos[j + 2] = fz + Math.sin(a) * rr;
      const life = 0.55 + rand() * 0.55; Fl.life[i] = life;
      Fl.vel[j] = (rand() - 0.5) * 0.6; Fl.vel[j + 1] = H * (0.85 + rand() * 0.6) / life; Fl.vel[j + 2] = (rand() - 0.5) * 0.6;
      Fl.size[i] = R * (0.6 + rand() * 0.7) + 0.7;
    });
    stepLayer(Fl, dt, (i, a, j, P, V) => {
      const x = P[j], y = P[j + 1], z = P[j + 2];
      curl(x * 0.22, (y - by) * 0.2, z * 0.22, time * 0.9, C);
      const h = (y - by) * lean, ax = fx + WV.x * h, az = fz + WV.z * h, pull = 1.4 * a, amp = 1.3 + 1.4 * a;
      P[j]     = x + (V[j] + C[0] * amp + (ax - x) * pull + WV.x * u * 0.12) * dt;
      P[j + 1] = y + (V[j + 1] * (1 - 0.35 * a) + C[1] * 0.7) * dt;
      P[j + 2] = z + (V[j + 2] + C[2] * amp + (az - z) * pull + WV.z * u * 0.12) * dt;
    });
    Fl.pts.material.uniforms.uHeat.value = 0.75 + 0.3 * I;

    // --- Smoke: normal blending, grows and drifts downwind from the flame tips
    const Sm = this.smoke;
    emit(Sm, live * (14 + 56 * I), dt, (i, j) => {
      const hh = H * (0.55 + rand() * 0.35), h = hh * lean;
      Sm.pos[j] = fx + WV.x * h + (rand() - 0.5) * R; Sm.pos[j + 1] = by + hh; Sm.pos[j + 2] = fz + WV.z * h + (rand() - 0.5) * R;
      Sm.life[i] = 6 + rand() * 4;
      Sm.vel[j] = (rand() - 0.5) * 0.8; Sm.vel[j + 1] = 2.2 + rand() * 1.8; Sm.vel[j + 2] = (rand() - 0.5) * 0.8;
      Sm.size[i] = 2.2 + R * 0.9 + rand() * 2.2;
    });
    stepLayer(Sm, dt, (i, a, j, P, V) => {
      curl(P[j] * 0.06, P[j + 1] * 0.06, P[j + 2] * 0.06, time * 0.25, C);
      const w = u * (0.35 + 0.9 * a);
      P[j]     += (V[j] + WV.x * w + C[0] * 1.3) * dt;
      P[j + 1] += (V[j + 1] * (1 - 0.55 * a) + C[1] * 0.5) * dt;
      P[j + 2] += (V[j + 2] + WV.z * w + C[2] * 1.3) * dt;
    });
    const su = Sm.pts.material.uniforms; su.uDensity.value = 0.42 + 0.48 * I; su.uGlow.value = I;

    // --- Embers: tiny bright sparks, buoyant, swaying in the wind
    const Em = this.embers;
    emit(Em, live * (8 + 60 * I), dt, (i, j) => {
      const a = rand() * 6.2832, rr = R * 0.8 * Math.sqrt(rand());
      Em.pos[j] = fx + Math.cos(a) * rr; Em.pos[j + 1] = by + 0.5 + rand() * H * 0.5; Em.pos[j + 2] = fz + Math.sin(a) * rr;
      Em.life[i] = 1.8 + rand() * 2.6;
      Em.vel[j] = (rand() - 0.5) * 2.4; Em.vel[j + 1] = 3 + rand() * 5.5; Em.vel[j + 2] = (rand() - 0.5) * 2.4;
      Em.size[i] = 0.12 + rand() * 0.22;
    });
    stepLayer(Em, dt, (i, a, j, P, V) => {
      const s = Em.seed[i] * 40;
      curl(P[j] * 0.3, P[j + 1] * 0.3, P[j + 2] * 0.3, time * 1.4, C);
      V[j + 1] *= (1 - 0.45 * dt); V[j] *= (1 - 0.6 * dt); V[j + 2] *= (1 - 0.6 * dt);
      P[j]     += (V[j] + WV.x * u * 0.55 + Math.sin(time * 2.3 + s) * 1.1 + C[0] * 1.4) * dt;
      P[j + 1] += (V[j + 1] + C[1] * 0.8) * dt;
      P[j + 2] += (V[j + 2] + WV.z * u * 0.55 + Math.cos(time * 1.9 + s) * 1.1 + C[2] * 1.4) * dt;
    });

    // --- Flickering light: sine + value-noise modulation of intensity, colour and position
    const fl = 0.82 + 0.10 * Math.sin(time * 13 + this.seed) + 0.07 * Math.sin(time * 23.7 + this.seed * 2) + 0.24 * (noise1(time * 9 + this.seed) - 0.5);
    if (this.light){
      const L = this.light;
      L.intensity = I > 0.005 ? (110 + 950 * I) * fl * (this.Qmax / 50000) : 0;
      L.distance = 40 + 85 * I;
      L.color.setHSL(0.065 + 0.02 * (noise1(time * 5 + this.seed) - 0.5), 1, 0.56);
      L.position.set(fx + (noise1(time * 3.1 + this.seed) - 0.5) * 0.9 * R,
                     by + 1.5 + H * 0.3 + (noise1(time * 4.3 + this.seed + 7) - 0.5) * 0.8,
                     fz + (noise1(time * 2.7 + this.seed + 13) - 0.5) * 0.9 * R);
    }
    this.glow.material.uniforms.uAmt.value = I * (0.75 + 0.35 * fl); this.glow.position.y = by + 0.07;
    this.glow.scale.set(R * 6 + 2, R * 6 + 2, 1);
  }
}

/* ================================================================
   Environmental field: what a sensor reads at (x, y, z)
   - radiant flux: point-source model, χr = 0.30
   - ground hot-gas layer stretched downwind + McCaffrey/Heskestad plume centreline ΔT, tilted by wind
   - CO₂/CO/soot: Gaussian plume (Briggs rural σ) with ground reflection + near-field mixing
   ================================================================ */
const FS = { T:22, q:0, co2:420, co:0, vis:2000 };
function sample(x, y, z, out = FS){
  let dT = 0, q = 0, co2x = 0;
  const u = Math.max(0.5, sim.windSpeed);
  for (const f of fires){
    const I = f.Ieff; if (I <= 0.005) continue;
    const Q = f.Q, R = f.R, H = f.H, by = f.baseY, c = f.center();
    const rdx = x - c.x, rdz = z - c.z, rdy = y - c.y;
    q += 0.30 * Q / (4 * Math.PI * Math.max(rdx * rdx + rdz * rdz + rdy * rdy, (R * 0.8) ** 2));
    const dx = x - f.x, dz = z - f.z, rh = Math.hypot(dx, dz);
    const xd = dx * WV.x + dz * WV.z, yc = -dx * WV.z + dz * WV.x;
    const yr = y - by;                                    // height above the fire base
    // hot gas layer near the fire base, elongated downwind
    const Lh = 2 + 3 * I, st = xd > 0 ? 1 + 0.22 * u : 1;
    const re = Math.max(0, Math.hypot(xd / st, yc) - R);
    dT += 450 * I * Math.exp(-re / Lh) * Math.exp(-Math.max(0, Math.abs(yr) - 2) / 3);
    // buoyant plume centreline temperature, tilted downwind
    if (yr > -1){
      const zr = Math.max(yr, 0.5), off = zr * u / (u + 3), b = R * 0.6 + 0.16 * zr;
      const rp = Math.hypot(xd - off, yc);
      const dT0 = Math.min(900, 25 * Math.pow(Math.pow(0.7 * Q, 0.4) / zr, 5 / 3));
      dT += dT0 * Math.exp(-(rp * rp) / (b * b));
      co2x += 18000 * I * Math.exp(-(rp * rp) / (b * b)) * (zr > H ? 1 : 0.4);
    }
    // gas: Gaussian plume (ground reflected), source height Hs
    const qco2 = (Q / 30000) * 2.4;                      // kg/s CO₂ (ΔHc 30 MJ/kg, yield 2.4)
    const Hs = by + 3 + 6 * I;
    if (xd > 0.5){
      const sy = 0.22 * xd / Math.sqrt(1 + 0.0001 * xd) + R, sz = 0.20 * xd + 1.5;
      const Cc = qco2 / (2 * Math.PI * u * sy * sz) * Math.exp(-yc * yc / (2 * sy * sy)) *
                 (Math.exp(-((y - Hs) ** 2) / (2 * sz * sz)) + Math.exp(-((y + Hs) ** 2) / (2 * sz * sz)));
      co2x += Cc * 1e6 * 24.45 / 44;
    }
    co2x += 9000 * I * Math.exp(-(rh * rh) / (2 * (R + 4) ** 2)) * Math.exp(-Math.max(0, Math.abs(yr) - H) / 6);
  }
  out.T = 22 + Math.min(dT, 1100);
  out.q = q;
  out.co2 = 420 + co2x;
  out.co = co2x * 0.045;                                  // CO/CO₂ molar ratio, under-ventilated chemical fire
  const soot = co2x * (44 / 24.45) * (0.08 / 2.4);        // mg/m³
  out.vis = soot > 0.01 ? Math.min(2000, 3 / (8.7 * soot / 1000)) : 2000;
  return out;
}
const fieldLevel = (s, crew = true) => crew
  ? Math.max(lvlOf(s.T, LIM.T.v), lvlOf(s.q, LIM.q.v), lvlOf(s.co2, LIM.co2.v), lvlOf(s.co, LIM.co.v))
  : Math.max(lvlOf(s.T, DRONE_T), lvlOf(s.q, LIM.q.v));

/* ================================================================
   Risk grid (10×10, 16 m cells) + ground overlay shader with flux contours
   ================================================================ */
const cells = [];
for (let r = 0; r < CELLS; r++) for (let c = 0; c < CELLS; c++){
  const cx = -HALF + c * CELL + CELL / 2, cz = -HALF + r * CELL + CELL / 2;
  const assets = ASSETS.filter(a => !a.hidden && a.maxX > cx - CELL / 2 && a.minX < cx + CELL / 2 && a.maxZ > cz - CELL / 2 && a.minZ < cz + CELL / 2);
  cells.push({ i:r * CELLS + c, c, r, cx, cz, name:cellName(c, r), assets, T:22, q:0, co2:420, co:0, vis:2000, level:0 });
}
const riskData = new Uint8Array(CELLS * CELLS * 4);
const riskTex = new THREE.DataTexture(riskData, CELLS, CELLS, THREE.RGBAFormat);
riskTex.magFilter = riskTex.minFilter = THREE.NearestFilter; riskTex.needsUpdate = true;
const overlayMat = new THREE.ShaderMaterial({
  transparent:true, depthWrite:false,
  uniforms:{ uRisk:{ value:riskTex }, uSel:{ value:new THREE.Vector2(-1, -1) }, uGrid:{ value:0 }, uTime,
             uFires:{ value:[new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] } },
  vertexShader:`varying vec2 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader:`
    uniform sampler2D uRisk; uniform vec2 uSel; uniform float uGrid; uniform float uTime; uniform vec4 uFires[3];
    varying vec2 vW;
    vec4 over(vec4 d, vec3 c, float a){ float oa = a + d.a * (1.0 - a); vec3 oc = oa > 0.0 ? (c * a + d.rgb * d.a * (1.0 - a)) / oa : c; return vec4(oc, oa); }
    void main(){
      vec2 g = (vW + 80.0) / 16.0; vec2 cell = floor(g);
      float lvl = texture2D(uRisk, (cell + 0.5) / 10.0).r * 255.0 / 85.0;
      vec3 cS = vec3(0.25, 0.32, 0.42), cA = vec3(0.91, 0.69, 0.29), cW = vec3(1.0, 0.30, 0.24);
      vec3 col = lvl < 0.5 ? cS : (lvl < 1.5 ? cA : cW);
      float a = lvl < 0.5 ? 0.0 : (lvl < 1.5 ? 0.13 : (lvl < 2.5 ? 0.22 : 0.30 + 0.07 * sin(uTime * 4.0)));
      // the grid is hidden by default; clicking a cell reveals it, fading out around that cell
      float reveal = uGrid * (1.0 - smoothstep(18.0, 56.0, distance(vW, (uSel + 0.5) * 16.0 - 80.0)));
      vec4 o = vec4(col, a * reveal);
      vec2 f = fract(g), dd = min(f, 1.0 - f), fw = fwidth(g);
      float px = min(dd.x / fw.x, dd.y / fw.y);
      o = over(o, vec3(0.62, 0.68, 0.78), (1.0 - smoothstep(0.0, 1.2, px)) * 0.16 * reveal);
      // radiant heat-flux contours: exclusion (4.7 kW/m²) and caution (1.6 kW/m²)
      float q = 0.0;
      for (int i = 0; i < 3; i++){ vec4 F = uFires[i]; if (F.z > 0.0){ vec2 d = vW - F.xy; q += 0.3 * F.z / (12.566 * max(dot(d, d) + F.w * F.w, 1.0)); } }
      if (q > 0.05){
        float lq = log(q), w = fwidth(lq) * 1.4 + 1e-4;
        float c1 = 1.0 - smoothstep(0.0, w, abs(lq - log(4.7)));
        float c2 = 1.0 - smoothstep(0.0, w, abs(lq - log(1.6)));
        float dash = step(0.45, fract((vW.x + vW.y) * 0.16 - uTime * 0.25));
        float hatch = step(0.82, fract((vW.x - vW.y) * 0.35)) * step(log(4.7), lq);
        o = over(o, vec3(1.0, 0.3, 0.22), hatch * 0.22);
        o = over(o, vec3(1.0, 0.75, 0.25), c2 * dash * 0.85);
        o = over(o, vec3(1.0, 0.25, 0.2), c1 * 0.95);
      }
      if (cell == uSel){ o = over(o, vec3(1.0), 0.05 * uGrid); o = over(o, vec3(0.9, 1.0, 1.0), (1.0 - smoothstep(1.5, 3.0, px)) * 0.95 * uGrid); }
      gl_FragColor = o;
    }`,
});
const overlay = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), overlayMat);
overlay.rotation.x = -Math.PI / 2; overlay.position.y = 0.06; overlay.renderOrder = -1; scene.add(overlay);

/* ================================================================
   Navigation grid (40×40, 4 m) + A* routing that avoids hazard cells
   ================================================================ */
const nav = { blocked:new Uint8Array(NAV * NAV), level:new Uint8Array(NAV * NAV), cost:new Float32Array(NAV * NAV).fill(1) };
const navIdx = (x, z) => clamp(Math.floor((z + HALF) / NAVC), 0, NAV - 1) * NAV + clamp(Math.floor((x + HALF) / NAVC), 0, NAV - 1);
const navCenter = n => ({ x:-HALF + (n % NAV + 0.5) * NAVC, z:-HALF + (Math.floor(n / NAV) + 0.5) * NAVC });
for (let n = 0; n < NAV * NAV; n++){
  const p = navCenter(n);
  for (const a of ASSETS){
    if (a.type === 'yard') continue;
    if (a.type === 'tank'){ if (Math.hypot(p.x - a.x, p.z - a.z) < a.r + 1.8) nav.blocked[n] = 1; }
    else if (p.x > a.minX - 1.5 && p.x < a.maxX + 1.5 && p.z > a.minZ - 1.5 && p.z < a.maxZ + 1.5) nav.blocked[n] = 1;
  }
  if (p.x > 21 && p.x < 71 && p.z > -72 && p.z < -40) nav.blocked[n] = 1;   // bunded tank farm
}
class Heap {
  constructor(){ this.a = []; this.p = []; }
  get size(){ return this.a.length; }
  push(v, pr){ const a = this.a, p = this.p; a.push(v); p.push(pr); let i = a.length - 1;
    while (i > 0){ const j = (i - 1) >> 1; if (p[j] <= p[i]) break; [a[i], a[j]] = [a[j], a[i]]; [p[i], p[j]] = [p[j], p[i]]; i = j; } }
  pop(){ const a = this.a, p = this.p, top = a[0], la = a.pop(), lp = p.pop();
    if (a.length){ a[0] = la; p[0] = lp; let i = 0; const n = a.length;
      for (;;){ const l = 2 * i + 1, r = l + 1; let m = i; if (l < n && p[l] < p[m]) m = l; if (r < n && p[r] < p[m]) m = r; if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; [p[i], p[m]] = [p[m], p[i]]; i = m; } }
    return top; }
}
const DC = [1, -1, 0, 0, 1, 1, -1, -1], DR = [0, 0, 1, -1, 1, -1, 1, -1];
function nearestFree(n){
  if (!nav.blocked[n]) return n;
  const c0 = n % NAV, r0 = Math.floor(n / NAV);
  for (let rad = 1; rad < NAV; rad++){
    let best = -1, bd = 1e9;
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++){
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
      const c = c0 + dc, r = r0 + dr; if (c < 0 || r < 0 || c >= NAV || r >= NAV) continue;
      const m = r * NAV + c; if (!nav.blocked[m] && dc * dc + dr * dr < bd){ bd = dc * dc + dr * dr; best = m; }
    }
    if (best >= 0) return best;
  }
  return n;
}
const freePoint = p => { const n = navIdx(p.x, p.z); return nav.blocked[n] ? navCenter(nearestFree(n)) : p; };
function los(ax, az, bx, bz){
  const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / 1.5);
  const lim = Math.max(nav.cost[navIdx(ax, az)], nav.cost[navIdx(bx, bz)], 1);
  for (let i = 1; i < n; i++){ const t = i / n, m = navIdx(ax + (bx - ax) * t, az + (bz - az) * t); if (nav.blocked[m] || nav.cost[m] > lim) return false; }
  return true;
}
// allowHot: operator override (manual move) — critical cells become very expensive instead of impassable
function findPath(sx, sz, tx, tz, allowHot = false){
  const s = navIdx(sx, sz); let t = navIdx(tx, tz);
  if (nav.blocked[t]){ t = nearestFree(t); const p = navCenter(t); tx = p.x; tz = p.z; }
  if (s === t) return [{ x:tx, z:tz }];
  const N = NAV * NAV, g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const tc = t % NAV, tr = Math.floor(t / NAV);
  const h = n => { const dc = Math.abs(n % NAV - tc), dr = Math.abs(Math.floor(n / NAV) - tr); return dc + dr - 0.5858 * Math.min(dc, dr); };
  const heap = new Heap(); g[s] = 0; heap.push(s, h(s));
  while (heap.size){
    const n = heap.pop(); if (n === t) break; if (closed[n]) continue; closed[n] = 1;
    const c = n % NAV, r = Math.floor(n / NAV);
    for (let k = 0; k < 8; k++){
      const dc = DC[k], dr = DR[k], nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= NAV || nr >= NAV) continue;
      const m = nr * NAV + nc; if (nav.blocked[m] || closed[m]) continue;
      if (dc && dr && (nav.blocked[r * NAV + nc] || nav.blocked[nr * NAV + c])) continue;
      let cst = nav.cost[m];
      if (!isFinite(cst)){ if (m !== t && !allowHot) continue; cst = 200; }   // critical cells are no-go unless it is the destination or an override
      const ng = g[n] + (dc && dr ? 1.4142 : 1) * cst;
      if (ng < g[m]){ g[m] = ng; came[m] = n; heap.push(m, ng + h(m)); }
    }
  }
  if (came[t] === -1) return null;
  const seq = []; for (let n = t; n !== -1 && n !== s; n = came[n]) seq.push(n);
  seq.reverse();
  const pts = seq.map(navCenter); pts[pts.length - 1] = { x:tx, z:tz };
  // string-pull
  const out = []; let cx = sx, cz = sz, i = 0;
  while (i < pts.length){ let j = pts.length - 1; while (j > i && !los(cx, cz, pts[j].x, pts[j].z)) j--; out.push(pts[j]); cx = pts[j].x; cz = pts[j].z; i = j + 1; }
  return out;
}

/* ================================================================
   Units
   ================================================================ */
const units = [];
const unitHits = [];
const STAGING = { x:-70, z:26 }, MUSTER = { x:-66, z:66 }, ADMIN_DOOR = { x:-48, z:40 };
function vehicleMesh(color, kind = 'engine'){
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const paint = new THREE.MeshStandardMaterial({ color, roughness:0.38, metalness:0.35 });
  const dark = new THREE.MeshStandardMaterial({ color:0x15181d, roughness:0.8, metalness:0.3 });
  const chrome = new THREE.MeshStandardMaterial({ color:0xb9bec6, roughness:0.25, metalness:0.9 });
  const glass = new THREE.MeshStandardMaterial({ color:0x0d1624, roughness:0.08, metalness:0.9, emissive:0x1a2a40, emissiveIntensity:0.35 });
  const add = (geo, m, x, y, z, parent = body) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; parent.add(o); return o; };
  add(new THREE.BoxGeometry(2.3, 0.35, 6.9), dark, 0, 0.75, 0);                    // chassis
  add(new THREE.BoxGeometry(2.5, 2.1, 4.6), paint, 0, 1.95, -0.95);               // body / lockers
  add(new THREE.BoxGeometry(2.5, 1.9, 1.9), paint, 0, 1.85, 2.45);                // cab
  add(new THREE.BoxGeometry(2.36, 0.85, 0.06), glass, 0, 2.3, 3.42);              // windscreen
  for (const sx of [-1.26, 1.26]){
    add(new THREE.BoxGeometry(0.04, 0.6, 1.2), glass, sx, 2.3, 2.5);             // side windows
    add(new THREE.BoxGeometry(0.03, 0.14, 6.6), new THREE.MeshStandardMaterial({ color:0xe8e04a, emissive:0xe8e04a, emissiveIntensity:0.25, roughness:0.4 }), sx * 1.005, 1.25, 0.1);  // reflective stripe
    for (const z of [-2.6, -1.1, 0.4]) add(new THREE.BoxGeometry(0.03, 1.4, 1.2), dark, sx * 1.01, 2.0, z);  // locker doors
  }
  add(new THREE.BoxGeometry(2.4, 0.3, 0.2), chrome, 0, 0.95, 3.5);                // bumper
  for (const sx of [-0.85, 0.85]) add(new THREE.BoxGeometry(0.35, 0.18, 0.05), new THREE.MeshBasicMaterial({ color:0xfff4d6 }), sx, 1.25, 3.46);  // headlights
  if (kind === 'engine'){
    for (const sx of [-0.45, 0.45]) add(new THREE.BoxGeometry(0.08, 0.08, 5.2), chrome, sx, 3.15, -0.9);   // ladder rails
    for (let z = -3.2; z <= 1.4; z += 0.5) add(new THREE.BoxGeometry(0.9, 0.05, 0.05), chrome, 0, 3.15, z);
    add(new THREE.CylinderGeometry(0.45, 0.45, 0.5, 18), dark, 0, 3.15, -3.1).rotation.z = Math.PI / 2;   // hose reel
  } else {
    add(new THREE.BoxGeometry(2.0, 0.3, 3.2), dark, 0, 3.15, -1.0);               // roof equipment box
  }
  const wheels = [];
  const tire = new THREE.CylinderGeometry(0.55, 0.55, 0.42, 20), hub = new THREE.CylinderGeometry(0.28, 0.28, 0.44, 12);
  for (const [x, z] of [[-1.15, 2.3], [1.15, 2.3], [-1.15, -1.4], [1.15, -1.4], [-1.15, -2.6], [1.15, -2.6]]){
    const w = new THREE.Group(); w.position.set(x, 0.55, z); g.add(w);
    const t = new THREE.Mesh(tire, new THREE.MeshStandardMaterial({ color:0x0c0c0d, roughness:0.95 })); t.rotation.z = Math.PI / 2; t.castShadow = true; w.add(t);
    const h = new THREE.Mesh(hub, chrome); h.rotation.z = Math.PI / 2; w.add(h);
    wheels.push(w);
  }
  const lr = add(new THREE.BoxGeometry(0.75, 0.22, 0.38), new THREE.MeshBasicMaterial({ color:0xff2030 }), -0.45, 2.92, 2.4);
  const lb = add(new THREE.BoxGeometry(0.75, 0.22, 0.38), new THREE.MeshBasicMaterial({ color:0x2050ff }), 0.45, 2.92, 2.4);
  // only large parts cast shadows: small details would multiply the shadow-map draw calls
  g.traverse(o => { if (o.isMesh){ o.geometry.computeBoundingSphere(); o.castShadow = o.geometry.boundingSphere.radius > 1.2; } });
  g.userData = { lights:[lr, lb], wheels, body };
  return g;
}
function droneMesh(){
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color:0x2a3240, roughness:0.4, metalness:0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.45, 1.3), m); body.castShadow = true; g.add(body);
  const rotors = [];
  for (const [x, z] of [[1.2, 1.2], [-1.2, 1.2], [1.2, -1.2], [-1.2, -1.2]]){
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 1.7), m); arm.position.set(x / 2, 0, z / 2); arm.rotation.y = Math.atan2(x, z); g.add(arm);
    const rot = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.04, 20), new THREE.MeshBasicMaterial({ color:0x9fb3c8, transparent:true, opacity:0.28 }));
    rot.position.set(x, 0.3, z); g.add(rot); rotors.push(rot);
  }
  const nl = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color:0x5eead4 })); nl.position.set(0, -0.3, 0.7); g.add(nl);
  g.userData.rotors = rotors; g.userData.lights = [nl];
  g.scale.setScalar(1.5);
  return g;
}
const sprayMat = () => pMat(SPRAY_FS, {}, THREE.NormalBlending, { grow:2.0 });
const LVL_COLORS = [0x9fd8c0, 0xe8b04a, 0xff4d3d, 0xff4d3d];
function addUnit(o){
  const u = Object.assign({ heading:Math.PI / 2, targetHeading:Math.PI / 2, path:null, dest:null, task:null, mode:'idle', status:'Standby at staging',
    sens:{ T:22, q:0, co2:420, co:0, vis:2000 }, level:0, hist:[], peakT:22, orbitA:0, sprayOn:false, sprayTo:new THREE.Vector3() }, o);
  u.pos = new THREE.Vector3(o.x, 0, o.z);
  u.home = { x:o.x, z:o.z };
  u.isDrone = u.kind === 'drone';
  u.mesh = u.isDrone ? droneMesh() : vehicleMesh(u.color, u.kind);
  scene.add(u.mesh);
  u.ring = new THREE.Mesh(new THREE.RingGeometry(3.6, 3.85, 48), new THREE.MeshBasicMaterial({ color:LVL_COLORS[0], transparent:true, opacity:0.5, depthWrite:false }));
  u.ring.rotation.x = -Math.PI / 2; u.ring.renderOrder = 4; scene.add(u.ring);
  if (u.isDrone){
    u.tether = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial({ color:0x5eead4, transparent:true, opacity:0.35 }));
    scene.add(u.tether);
  }
  const hit = new THREE.Mesh(new THREE.SphereGeometry(5, 8, 6), new THREE.MeshBasicMaterial({ visible:false }));
  hit.userData.unit = u; scene.add(hit); u.hit = hit; unitHits.push(hit);
  const el = document.createElement('div'); el.className = 'ulabel';
  el.innerHTML = `<span class="d l0"></span>${u.id}<span class="rv num"></span>`;
  el.addEventListener('pointerdown', e => { e.stopPropagation(); emitEv('select-unit', u); });
  u.labelEl = el; u.label = new CSS2DObject(el); scene.add(u.label);
  u.route = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color:0x5eead4, transparent:true, opacity:0.75 }));
  u.route.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
  u.route.geometry.setDrawRange(0, 0); u.route.frustumCulled = false; scene.add(u.route);
  if (!u.isDrone) u.spray = makeLayer(240, sprayMat(), 2);
  units.push(u);
  return u;
}
addUnit({ id:'E1', name:'Engine 1', kind:'engine', crew:4, x:-72, z:12, speed:5, color:0xc62828, desc:'Fire engine · foam monitor' });
addUnit({ id:'E2', name:'Engine 2', kind:'engine', crew:4, x:-72, z:20, speed:5, color:0xb71c1c, desc:'Fire engine · foam monitor' });
addUnit({ id:'H1', name:'Hazmat 1', kind:'hazmat', crew:3, x:-72, z:28, speed:4.5, color:0xd4b21a, desc:'Hazmat unit · gas-tight suits' });
addUnit({ id:'R1', name:'Rescue 1', kind:'rescue', crew:2, x:-72, z:36, speed:4.5, color:0xe6e9ee, desc:'Rescue & evacuation' });
addUnit({ id:'D1', name:'Drone D1', kind:'drone', x:-64, z:14, speed:9, cruise:30, desc:'Quadcopter · thermal camera' });
addUnit({ id:'D2', name:'Drone D2', kind:'drone', x:-64, z:22, speed:9, cruise:16, desc:'Quadcopter · gas sniffer' });
addUnit({ id:'D3', name:'Scout D3', kind:'drone', indoor:true, x:-64, z:30, speed:6, cruise:10, desc:'Caged indoor drone · thermal + lidar' });
const unitById = id => units.find(u => u.id === id);

/* ================================================================
   Tasks
   ================================================================ */
const tasks = [
  { id:'t1', title:'Thermal recon of fire & plume', kind:'recon',   unit:'D1', auto:true },
  { id:'t2', title:'Gas survey downwind',           kind:'survey',  unit:'D2', auto:true },
  { id:'t3', title:'Evacuate admin block (18 staff)', kind:'evac',  unit:'R1', auto:true, phase:0, evac:0 },
  { id:'t4', title:'Block drain, contain run-off',  kind:'contain', unit:'H1', auto:true },
  { id:'t5', title:'Foam attack on drum yard',      kind:'foam',    unit:'E2', fireId:'F1' },
  { id:'t6', title:'Cool W-1 east wall (exposure)', kind:'cool',    unit:'E1' },
].map(t => Object.assign({ status:'queued', progress:0 }, t));
let taskSeq = 7;
const DRONE_KINDS = ['recon', 'survey', 'scan'];
const taskFire = t => fires.find(f => f.id === t.fireId) || primaryFire();
function primaryFire(){ let best = null; for (const f of fires) if (f.active && (!best || f.Q > best.Q)) best = f; return best; }

function taskTarget(t, u){
  switch (t.kind){
    case 'foam': {
      const f = taskFire(t); if (!f) return { x:u.pos.x, z:u.pos.z };
      const Q = Math.max(f.Q, f.Qmax * 0.35);
      let d = clamp(Math.sqrt(0.3 * Q / (4 * Math.PI * 2.4)), 16, 38) + (f.baseY > 0 ? 6 : 0);
      const off = u.id === 'E1' ? 0.6 : u.id === 'E2' ? 0 : -0.6;
      const ang = Math.atan2(-WV.z, -WV.x) + off;             // stand upwind of the fire
      return freePoint({ x:f.x + Math.cos(ang) * d, z:f.z + Math.sin(ang) * d });
    }
    case 'cool': return { x:-15, z:-21 };
    case 'evac': return t.phase === 1 ? MUSTER : ADMIN_DOOR;
    case 'contain': return { x:DRAIN.x - 3, z:DRAIN.z + 2 };
    case 'move': return { x:t.x, z:t.z };
  }
  if (S.hooks.target && S.hooks.target[t.kind]) return S.hooks.target[t.kind](t, u);
  return { x:u.pos.x, z:u.pos.z };
}
function assignTask(t, u){
  if (u.task && u.task !== t && !['done', 'cancelled'].includes(u.task.status)) u.task.status = 'queued';
  const prev = units.find(o => o !== u && o.task === t); if (prev){ prev.task = null; prev.mode = 'idle'; prev.sprayOn = false; prev.status = 'Holding'; }
  t.unit = u.id; u.task = t; t.status = 'en route'; u.mode = 'enroute'; u.sprayOn = false;
  u.status = `En route · ${t.title}`;
  if (u.isDrone) return;
  u.dest = taskTarget(t, u);
  u.path = findPath(u.pos.x, u.pos.z, u.dest.x, u.dest.z, t.kind === 'move');
  if (!u.path){ t.status = 'blocked'; u.mode = 'idle'; u.status = 'No safe route'; addLog(`${u.id}: no safe route for “${t.title}”`, 'l1'); }
}
function moveUnit(u, x, z){
  const t = { id:'t' + taskSeq++, title:`Move to ${cellNameAt(x, z)}`, kind:'move', x, z, status:'queued', progress:0, unit:u.id, adhoc:true };
  tasks.push(t); assignTask(t, u);
  const s = sample(x, u.isDrone ? u.cruise : 1.5, z, {});
  const lv = fieldLevel(s, !u.isDrone);
  addLog(`${u.id} sent to ${cellNameAt(x, z)}${lv >= 2 ? ' (into a hazard cell)' : ''}`, lv >= 2 ? 'l1' : '');
}
function safePointFor(u){
  const f = primaryFire(); let best = null, bs = Infinity;
  for (let n = 0; n < NAV * NAV; n++){
    if (nav.blocked[n] || nav.level[n] > 0) continue;
    const p = navCenter(n); let s = Math.hypot(p.x - u.pos.x, p.z - u.pos.z);
    if (f){ const dx = p.x - f.x, dz = p.z - f.z; if (Math.hypot(dx, dz) < 30) continue; const xd = dx * WV.x + dz * WV.z; if (xd > 0) s += xd * 0.8; }
    if (s < bs){ bs = s; best = p; }
  }
  return best || STAGING;
}
function pullBack(u, why = 'manual'){
  if (u.task && !['done', 'cancelled'].includes(u.task.status)) u.task.status = 'withdrawn';
  u.mode = 'pullback'; u.sprayOn = false;
  if (u.isDrone){
    const f = primaryFire();
    u.dest = f ? { x:f.x - WV.x * 50, z:f.z - WV.z * 50 } : { ...u.home };
  } else {
    u.dest = safePointFor(u);
    u.path = findPath(u.pos.x, u.pos.z, u.dest.x, u.dest.z, true) || [u.dest];   // must be able to leave a hot cell
  }
  u.status = why === 'auto' ? 'Auto-withdrawn · exposure limit' : 'Pulling back to safe point';
  if (why === 'auto') setVisorEvent(`<b>AUTO-WITHDRAW</b> ${u.id} · ${topReason(u) || LVL_NAME[u.level]} at ${cellNameAt(u.pos.x, u.pos.z)} → ${cellNameAt(u.dest.x, u.dest.z)}`, 8,
    `${u.name}, auto withdraw. ${spokenReason(u)}. Falling back to ${cellNameAt(u.dest.x, u.dest.z)}.`);
  addLog(`${u.id} ${why === 'auto' ? 'auto-withdrawn' : 'pulling back'} → ${cellNameAt(u.dest.x, u.dest.z)}`, why === 'auto' ? 'l2' : 'l1');
}
function onFireOut(f){
  for (const t of tasks) if (t.kind === 'foam' && t.fireId === f.id && t.status !== 'done'){ t.status = 'done'; t.progress = 1; }
  for (const u of units) if (u.task && u.task.kind === 'foam' && u.task.fireId === f.id){ u.mode = 'idle'; u.sprayOn = false; u.status = 'Holding · fire knocked down'; }
}
function ignite(asset){
  asset.burning = true;
  const id = 'F' + (fires.length + 1);
  fires.push(new Fire({ id, name:asset.name, x:asset.fire.x, z:asset.fire.z, baseY:asset.fire.y, Qmax:asset.Qmax, R0:1.8, Rk:3.4, I:0.12, light:lightPool[fires.length] }));
  addLog(`FIRE SPREAD · ${asset.name} ignited (radiant exposure)`, 'l3');
  setVisorEvent(`<b>FIRE SPREAD</b> ${asset.name} ignited · T+${tplus(sim.t)}`, 10, `Fire spread. ${asset.name} is burning.`);
  emitEv('ignite', asset);
  for (const t of tasks) if (t.kind === 'cool' && !['done'].includes(t.status)){ t.status = 'cancelled'; }
  for (const u of units) if (u.task && u.task.kind === 'cool'){ u.mode = 'idle'; u.sprayOn = false; u.status = 'Holding · W-1 involved'; }
  tasks.push({ id:'t' + taskSeq++, title:`Foam attack on ${asset.short || asset.name}`, kind:'foam', unit:'E1', fireId:id, status:'queued', progress:0 });
}

/* ================================================================
   Simulation step (sim seconds)
   ================================================================ */
function topReason(u){
  const s = u.sens, parts = [], tArr = u.isDrone ? DRONE_T : LIM.T.v;
  if (lvlOf(s.T, tArr)) parts.push(fmt.T(s.T));
  if (lvlOf(s.q, LIM.q.v)) parts.push(fmt.q(s.q));
  if (!u.isDrone && lvlOf(s.co, LIM.co.v)) parts.push(`CO ${fmt.co(s.co)}`);
  if (!u.isDrone && lvlOf(s.co2, LIM.co2.v)) parts.push(`CO₂ ${fmt.co2(s.co2)}`);
  return parts.join(' · ');
}
function spokenReason(u){
  const s = u.sens, p = [];
  if (lvlOf(s.T, u.isDrone ? DRONE_T : LIM.T.v)) p.push(`${Math.round(s.T)} degrees`);
  if (lvlOf(s.q, LIM.q.v)) p.push(`heat flux ${s.q.toFixed(0)} kilowatts`);
  if (!u.isDrone && lvlOf(s.co, LIM.co.v) >= 2) p.push(`carbon monoxide ${Math.round(s.co)} p p m`);
  return p.join(', ') || LVL_NAME[u.level];
}
function step(dt){
  for (const f of fires) f.suppress = 0;
  for (const a of ASSETS) a.cooled = false;
  for (const u of units) updateUnit(u, dt);
  for (const f of fires) f.simStep(dt);
  // radiant exposure of flammable assets -> secondary ignition
  for (const a of ASSETS){
    if (!a.fuel || a.burning) continue;
    const q = sample(a.ign.x, a.ign.y, a.ign.z, {}).q;
    a.qNow = q;
    a.dose += Math.max(0, q - 7) * (a.cooled ? 0.2 : 1) * dt;
    if (a.dose >= a.doseMax && fires.length < 3) ignite(a);
  }
  if (!S.rollCall && sim.t >= 150){
    S.rollCall = true;
    addLog('Roll call: 2 night-shift workers missing, last seen in W-1', 'l2', 'Roll call. Two night shift workers missing. Last seen in warehouse W 1.');
    emitEv('missing', { building:'W1', count:2 });
  }
  for (const h of S.hooks.step) h(dt);
}
function readSensors(u, dt){
  const y = u.isDrone ? u.pos.y : 1.5;
  const s = (S.hooks.sense && S.hooks.sense(u)) || sample(u.pos.x, y, u.pos.z, {});
  const k = 1 - Math.exp(-dt / 1.2);   // sensor response time ≈ 1.2 s
  for (const key of ['T', 'q', 'co2', 'co', 'vis']){
    const noise = key === 'vis' ? 1 : 1 + (rand() - 0.5) * 0.03;
    u.sens[key] += (s[key] * noise - u.sens[key]) * k;
  }
  u.peakT = Math.max(u.peakT, u.sens.T);
  const prev = u.level;
  u.level = fieldLevel(u.sens, !u.isDrone);
  // log escalations once per 60 s per level, so readings hovering on a threshold don't spam the log
  u.logged = u.logged || {};
  const lastLog = u.logged[u.level] ?? -Infinity;
  if (u.level > prev && u.level >= 2 && sim.t - lastLog >= 60){
    u.logged[u.level] = sim.t;
    addLog(`${u.id} ${LVL_NAME[u.level].toLowerCase()}: ${Math.round(u.sens.T)} °C, ${u.sens.q.toFixed(1)} kW/m²`, 'l' + u.level,
      u.level === 2 ? `${u.name}, thermal warning. ${spokenReason(u)}.` : null);
  }
  if (u.level >= 3 && sim.autoWithdraw && u.mode !== 'pullback') pullBack(u, 'auto');
}
function updateUnit(u, dt){
  if (u.isDrone) droneUpdate(u, dt); else groundUpdate(u, dt);
  readSensors(u, dt);
}
function groundUpdate(u, dt){
  if (u.path && u.path.length){
    let budget = u.speed * dt * (u.sens.vis < 8 ? 0.5 : 1);
    while (budget > 0 && u.path && u.path.length){
      const w = u.path[0], dx = w.x - u.pos.x, dz = w.z - u.pos.z, d = Math.hypot(dx, dz);
      if (d > 0.01) u.targetHeading = Math.atan2(dx, dz);
      if (d <= budget){ u.pos.x = w.x; u.pos.z = w.z; budget -= d; u.path.shift(); }
      else { u.pos.x += dx / d * budget; u.pos.z += dz / d * budget; budget = 0; }
    }
    if (u.path && !u.path.length){ u.path = null; arrive(u); }
  }
  if (u.mode !== 'working' || !u.task) { u.sprayOn = false; return; }
  const t = u.task;
  if (t.kind === 'foam'){
    const f = taskFire(t);
    if (!f){ t.status = 'done'; u.mode = 'idle'; u.sprayOn = false; return; }
    const d = Math.hypot(f.x - u.pos.x, f.z - u.pos.z);
    if (d < 55){ f.suppress += 1; u.sprayOn = true; u.sprayTo.set(f.x, f.baseY + 0.8, f.z); u.targetHeading = Math.atan2(f.x - u.pos.x, f.z - u.pos.z); }
    t.progress = 1 - f.I;
    u.status = `Foam attack · ${f.name} at ${Math.round(f.I * 100)} %`;
  } else if (t.kind === 'cool'){
    W1.cooled = true; u.sprayOn = true; u.sprayTo.set(W1.ign.x, 5, W1.ign.z);
    u.targetHeading = Math.atan2(W1.ign.x - u.pos.x, W1.ign.z - u.pos.z);
    t.progress = 1 - W1.dose / W1.doseMax; u.status = 'Cooling W-1 east wall';
  } else if (t.kind === 'evac'){
    t.evac = Math.min(17, t.evac + 0.25 * dt); t.progress = t.evac / 18 * 0.8;
    u.status = `Evacuating admin · ${Math.floor(t.evac)}/18 out`;
    if (t.evac >= 17){ t.phase = 1; u.mode = 'enroute'; u.dest = MUSTER; u.path = findPath(u.pos.x, u.pos.z, MUSTER.x, MUSTER.z); u.status = 'Escorting staff to muster point';
      addLog('Admin roll call: 17 of 18 out, 1 missing', 'l2', 'Rescue 1. Admin roll call, seventeen of eighteen out. One person missing.');
      emitEv('missing', { building:'A1', count:1 }); }
  } else if (t.kind === 'contain'){
    t.progress = Math.min(1, t.progress + dt / 120); u.status = `Placing drain seal · ${Math.round(t.progress * 100)} %`;
    if (t.progress >= 1){ t.status = 'done'; u.mode = 'idle'; u.status = 'Drain sealed · standing by'; addLog('Drain sealed, run-off contained', 'ok'); }
  } else if (S.hooks.ground[t.kind]) S.hooks.ground[t.kind](u, t, dt);
}
function arrive(u){
  const t = u.task;
  if (u.mode === 'pullback'){ u.mode = 'idle'; u.status = t && t.status === 'withdrawn' ? 'Holding at safe point (withdrawn)' : 'Holding at safe point'; return; }
  if (!t){ u.mode = 'idle'; u.status = 'Holding'; return; }
  if (t.kind === 'move'){ t.status = 'done'; t.progress = 1; u.mode = 'idle'; u.status = `Holding at ${cellNameAt(u.pos.x, u.pos.z)}`; return; }
  if (t.kind === 'evac' && t.phase === 1){ t.status = 'done'; t.progress = 1; u.mode = 'idle'; u.task = null; u.status = 'At muster point'; return; }
  t.status = 'working'; u.mode = 'working';
  if (S.hooks.arrive[t.kind]) S.hooks.arrive[t.kind](u, t);
}
function droneUpdate(u, dt){
  let tx = u.home.x, tz = u.home.z, ty = 0;
  const t = u.task, f = primaryFire();
  if (t && S.hooks.drone[t.kind] && u.mode !== 'pullback' && !['done', 'cancelled', 'withdrawn', 'queued'].includes(t.status)) return S.hooks.drone[t.kind](u, t, dt);
  if (u.mode === 'pullback'){ tx = u.dest.x; tz = u.dest.z; ty = u.cruise; }
  else if (t && !['done', 'cancelled', 'withdrawn', 'queued'].includes(t.status)){
    if (t.kind === 'recon'){
      if (f){ const R = 34; if (u.mode === 'working') u.orbitA += dt * (6 / R); tx = f.x + Math.cos(u.orbitA) * R; tz = f.z + Math.sin(u.orbitA) * R; ty = 30;
        if (u.mode === 'working'){ t.progress = Math.min(1, t.progress + dt / 240); u.status = `Thermal orbit · ${Math.round(t.progress * 100)} % mapped`; } }
      else { t.status = 'done'; u.mode = 'idle'; }
    } else if (t.kind === 'survey'){
      if (f){ tx = f.x + WV.x * 55; tz = f.z + WV.z * 55; ty = 16; if (u.mode === 'working') u.status = `Sampling plume · CO₂ ${Math.round(u.sens.co2)} ppm`; }
      else { t.status = 'done'; u.mode = 'idle'; }
    } else if (t.kind === 'move'){ tx = t.x; tz = t.z; ty = u.cruise; }
  }
  const dx = tx - u.pos.x, dz = tz - u.pos.z, d = Math.hypot(dx, dz);
  const wantY = d > 3 ? Math.max(ty, u.cruise) : ty;
  u.pos.y += clamp(wantY - u.pos.y, -4 * dt, 4 * dt);
  if (u.pos.y > 4 && d > 0.05){ const s = Math.min(d, u.speed * dt); u.pos.x += dx / d * s; u.pos.z += dz / d * s; u.targetHeading = Math.atan2(dx, dz); }
  const arrived = d < 4 && Math.abs(ty - u.pos.y) < 2;
  if (arrived){
    if (u.mode === 'pullback'){ u.mode = 'idle'; u.status = 'Holding upwind (withdrawn)'; }
    else if (t && u.mode === 'enroute'){
      if (t.kind === 'move'){ t.status = 'done'; t.progress = 1; u.mode = 'idle'; u.status = `Hovering over ${cellNameAt(u.pos.x, u.pos.z)}`; }
      else { u.mode = 'working'; t.status = 'working'; }
    }
  }
}

/* ================================================================
   Risk sampling, nav costs, rerouting
   ================================================================ */
function updateRisk(){
  let redCells = 0;
  const s = {};
  for (const c of cells){
    let T = 0, q = 0, co2 = 0, co = 0, vis = 2000;
    for (const [ox, oz] of [[0, 0], [-5, -5], [5, -5], [-5, 5], [5, 5]]){
      sample(c.cx + ox, 1.5, c.cz + oz, s);
      T = Math.max(T, s.T); q = Math.max(q, s.q); co2 = Math.max(co2, s.co2); co = Math.max(co, s.co); vis = Math.min(vis, s.vis);
    }
    Object.assign(c, { T, q, co2, co, vis });
    c.burning = fires.some(f => f.active && cellOf(f.x, f.z)[0] === c.c && cellOf(f.x, f.z)[1] === c.r);
    c.level = c.burning ? 3 : fieldLevel(c, true);
    if (c.level >= 2) redCells++;
    riskData[c.i * 4] = c.level * 85; riskData[c.i * 4 + 3] = 255;
  }
  riskTex.needsUpdate = true;
  S.redCells = redCells;
  for (let n = 0; n < NAV * NAV; n++){
    if (nav.blocked[n]) continue;
    const p = navCenter(n); sample(p.x, 1.5, p.z, s);
    const lv = Math.max(lvlOf(s.T, LIM.T.v), lvlOf(s.q, LIM.q.v));   // crews wear SCBA: routing keys on thermal load
    nav.level[n] = lv; nav.cost[n] = [1, 4, 30, Infinity][lv];
  }
}
function reroute(){
  for (const u of units){
    if (u.isDrone || !(u.mode === 'enroute' || u.mode === 'pullback') || !u.dest) continue;
    if (u.mode === 'enroute' && u.task && u.task.kind === 'foam') u.dest = taskTarget(u.task, u);
    const p = findPath(u.pos.x, u.pos.z, u.dest.x, u.dest.z, u.mode === 'pullback' || (u.task && u.task.kind === 'move'));
    if (p) u.path = p;
    else if (u.task){ u.task.status = 'blocked'; u.mode = 'idle'; u.path = null; u.status = 'Route blocked by hazard'; addLog(`${u.id}: route blocked`, 'l1'); }
  }
}


S.hooks.target = {};
export {
  THREE, CSS2DObject, S, bus, emitEv, onEv, addLog, setVisorEvent, fmt, tplus, topReason, spokenReason,
  HALF, CELLS, CELL, NAV, NAVC, COLS, clamp, lerp, rand, noise1, LIM, DRONE_T, LVL_NAME, lvlOf,
  sim, WV, updateWind, COMPASS, compass, cellName, cellOf, cellNameAt, cellCenter,
  stage, renderer, labelRenderer, scene, camera, controls, composer, bloom, uScale, uTime, lightPool, moon,
  ASSETS, W1, DRUM, DRAIN, label3D, ground, pad, gridLabels, makeLayer, emit, stepLayer, pMat, curl, C, SPRAY_FS,
  fires, Fire, sample, fieldLevel, cells, overlayMat, nav, navIdx, navCenter, findPath, freePoint, nearestFree,
  units, unitHits, unitById, STAGING, MUSTER, ADMIN_DOOR, LVL_COLORS,
  tasks, DRONE_KINDS, taskFire, primaryFire, taskTarget, assignTask, moveUnit, pullBack, safePointFor, ignite,
  step, updateRisk, reroute,
};
export const newTaskId = () => 't' + taskSeq++;
