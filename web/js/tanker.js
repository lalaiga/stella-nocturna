// Factory scenario: aerial firefighting (air tanker) — flight path, drop-zone clearance, water curtain,
// steam and wet ground, suppression of the fire, HUD status and Visor messages.
import {
  THREE, S, scene, sim, fires, units, WV, W1, addLog, setVisorEvent, emitEv, moveUnit, assignTask, makeLayer, emit, stepLayer, pMat, SPRAY_FS,
  primaryFire, clamp, rand,
} from './core.js';
import { makeTankerMesh, animateTanker } from './tanker_model.js';

const SPEED = 62;                 // m/s on the drop run (~120 kt); slower than cruise for a CL-415-class tanker
const CAP = 6000;                 // litres
const DROP_LEN = 90, CORRIDOR_W = 50, CLEAR = 30;   // m
export const T = { phase:'idle', auto:false, payload:1, alt:0, speedKmh:0, eta:null, passes:0, cooldown:0 };

const plane = makeTankerMesh(THREE, 1.15); plane.visible = false; scene.add(plane);

// water curtain + mist (normal blend) and steam (soft additive white)
const water = makeLayer(1800, pMat(SPRAY_FS, {}, THREE.NormalBlending, { grow:2.5 }), 4);
const STEAM_FS = `varying float vAge; varying float vSeed;
  void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
    float s = pow(1.0 - r, 2.0); float f = smoothstep(0.0, 0.15, vAge) * (1.0 - smoothstep(0.4, 1.0, vAge));
    gl_FragColor = vec4(vec3(0.95, 0.97, 1.0) * 0.55, s * f * 0.7); }`;
const steam = makeLayer(900, pMat(STEAM_FS, {}, THREE.NormalBlending, { grow:4 }), 4);
const steamQueue = [];
// wet / darkened ground after the drop
const wet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color:0x1f2a33, transparent:true, opacity:0, depthWrite:false }));
wet.rotation.x = -Math.PI / 2; wet.renderOrder = 1; scene.add(wet);

let curve = null, len = 0, s = 0, sDropA = 0, sDropB = 0, target = null, axis = null, cleared = [], warned = false, dropped = false, prevYaw = 0;

export function dispatchTanker(reason = 'manual'){
  if (T.phase !== 'idle') return false;
  const f = primaryFire(); if (!f){ addLog('Air tanker: no active fire', 'l1'); return false; }
  target = f;
  // attack heading aligned with the wind: run downwind along the fire front
  const d = new THREE.Vector3(WV.x, 0, WV.z).normalize(), side = new THREE.Vector3(-d.z, 0, d.x);
  const F = new THREE.Vector3(f.x, 0, f.z), dropY = Math.max(f.baseY + f.H + 22, 32);
  const at = (along, lat, y) => F.clone().addScaledVector(d, along).addScaledVector(side, lat).setY(y);
  // enters off-screen at an angle, banks onto the attack heading, descends, drops, climbs out
  const pts = [at(-1300, 900, 260), at(-700, 380, 170), at(-320, 40, 75), at(-DROP_LEN / 2 - 40, 0, dropY + 4), at(-DROP_LEN / 2, 0, dropY),
               at(DROP_LEN / 2, 0, dropY), at(DROP_LEN / 2 + 120, 0, dropY + 25), at(600, -200, 200), at(1300, -700, 300)];
  curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal'); len = curve.getLength();
  const lengths = curve.getLengths(400);
  const sOf = p => { let best = 0, bd = 1e9; for (let i = 0; i <= 400; i++){ const q = curve.getPointAt(i / 400); const dd = q.distanceToSquared(p); if (dd < bd){ bd = dd; best = i; } } return best / 400 * len; };
  sDropA = sOf(pts[4]); sDropB = sOf(pts[5]);
  axis = { F, d, side, dropY };
  s = 0; warned = false; dropped = false; cleared = []; T.payload = 1; T.phase = 'inbound'; T.passes++;
  plane.visible = true;
  addLog(`Air tanker dispatched (${reason}) · attack run ${compassOf(d)} over ${f.name}`, 'l1', 'Air tanker dispatched. Attack run along the wind.');
  emitEv('tanker', T);
  return true;
}
const compassOf = d => ['N','NE','E','SE','S','SW','W','NW'][Math.round(((Math.atan2(d.x, -d.z) * 180 / Math.PI) + 360) % 360 / 45) % 8];

