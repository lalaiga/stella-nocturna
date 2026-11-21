// Articulated low-poly people with walk / idle animation, plus the crowds that make the site feel inhabited:
// crews beside their trucks, evacuated staff at the muster point.
import { THREE, scene, units, tasks, MUSTER, rand } from './core.js';

const ROLES = {
  ff:     { coat:0x23272f, pants:0x23272f, band:0xd6e83a, helmet:0xd9a521, tank:true },
  worker: { coat:0x2f5d9e, pants:0x27324a, band:0xff8a1f, helmet:0xf0f0ec },
  hazmat: { coat:0xd2bd25, pants:0xd2bd25, band:0x30343b, helmet:0xd2bd25, tank:true },
  medic:  { coat:0xe6e6e2, pants:0x27324a, band:0x2aa36a, helmet:0xf0f0ec },
};
const SKINS = [0x8d6a52, 0x6f4e3b, 0xa47e64, 0x5a3f30];
const matCache = new Map();
const mat = (c, emissive = 0) => {
  const k = c + ':' + emissive;
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color:c, roughness:0.75, metalness:0.05, emissive:emissive ? c : 0, emissiveIntensity:emissive }));
  return matCache.get(k);
};
const G = {
  torso: new THREE.BoxGeometry(0.44, 0.62, 0.27), band: new THREE.BoxGeometry(0.45, 0.06, 0.28),
  head: new THREE.SphereGeometry(0.12, 14, 10), helmet: new THREE.SphereGeometry(0.145, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  brim: new THREE.CylinderGeometry(0.17, 0.17, 0.02, 16), leg: new THREE.BoxGeometry(0.16, 0.86, 0.18), boot: new THREE.BoxGeometry(0.17, 0.12, 0.28),
  arm: new THREE.BoxGeometry(0.12, 0.6, 0.13), hand: new THREE.SphereGeometry(0.06, 8, 6), tank: new THREE.CylinderGeometry(0.11, 0.11, 0.56, 12),
};
export const HUMANS = [];

export function makeHuman(role = 'worker'){
  const R = ROLES[role] || ROLES.worker;
  const g = new THREE.Group();
  const add = (geo, m, x, y, z, parent = g) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = geo === G.torso; parent.add(o); return o; };
  const torso = new THREE.Group(); torso.position.y = 0.95; g.add(torso);
  add(G.torso, mat(R.coat), 0, 0.33, 0, torso);
  add(G.band, mat(R.band, 0.5), 0, 0.12, 0, torso); add(G.band, mat(R.band, 0.5), 0, 0.42, 0, torso);
  add(G.head, mat(SKINS[(rand() * SKINS.length) | 0]), 0, 0.76, 0.01, torso);
  add(G.helmet, mat(R.helmet), 0, 0.8, 0, torso); add(G.brim, mat(R.helmet), 0, 0.8, 0.02, torso);
  if (R.tank) add(G.tank, new THREE.MeshStandardMaterial({ color:0xcfd3d8, metalness:0.8, roughness:0.3 }), 0, 0.33, -0.21, torso);
  const limb = (geo, m, x, y, len, extra) => {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0); g.add(pivot);
    add(geo, m, 0, -len / 2, 0, pivot); if (extra) extra(pivot);
    return pivot;
  };
  const legs = [-0.11, 0.11].map(x => limb(G.leg, mat(R.pants), x, 0.95, 0.86, p => add(G.boot, mat(0x141414), 0, -0.88, 0.04, p)));
  const arms = [-0.29, 0.29].map(x => limb(G.arm, mat(R.coat), x, 1.5, 0.6, p => add(G.hand, mat(0x2a2a2a), 0, -0.63, 0, p)));
  g.userData = { legs, arms, torso, phase:rand() * 6.28, role, prev:new THREE.Vector3(), speed:0, pose:'auto' };
  HUMANS.push(g);
  return g;
}

