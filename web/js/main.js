import {
  THREE, S, sim, scene, stage, gridLabels, renderer, labelRenderer, composer, bloom, camera, controls, uScale, uTime, fires, Fire, DRUM, lightPool,
  units, tasks, unitById, assignTask, addLog, step, updateRisk, reroute, overlayMat, emit, stepLayer, rand, LVL_COLORS, primaryFire, WV,
} from './core.js';
import { updateInterior, buildingAt } from './interior.js';
import './fusion.js';
import { P, updatePlanner, previewOverride, updateLive } from './planner.js';
import { probe } from './voice.js';
import { uiTick, uiFast, renderAll, UI } from './ui.js';
import { updateSound } from './sound.js';
import { updateFx } from './fx.js';
import './fdrone.js';
import { animateHumans, updateCrews, updateMuster } from './human.js';

/* character loader: runs until fonts are ready and the first frames are on screen */
{
  const bar = document.getElementById('lbar'), msg = document.getElementById('lmsg');
  const steps = ['linking drones', 'reading site sensors', 'loading fire model', 'calibrating plume', 'visor online'];
  let k = 0; const N = 22;
  const iv = setInterval(() => {
    k++; const fill = Math.min(N, Math.round(k / 30 * N));
    bar.textContent = '[' + '='.repeat(fill) + [...Array(N - fill)].map(() => '-+'[Math.random() * 2 | 0]).join('') + ']';
    msg.textContent = steps[Math.min(steps.length - 1, Math.floor(k / 30 * steps.length))];
  }, 50);
  Promise.all([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]).then(() => {
    clearInterval(iv); bar.textContent = '[' + '='.repeat(N) + ']'; msg.textContent = 'visor online';
    setTimeout(() => document.getElementById('loader').classList.add('done'), 250);
  });
}

/* ---------------- boot ---------------- */
fires.push(new Fire({ id:'F1', name:'Drum yard D-1', x:DRUM.x, z:DRUM.z, Qmax:50000, I:0.12, light:lightPool[0] }));
for (const t of tasks) if (t.auto) assignTask(t, unitById(t.unit));
addLog('Fire reported at drum yard D-1', 'l1');
updateRisk();
probe().then(h => addLog(h ? `AI services: ${['llm', 'yolo', 'gnn'].filter(k => h[k]).join(', ') || 'none'}${h.cuda ? ' · GPU' : ''}` : 'AI backend offline: offline parser + zone model', h ? 'ok' : 'l1'));