function inCorridor(x, z, margin = 0){
  const v = new THREE.Vector3(x - axis.F.x, 0, z - axis.F.z);
  return Math.abs(v.dot(axis.d)) < DROP_LEN / 2 + CLEAR + margin && Math.abs(v.dot(axis.side)) < CORRIDOR_W / 2 + margin;
}
function clearCorridor(){
  for (const u of units){
    if (u.isDrone || !inCorridor(u.pos.x, u.pos.z, 8)) continue;
    const v = new THREE.Vector3(u.pos.x - axis.F.x, 0, u.pos.z - axis.F.z), lat = v.dot(axis.side) >= 0 ? 1 : -1;
    const p = axis.F.clone().addScaledVector(axis.d, v.dot(axis.d)).addScaledVector(axis.side, lat * (CORRIDOR_W / 2 + 18));
    cleared.push({ u, task:u.task && !['done', 'cancelled'].includes(u.task.status) ? u.task : null });
    moveUnit(u, p.x, p.z);
    u.status = 'Holding clear of drop corridor';
  }
  setVisorEvent(`<b>AERIAL DROP INBOUND</b>Clearing drop zone corridor${cleared.length ? ' · ' + cleared.map(c => c.u.id).join(' ') + ' moving out' : ''}`, 12,
    'Aerial drop inbound. Clearing drop zone corridor.');
  addLog(`Drop corridor cleared${cleared.length ? ': ' + cleared.map(c => c.u.id).join(', ') : ''}`, 'l1');
}
function applyDrop(){
  // knock down every fire under the drop line, in proportion to coverage
  for (const f of fires){
    if (f.out) continue;
    const v = new THREE.Vector3(f.x - axis.F.x, 0, f.z - axis.F.z);
    const along = Math.abs(v.dot(axis.d)) - DROP_LEN / 2, lat = Math.abs(v.dot(axis.side));
    const dist = Math.max(0, along) + Math.max(0, lat - f.R);
    const cover = clamp(1 - dist / 30, 0, 1); if (!cover) continue;
    f.I *= 1 - 0.8 * cover;
    if (f.I < 0.08) f.I = 0.01;                  // fully knocked down: core marks it out on the next step
  }
  if (!W1.burning) W1.dose *= 0.4;
  const active = fires.filter(f => !f.out && f.I > 0.02);
  const worst = active.length ? Math.max(...active.map(f => f.I)) : 0;
  if (!active.length || worst < 0.05){
    setVisorEvent('<b>Visor quiet</b>Fire suppressed, sector cooling', 20, 'Visor. Fire suppressed. Sector cooling.');
    addLog('Air tanker drop: fire suppressed, sector cooling', 'ok');
  } else {
    setVisorEvent(`<b>Drop complete</b>fire knocked down to ${Math.round(worst * 100)} %`, 10, `Drop complete. Fire down to ${Math.round(worst * 100)} percent.`);
    addLog(`Air tanker drop: fire down to ${Math.round(worst * 100)} %`, 'ok');
  }
  // wet ground footprint
  wet.position.set(axis.F.x, 0.09, axis.F.z); wet.rotation.z = -Math.atan2(axis.d.z, axis.d.x);
  wet.scale.set(DROP_LEN + 20, CORRIDOR_W, 1); wet.material.opacity = 0.5; T.wetT = 0;
}
function releaseCleared(){
  for (const c of cleared) if (c.task && !['done', 'cancelled'].includes(c.task.status)) assignTask(c.task, c.u);
  if (cleared.length) addLog(`Drop corridor reopened · ${cleared.map(c => c.u.id).join(', ')} back to work`);
  cleared = [];
}