/* call once per frame for every human: infers speed from movement and animates limbs */
export function animateHumans(dt, time){
  for (const h of HUMANS){
    const u = h.userData;
    if (!h.visible || !h.parent) continue;
    const moved = h.position.distanceTo(u.prev); u.prev.copy(h.position);
    const sp = dt > 0 ? moved / dt : 0; u.speed += (Math.min(sp, 3) - u.speed) * Math.min(1, dt * 8);
    if (u.pose === 'lying') continue;
    if (u.pose === 'nozzle'){                         // arms forward, braced stance
      u.arms.forEach((a, i) => { a.rotation.x = -1.25 + Math.sin(time * 9 + i) * 0.03; });
      u.legs[0].rotation.x = 0.35; u.legs[1].rotation.x = -0.25;
      continue;
    }
    if (u.pose === 'carry'){ u.arms.forEach(a => { a.rotation.x = -0.9; }); }
    const walk = Math.min(1, u.speed / 1.2);
    u.phase += dt * (2 + u.speed * 4.5);
    const s = Math.sin(u.phase);
    u.legs[0].rotation.x = s * 0.6 * walk; u.legs[1].rotation.x = -s * 0.6 * walk;
    if (u.pose !== 'carry'){ u.arms[0].rotation.x = -s * 0.5 * walk + Math.sin(time * 1.3 + u.phase) * 0.04 * (1 - walk); u.arms[1].rotation.x = s * 0.5 * walk - Math.sin(time * 1.3 + u.phase) * 0.04 * (1 - walk); }
    u.torso.position.y = 0.95 + Math.abs(Math.cos(u.phase)) * 0.04 * walk + Math.sin(time * 1.6 + u.phase) * 0.006;
    u.torso.rotation.y = Math.sin(time * 0.4 + u.phase) * 0.08 * (1 - walk);          // idle look-around
  }
}
export function setLying(h){ h.userData.pose = 'lying'; h.rotation.set(0, h.rotation.y, Math.PI / 2); h.position.y = 0.24; }

/* ---------------- crews beside their trucks ---------------- */
const CREW_ROLE = { engine:'ff', hazmat:'hazmat', rescue:'medic' };
const crews = [];
for (const u of units){
  if (u.isDrone) continue;
  const n = u.kind === 'rescue' ? 2 : 3;
  const people = Array.from({ length:n }, () => { const h = makeHuman(CREW_ROLE[u.kind] || 'ff'); scene.add(h); return h; });
  crews.push({ u, people, slots:[[-2.0, 1.4], [-2.2, -0.6], [2.0, -1.6]].slice(0, n) });
}
const fwd = new THREE.Vector3();
export function updateCrews(dt){
  for (const c of crews){
    const u = c.u, moving = (u.path && u.path.length) || u.mode === 'pullback' && u.path;
    const inside = u.hiddenBySlide || !u.mesh.visible;
    c.people.forEach((h, i) => {
      h.visible = !moving && !inside;
      if (!h.visible){ h.userData.prev.set(1e9, 0, 0); return; }
      const [sx, sz] = c.slots[i], ch = Math.cos(u.heading), sh = Math.sin(u.heading);
      // nozzle operator stands ahead of the truck while it is spraying
      if (i === 0 && u.sprayOn){
        fwd.set(sh, 0, ch);
        h.position.set(u.pos.x + fwd.x * 4.2 + ch * -0.6, 0, u.pos.z + fwd.z * 4.2 - sh * -0.6);
        h.rotation.y = u.heading; h.userData.pose = 'nozzle';
      } else {
        h.position.set(u.pos.x + sx * ch + sz * sh, 0, u.pos.z - sx * sh + sz * ch);
        h.rotation.y = u.heading + (i % 2 ? 0.6 : -0.4); h.userData.pose = 'auto';
      }
    });
  }
}

/* ---------------- evacuated staff gathering at the muster point ---------------- */
const staff = Array.from({ length:17 }, (_, i) => {
  const h = makeHuman('worker');
  const a = i * 2.39996, r = 1.1 * Math.sqrt(i + 0.5);       // sunflower spread
  h.userData.home = new THREE.Vector3(MUSTER.x + Math.cos(a) * r, 0, MUSTER.z + Math.sin(a) * r);
  h.position.copy(h.userData.home); h.rotation.y = rand() * 6.28; h.visible = false; scene.add(h);
  return h;
});
export function updateMuster(dt, time, override){
  const evac = tasks.find(t => t.kind === 'evac');
  const n = override ?? (evac ? Math.floor(evac.phase === 1 || evac.status === 'done' ? evac.evac : 0) : 0);
  staff.forEach((h, i) => {
    h.visible = i < n;
    if (h.visible){ h.rotation.y += Math.sin(time * 0.3 + i) * dt * 0.2; }
  });
}
