// Atmosphere: sodium floodlights on poles, emergency beacons that light the ground, concrete/asphalt textures,
// drifting ash around the fire, and per-frame vehicle / drone motion details.
import { THREE, scene, units, fires, ground, pad, WV, sim, rand } from './core.js';

/* ---------------- procedural ground textures ---------------- */
function noiseCanvas(size, base, spread, cracks){
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++){
    const n = base + (Math.random() - 0.5) * spread + (Math.random() < 0.02 ? -spread : 0);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = Math.max(0, Math.min(255, n)); img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (cracks){
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1;
    for (let k = 0; k < cracks; k++){ g.beginPath(); let x = Math.random() * size, y = Math.random() * size; g.moveTo(x, y);
      for (let s = 0; s < 6; s++){ x += (Math.random() - 0.5) * 40; y += (Math.random() - 0.5) * 40; g.lineTo(x, y); } g.stroke(); }
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 2;                       // slab joints
    for (let k = 0; k <= size; k += size / 4){ g.beginPath(); g.moveTo(k, 0); g.lineTo(k, size); g.moveTo(0, k); g.lineTo(size, k); g.stroke(); }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
{
  const concrete = noiseCanvas(256, 128, 46, 10); concrete.repeat.set(14, 14);
  pad.material.map = concrete; pad.material.color.setHex(0xc9ccd0); pad.material.roughnessMap = concrete; pad.material.needsUpdate = true;
  const dirt = noiseCanvas(256, 110, 60, 0); dirt.repeat.set(60, 60);
  ground.material.map = dirt; ground.material.color.setHex(0x9ea58f); ground.material.needsUpdate = true;
}

/* ---------------- sodium floodlights on poles ---------------- */
const poleMat = new THREE.MeshStandardMaterial({ color:0x50555d, metalness:0.6, roughness:0.5 });
const lampMat = new THREE.MeshBasicMaterial({ color:0xffd9a0 });
for (const [x, z, tx, tz] of [[-78, 8, -66, 24], [-40, 64, -58, 56], [74, -36, 50, -52], [64, 58, 46, 44], [-2, 12, 10, -10]]){
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 14, 8), poleMat); pole.position.set(x, 7, z); pole.castShadow = true; scene.add(pole);
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.3, 0.7), lampMat); head.position.set(x, 14, z); scene.add(head);
  const L = new THREE.SpotLight(0xffc27a, 60, 80, 0.62, 0.65, 1.6);
  L.position.set(x, 13.8, z); L.target.position.set(tx, 0, tz); scene.add(L, L.target);
}

/* ---------------- beacons: one real light per truck, alternating red / blue ---------------- */
const beacons = units.filter(u => !u.isDrone).map(u => { const L = new THREE.PointLight(0xff2030, 0, 22, 2); scene.add(L); return { u, L }; });

/* ---------------- drifting ash ---------------- */
const N = 420, ashPos = new Float32Array(N * 3), ashVel = new Float32Array(N * 3), ashLife = new Float32Array(N);
const ashGeo = new THREE.BufferGeometry(); ashGeo.setAttribute('position', new THREE.BufferAttribute(ashPos, 3).setUsage(THREE.DynamicDrawUsage));
const ash = new THREE.Points(ashGeo, new THREE.PointsMaterial({ color:0x9a948c, size:0.16, sizeAttenuation:true, transparent:true, opacity:0.7, depthWrite:false }));
ash.frustumCulled = false; scene.add(ash);
function respawnAsh(i){
  const f = fires.filter(f => f.Ieff > 0.05)[(rand() * 2) | 0] || fires[0]; if (!f) return;
  ashPos[i * 3] = f.x + (rand() - 0.5) * 8; ashPos[i * 3 + 1] = (f.visBaseY ?? f.baseY) + 6 + rand() * 14; ashPos[i * 3 + 2] = f.z + (rand() - 0.5) * 8;
  ashVel[i * 3] = (rand() - 0.5) * 0.6; ashVel[i * 3 + 1] = -0.25 - rand() * 0.4; ashVel[i * 3 + 2] = (rand() - 0.5) * 0.6;
  ashLife[i] = 8 + rand() * 10;
}
for (let i = 0; i < N; i++){ respawnAsh(i); ashLife[i] = rand() * 14; }

/* ---------------- per-frame ---------------- */
const lastPos = new Map();
export function updateFx(dt, time){
  // beacons
  for (const { u, L } of beacons){
    const on = u.mode === 'enroute' || u.mode === 'working' || u.mode === 'pullback';
    const red = Math.floor(time * 6) % 2 === 0;
    L.color.setHex(red ? 0xff2030 : 0x2a5cff);
    L.intensity = on && u.mesh.visible ? 38 : 0;
    L.position.set(u.pos.x + Math.sin(u.heading) * 2.4, 3.6, u.pos.z + Math.cos(u.heading) * 2.4);
  }
  // vehicles: wheel spin + suspension bob; drones: lean into motion
  for (const u of units){
    const prev = lastPos.get(u) || u.pos.clone(); const d = prev.distanceTo(u.pos); lastPos.set(u, u.pos.clone());
    const sp = dt > 0 ? d / dt : 0;
    if (!u.isDrone){
      const ud = u.mesh.userData;
      for (const w of ud.wheels) w.rotation.x += d / 0.55;
      ud.body.position.y = sp > 0.3 ? Math.sin(time * 14 + u.home.z) * 0.035 : 0;
      ud.body.rotation.z = sp > 0.3 ? Math.sin(time * 9) * 0.006 : 0;
    } else {
      u.lean = (u.lean || 0) + (Math.min(sp, 12) * 0.03 - (u.lean || 0)) * Math.min(1, dt * 3);
      u.mesh.rotation.x = u.lean;
    }
  }
  // ash drifts downwind and settles
  const any = fires.some(f => f.Ieff > 0.05);
  for (let i = 0; i < N; i++){
    ashLife[i] -= dt;
    if (ashLife[i] <= 0 || ashPos[i * 3 + 1] < 0.1){ if (any) respawnAsh(i); else ashPos[i * 3 + 1] = -10; continue; }
    const j = i * 3, sway = Math.sin(time * 1.7 + i) * 0.4;
    ashPos[j] += (ashVel[j] + WV.x * sim.windSpeed * 0.6 + sway) * dt;
    ashPos[j + 1] += ashVel[j + 1] * dt;
    ashPos[j + 2] += (ashVel[j + 2] + WV.z * sim.windSpeed * 0.6 + Math.cos(time * 1.3 + i) * 0.4) * dt;
  }
  ashGeo.attributes.position.needsUpdate = true;
}