const tmp = new THREE.Vector3(), tan = new THREE.Vector3();
export function updateTanker(dt, time){
  // auto-dispatch on high intensity
  T.cooldown = Math.max(0, T.cooldown - (sim.paused ? 0 : dt * sim.speed));
  if (T.auto && T.phase === 'idle' && !T.cooldown && fires.some(f => !f.out && f.Ieff > 0.55)) dispatchTanker('auto: fire above threshold');
  // wet ground dries
  if (wet.material.opacity > 0 && !sim.paused){ T.wetT += dt * sim.speed; wet.material.opacity = Math.max(0, 0.5 * (1 - T.wetT / 600)); }
  // particles always animate in real time
  const g = 9.8;
  stepLayer(water, dt, (i, a, j, P, V) => {
    V[j + 1] -= g * dt; V[j] += WV.x * sim.windSpeed * 0.3 * dt; V[j + 2] += WV.z * sim.windSpeed * 0.3 * dt;
    P[j] += V[j] * dt; P[j + 1] += V[j + 1] * dt; P[j + 2] += V[j + 2] * dt;
    if (P[j + 1] <= 0.3){ P[j + 1] = 0.3; V[j] *= 0.2; V[j + 1] = 0; V[j + 2] *= 0.2; if (rand() < 0.08) steamQueue.push([P[j], P[j + 2]]); water.age[i] = 0.97; }
  });
  while (steamQueue.length){
    const [x, z] = steamQueue.pop();
    const hot = fires.some(f => (f.Ieff > 0.02 || f.out) && Math.hypot(f.x - x, f.z - z) < f.R + 14);
    emit(steam, 1 / dt, dt, (i, j) => { steam.pos[j] = x + (rand() - 0.5) * 3; steam.pos[j + 1] = 0.8; steam.pos[j + 2] = z + (rand() - 0.5) * 3;
      steam.vel[j] = (rand() - 0.5) * 1.5; steam.vel[j + 1] = (hot ? 3.5 : 1.2) + rand() * 2; steam.vel[j + 2] = (rand() - 0.5) * 1.5;
      steam.life[i] = (hot ? 6 : 2.5) + rand() * 3; steam.size[i] = (hot ? 5 : 2.5) + rand() * 3; });
  }
  stepLayer(steam, dt, (i, a, j, P, V) => { P[j] += (V[j] + WV.x * sim.windSpeed * 0.5 * a) * dt; P[j + 1] += V[j + 1] * (1 - a * 0.6) * dt; P[j + 2] += (V[j + 2] + WV.z * sim.windSpeed * 0.5 * a) * dt; });

  if (T.phase === 'idle' || !curve){ plane.visible = false; T.eta = null; return; }
  // the aircraft flies in (bounded) sim time so it stays watchable at 20×
  const sdt = sim.paused ? 0 : dt * Math.min(sim.speed, 3);
  const v = s < sDropA - 400 ? SPEED * 1.35 : SPEED;
  s = Math.min(len, s + v * sdt);
  const u = s / len;
  curve.getPointAt(u, tmp); curve.getTangentAt(u, tan);
  plane.position.copy(tmp);
  const yaw = Math.atan2(tan.x, tan.z);
  let dy = yaw - prevYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); prevYaw = yaw;
  plane.rotation.y = yaw;
  const roll = clamp(-dy / Math.max(sdt, 1e-3) * 1.6, -0.75, 0.75);
  plane.userData.roll = (plane.userData.roll || 0) + (roll - (plane.userData.roll || 0)) * Math.min(1, dt * 3);
  const pitch = clamp(-Math.asin(clamp(tan.y, -1, 1)), -0.35, 0.35);
  const dropping = s >= sDropA && s <= sDropB && T.payload > 0;
  animateTanker(plane, time, { roll:plane.userData.roll, pitch, doorsOpen:dropping });
  T.alt = Math.max(0, tmp.y); T.speedKmh = v * 3.6 * (sdt ? 1 : 0); T.eta = s < sDropA ? (sDropA - s) / (v * 0.95) : null;
  if (s < sDropA) T.phase = 'inbound';
  // pre-drop safety: clear the corridor ~25 s before the drop
  if (!warned && T.eta !== null && T.eta < 25){ warned = true; clearCorridor(); }
  if (dropping){
    T.phase = 'drop';
    T.payload = Math.max(0, 1 - (s - sDropA) / (sDropB - sDropA));
    // curtain from the belly doors, trailing behind the aircraft
    emit(water, 1400, dt, (i, j) => {
      water.pos[j] = tmp.x + (rand() - 0.5) * 2; water.pos[j + 1] = tmp.y - 1.5; water.pos[j + 2] = tmp.z + (rand() - 0.5) * 2;
      water.vel[j] = tan.x * v * 0.35 + (rand() - 0.5) * 4; water.vel[j + 1] = -2 - rand() * 3; water.vel[j + 2] = tan.z * v * 0.35 + (rand() - 0.5) * 4;
      water.life[i] = 3.5 + rand() * 1.5; water.size[i] = 0.6 + rand() * 1.2;
    });
  }
  if (!dropped && s > sDropB){ dropped = true; T.payload = 0; applyDrop(); T.phase = 'climb'; setTimeout(releaseCleared, 4000); }
  if (s >= len){
    T.phase = 'idle'; plane.visible = false; curve = null; T.cooldown = 240;   // 4 min to reload before the next pass
    addLog('Air tanker returning to reload (~4 min)');
  }
}
export function tankerStatus(){
  const ph = { idle:T.cooldown ? 'reloading' : 'on standby', inbound:'inbound', drop:'DROPPING', climb:'climbing out' }[T.phase];
  return { ...T, label:ph };
}