function resize(){
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h); composer.setSize(w, h); labelRenderer.setSize(w, h); bloom.resolution.set(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  uScale.value = renderer.getPixelRatio() * h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
new ResizeObserver(resize).observe(stage); resize();

/* ---------------- loop ---------------- */
const clock = new THREE.Clock();
let riskAcc = 0, routeAcc = 0, uiAcc = 0, histAcc = 0;
const tmpV = new THREE.Vector3();
function frame(){
  const dt = Math.min(clock.getDelta(), 0.05);
  S.clock += dt; uTime.value = S.clock;
  if (!sim.paused){ let sdt = dt * sim.speed; sim.t += sdt; while (sdt > 0){ const h = Math.min(sdt, 0.25); step(h); sdt -= h; } }
  for (const f of fires) f.visualStep(dt, S.clock);
  const uf = overlayMat.uniforms.uFires.value;
  for (let i = 0; i < 3; i++){ const f = fires[i]; if (f && f.Ieff > 0.01){ const c = f.center(); uf[i].set(c.x, c.z, f.Q, c.y - 1.5); } else uf[i].set(0, 0, 0, 0); }

  for (const u of units){
    let dh = u.targetHeading - u.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); u.heading += dh * Math.min(1, dt * 5);
    u.mesh.position.copy(u.pos); u.mesh.rotation.y = u.heading;
    const inside = buildingAt(u.pos.x, u.pos.z);
    const hidden = inside && S.view !== inside.id;          // inside a building you are not looking into
    u.mesh.visible = !hidden; u.label.visible = !hidden; u.ring.visible = !hidden && !inside;
    if (u.isDrone){
      u.mesh.position.y = u.pos.y + 0.6 + Math.sin(S.clock * 2 + u.home.z) * 0.15 * (u.pos.y > 1 ? 1 : 0);
      for (const r of u.mesh.userData.rotors) r.rotation.y += dt * (u.pos.y > 0.2 ? 40 : 0);
      const tp = u.tether.geometry.attributes.position; tp.setXYZ(0, u.pos.x, 0.1, u.pos.z); tp.setXYZ(1, u.pos.x, u.mesh.position.y, u.pos.z); tp.needsUpdate = true;
      u.tether.visible = !inside;
      if (u.indoor) u.mesh.scale.setScalar(inside ? 0.9 : 1.2);
    } else {
      const on = u.mode === 'enroute' || u.mode === 'working' || u.mode === 'pullback';
      const [lr, lb] = u.mesh.userData.lights; const ph = Math.floor(S.clock * 6) % 2;
      lr.visible = on && ph === 0; lb.visible = on && ph === 1;
    }
    u.ring.position.set(u.pos.x, 0.12, u.pos.z);
    u.ring.material.color.setHex(LVL_COLORS[u.level]);
    u.ring.material.opacity = u.level >= 3 ? 0.55 + 0.4 * Math.sin(S.clock * 8) : u.level ? 0.8 : 0.45;
    u.ring.scale.setScalar(UI.sel && UI.sel.u === u ? 1.25 : 1);
    u.hit.position.set(u.pos.x, (u.isDrone ? u.pos.y : 0) + 2, u.pos.z);
    u.label.position.set(u.pos.x, (u.isDrone ? u.mesh.position.y : 3.2) + (inside ? 1.6 : 3), u.pos.z);
    if (u.spray){
      const L = u.spray;
      if (u.sprayOn){
        tmpV.set(Math.sin(u.heading) * 1.5, u.isDrone ? -1.6 : 3.2, Math.cos(u.heading) * 1.5).add(u.pos);
        emit(L, 110, dt, (i, j) => {
          const T = 1.0 + rand() * 0.35; L.life[i] = T;
          L.pos[j] = tmpV.x; L.pos[j + 1] = tmpV.y; L.pos[j + 2] = tmpV.z;
          const tx = u.sprayTo.x + (rand() - 0.5) * 2.5, ty = u.sprayTo.y, tz = u.sprayTo.z + (rand() - 0.5) * 2.5;
          L.vel[j] = (tx - tmpV.x) / T; L.vel[j + 1] = (ty - tmpV.y) / T + 4.9 * T; L.vel[j + 2] = (tz - tmpV.z) / T;
          L.size[i] = 0.45 + rand() * 0.5;
        });
      }
      stepLayer(L, dt, (i, a, j, P_, V_) => { V_[j + 1] -= 9.8 * dt; P_[j] += V_[j] * dt; P_[j + 1] = Math.max(0.1, P_[j + 1] + V_[j + 1] * dt); P_[j + 2] += V_[j + 2] * dt; });
    }
  }
  updatePlanner(dt);
  { const g = overlayMat.uniforms.uGrid; g.value += ((S.gridTarget || 0) - g.value) * Math.min(1, dt * 5);
    const show = g.value > 0.5; if (show !== S.gridShown){ S.gridShown = show; gridLabels.forEach(l => l.visible = show); } }
  updateCrews(dt); updateMuster(dt, S.clock); updateFx(dt, S.clock); animateHumans(dt, S.clock);
  updateSound(Math.min(1, fires.reduce((a, f) => a + f.Ieff, 0)), sim.windSpeed, dt, S.clock);
  updateLive(S.clock);
  updateInterior(dt, S.clock, previewOverride());

  riskAcc += dt; routeAcc += dt; uiAcc += dt; histAcc += dt;
  if (riskAcc > 0.5){ riskAcc = 0; updateRisk(); }
  if (routeAcc > 1){ routeAcc = 0; if (!sim.paused) reroute(); }
  if (histAcc > 0.5){ histAcc = 0; if (!sim.paused) for (const u of units){ u.hist.push({ T:u.sens.T }); if (u.hist.length > 80) u.hist.shift(); } }
  if (uiAcc > 0.25){
    uiAcc = 0; uiTick();
    for (const u of units){
      u.labelEl.firstElementChild.className = `d l${u.level}`;
      u.labelEl.classList.toggle('sel', !!(UI.sel && UI.sel.u === u));
      u.labelEl.lastElementChild.textContent = u.level >= 2 ? ` ${Math.round(u.sens.T)}°` : '';
      const pa = u.route.geometry.attributes.position; let n = 0;
      if (u.path && u.path.length && !u.isDrone){
        pa.setXYZ(n++, u.pos.x, 0.3, u.pos.z);
        for (const p of u.path){ if (n >= 64) break; pa.setXYZ(n++, p.x, 0.3, p.z); }
      }
      pa.needsUpdate = true; u.route.geometry.setDrawRange(0, n);
      u.route.material.color.setHex(u.mode === 'pullback' ? 0xffb020 : 0xece9e2);
    }
  } else if (P.open) uiFast();
  controls.update();
  composer.render();
  labelRenderer.render(scene, camera);
  requestAnimationFrame(frame);
}
renderAll(true);
requestAnimationFrame(frame);
window.__a3tn = { sim, units, fires, P, scene, camera, controls };   // debug handle
