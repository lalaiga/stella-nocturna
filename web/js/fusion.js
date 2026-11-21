// Sensor fusion.
//  - Temperature per risk cell: Gaussian (inverse-variance) fusion of the physics model prior with every
//    sensor reading inside the cell (crew wearables, drones, fixed heat detectors).
//  - Fire presence per cell: log-odds Bayesian update from fixed heat detectors and YOLO detections on
//    the drone camera, with forgetting so stale evidence fades.
//  - Person presence: log-odds update from thermal scans (P(detect|present)=0.95, false alarm 0.03).
import { THREE, CSS2DObject, S, scene, sim, units, cells, cellOf, sample, onEv, addLog, primaryFire, clamp, rand } from './core.js';

const logit = p => Math.log(p / (1 - p));
const sigm = L => 1 / (1 + Math.exp(-L));
const R_SENSOR = { crew:4, drone:49, detector:1 };      // measurement variances (°C²)
const P_MODEL = 144;                                     // physics-model prior variance (±12 °C)

/* ---------------- fixed site detectors (57 °C fixed-temperature heat detectors) ---------------- */
export const DETECTORS = [
  ['HD-1', 2, -21], ['HD-2', -6.4, -30], ['HD-3', 4, -9], ['HD-4', 22, -38],
  ['HD-5', 40, 30], ['HD-6', -37.6, -4], ['HD-7', -48, 43.4], ['HD-8', -60, 20],
].map(([id, x, z]) => ({ id, x, z, T:20, alarm:false }));
for (const d of DETECTORS){
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 8), new THREE.MeshStandardMaterial({ color:0x4a4f58 }));
  post.position.y = 1.2; g.add(post);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color:0x3ddc97 }));
  led.position.y = 2.5; g.add(led); d.led = led;
  g.position.set(d.x, 0, d.z); scene.add(g);
}

for (const c of cells){ c.Lfire = 0; c.fireP = 0.5; c.Tf = 20; c.Tsd = 12; c.src = []; c.yolo = 0; }
const cellAt = (x, z) => { const [c, r] = cellOf(x, z); return cells[r * 10 + c]; };

// YOLO observation from the drone camera feed (emitted by the UI camera panel)
onEv('yolo', ({ fire, smoke }) => {
  const f = primaryFire(); if (!f) return;
  const c = cellAt(f.x, f.z);
  const p = Math.max(fire, smoke * 0.8);
  if (p > 0){ c.Lfire += clamp(logit(clamp(p, 0.05, 0.98)), -2, 4); c.yolo = Math.max(c.yolo, p); }
  else c.Lfire -= 0.4;
});
onEv('observe-person', ({ person, hit }) => {
  const prior = person.prob || 0.5;
  person.prob = sigm(logit(clamp(prior, 0.01, 0.99)) + (hit ? Math.log(0.95 / 0.03) : Math.log(0.05 / 0.97)));
  if (person.prob > 0.8) person.found = true;
});

let acc = 0;
function fusionStep(dt){
  acc += dt; if (acc < 1) return; const dts = acc; acc = 0;
  const s = {};
  // detectors
  for (const d of DETECTORS){
    sample(d.x, 2.5, d.z, s); d.T = s.T + (rand() - 0.5) * 0.5;
    const was = d.alarm; d.alarm = d.T >= 57;
    d.led.material.color.setHex(d.alarm ? 0xff3b30 : 0x3ddc97);
    if (d.alarm && !was) addLog(`${d.id} heat detector alarm (${Math.round(d.T)} °C)`, 'l1');
  }
  for (const c of cells){
    // Gaussian fusion of model prior + sensors in this cell
    let w = 1 / P_MODEL, wx = c.T / P_MODEL; const src = ['model'];
    for (const u of units){
      const uc = cellAt(u.pos.x, u.pos.z); if (uc !== c) continue;
      const R = u.isDrone ? (u.pos.y > 6 ? 400 : R_SENSOR.drone) : R_SENSOR.crew;   // high drones see the plume, not the ground
      w += 1 / R; wx += u.sens.T / R; src.push(u.id);
    }
    for (const d of DETECTORS){
      if (cellAt(d.x, d.z) !== c) continue;
      w += 1 / R_SENSOR.detector; wx += d.T / R_SENSOR.detector; src.push(d.id);
      c.Lfire += d.alarm ? Math.log(20) : -0.15;
    }
    c.Tf = wx / w; c.Tsd = Math.sqrt(1 / w);
    // weak physics evidence + forgetting toward the prior
    if (c.q > 10) c.Lfire += 0.5; else if (c.q < 1) c.Lfire -= 0.2;
    c.Lfire = clamp(c.Lfire * Math.pow(0.97, dts), -8, 8);
    c.fireP = sigm(c.Lfire);
    if (c.yolo > 0) src.push('YOLO'); c.yolo *= 0.9;
    c.src = src;
  }
}
S.hooks.step.push(fusionStep);
