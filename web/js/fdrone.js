// Factory scenario: firefighting drones (D4, D5). Each flies to the fire, hovers upwind above the flame tips and
// sprays foam; when its 40 L tank is empty it returns to the staging area to refill, then goes back.
// Spraying adds to the fire's suppression the same way an engine's foam monitor does, and the spray is drawn by
// the unit's own particle layer (main loop). Crew safety is unchanged: at a critical reading the generic
// auto-withdraw pulls the drone back.
import { S, WV, clamp, primaryFire, taskFire, addLog } from './core.js';

const TANK_SECONDS = 70;     // sim seconds of continuous spraying per tank
const REFILL_SECONDS = 35;   // sim seconds on the ground to refill
const POWER = 0.8;           // suppression contribution while spraying (an engine foam monitor is 1.0)

function flyTo(u, x, y, z, dt){
  const dx = x - u.pos.x, dz = z - u.pos.z, d = Math.hypot(dx, dz);
  const s = Math.min(d, u.speed * dt);
  if (d > 0.05){ u.pos.x += dx / d * s; u.pos.z += dz / d * s; u.targetHeading = Math.atan2(dx, dz); }
  u.pos.y += clamp(y - u.pos.y, -4 * dt, 4 * dt);
  return d < 2.5 && Math.abs(u.pos.y - y) < 2;
}

S.hooks.drone.dsup = (u, t, dt) => {
  const f = taskFire(t);
  u.tank = u.tank ?? 1;
  u.fd = u.fd || 'attack';
  if (!f || f.out){
    u.sprayOn = false;
    if (flyTo(u, u.home.x, 0, u.home.z, dt)){ t.status = 'done'; t.progress = 1; u.mode = 'idle'; u.task = null; u.status = 'Fire out · back at staging'; addLog(`${u.id} foam run complete`, 'ok'); }
    else u.status = 'Fire out · returning';
    return;
  }
  u.mode = 'working'; t.status = 'working';
  if (u.fd === 'reload'){
    u.sprayOn = false;
    if (flyTo(u, u.home.x, 0, u.home.z, dt)){
      u.refill = (u.refill || 0) + dt; u.status = `Refilling foam · ${Math.round(clamp(u.refill / REFILL_SECONDS, 0, 1) * 100)} %`;
      u.tank = clamp(u.refill / REFILL_SECONDS, 0, 1);
      if (u.refill >= REFILL_SECONDS){ u.refill = 0; u.tank = 1; u.fd = 'attack'; }
    } else u.status = 'Returning to refill';
    return;
  }
  // attack: hover 14 m upwind of the fire, just above the flame tips, nozzle on the base of the fire
  const hy = f.baseY + f.H + 12, hx = f.x - WV.x * 14, hz = f.z - WV.z * 14;
  if (flyTo(u, hx, hy, hz, dt) || u.sprayOn){
    u.sprayOn = true; u.sprayTo.set(f.x, f.baseY + 1.2, f.z); u.targetHeading = Math.atan2(f.x - u.pos.x, f.z - u.pos.z);
    f.suppress += POWER;
    u.tank = Math.max(0, u.tank - dt / TANK_SECONDS);
    t.progress = 1 - f.I;
    u.status = `Foam drop · ${f.name} at ${Math.round(f.I * 100)} % · tank ${Math.round(u.tank * 100)} %`;
    if (u.tank <= 0){ u.sprayOn = false; u.fd = 'reload'; u.refill = 0; addLog(`${u.id} tank empty, refilling`); }
  } else u.status = `Flying to ${f.name}`;
};
S.hooks.target.dsup = (t, u) => ({ x:u.pos.x, z:u.pos.z });
