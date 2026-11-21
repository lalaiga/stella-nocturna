// A3TN pitch deck: one live 3D world, each slide is a camera move + scene state, text decodes in.
// [ export pdf ] renders every slide to a still and prints it with the exact same text (deck == PDF).
import {
  THREE, S, scene, camera, controls, renderer, composer, labelRenderer, bloom, uScale, uTime, fires, Fire, DRUM, lightPool,
  units, unitById, updateRisk, overlayMat, W1, ignite, sim, LVL_COLORS,
} from './core.js';
import { BUILDINGS, enterBuilding, exitBuilding, updateInterior } from './interior.js';
import { toggleSound, updateSound } from './sound.js';

/* ---------------- numbers shown on slides (update after training) ---------------- */
const M = {
  yoloMap50: '0.74',      // final mAP@0.5 on the 4,306-image held-out D-Fire split (ml/models/yolo_metrics.txt)
  gnnT: '1.9 °C', gnnS: '0.007',
  team: 'team name', repo: 'github.com/‹account›/a3tn-command',
};
const T = s => `<span class="todo">${s}</span>`;   // things the team must fill in
const htmlOf = i => SLIDES[i].html.replaceAll('{n}', String(i + 1).padStart(2, '0'));

/* ---------------- slides ---------------- */
const SLIDES = [
  { cam:[-74, 34, 58], at:[2, 5, -26], drift:0.02, html:`
    <div class="pos-tl"><div class="k">// {n} — Gabès industrial zone, 02:14</div>
      <h1>Two workers<br>are inside.</h1>
      <p class="lead">Where are they?<br><span class="dim">Can we reach them alive?</span></p></div>
    <div class="pos-br"><div class="mark">A3TN</div><div class="k">// Command · Tunisian Aeroday · ${T(M.team)}</div></div>` },

  { cam:[-36, 20, -4], at:[-8, 13, -36], drift:0.015, html:`
    <div class="pos-tl"><div class="k">// {n} — The problem</div><h2>Industrial fires<br>are fought blind.</h2></div>
    <div class="pos-bl"><ul class="list">
      <li>Toxic plumes, explosion risk, chemical loads</li>
      <li>Large buildings with people still inside</li>
      <li>No live exposure data for each firefighter</li>
      <li>No forecast of smoke inside buildings</li>
      <li>Gloves and breathing apparatus: no hands for screens</li></ul></div>
    <div class="pos-br"><div class="k">${T('2 sourced figures: e.g. Gabès / GCT incidents, firefighter disorientation deaths')}</div></div>` },

  { cam:[-62, 46, 30], at:[-10, 0, -20], drift:0.015, html:`
    <div class="pos-tl"><div class="k">// {n} — Need study</div><h2>Target: entry decisions<br>at industrial sites.</h2>
      <div class="k">// why: highest risk to crews and workers, highest density of people, sensors and plans already exist on site</div></div>
    <div class="pos-bl" style="max-width:1730px"><div class="grid2">
      <div><div class="k">// users concerned</div><ul class="list">
        <li>Protection Civile rescue teams and incident commanders</li>
        <li>Site operators and safety managers (HSE)</li>
        <li>Public bodies: governorate, civil-defence regional units</li>
        <li>Nearby residents, warned of the toxic plume</li></ul></div>
      <div><div class="k">// today → with A3TN</div><table class="std">
        <tr><td>Size-up from outside</td><td>drones map heat and people in minutes</td></tr>
        <tr><td>Radio relays, paper plans</td><td>one shared 3D picture, by voice</td></tr>
        <tr><td>Exposure judged by feel</td><td>live sensors, automatic withdraw</td></tr>
        <tr><td>Enter and hope</td><td>forecast-checked GO / NO-GO entry plans</td></tr></table></div>
    </div></div>` },

  { cam:[-98, 16, 44], at:[-70, 2, 22], drift:0.02, html:`
    <div class="pos-tl"><div class="k">// {n} — Users & empathy map</div><h2>Two people,<br>one decision.</h2></div>
    <div class="pos-bl" style="max-width:1500px"><div class="grid2">
      <div class="persona"><div class="t">// the incident commander</div><div class="n">Decides who goes in.</div>
        <div class="quote">${T('quote from the Protection Civile interview')}</div>
        <div class="dim">Needs one trustworthy picture of the site, now.</div></div>
      <div class="persona"><div class="t">// the entry firefighter</div><div class="n">Can’t see. Can’t type.</div>
        <div class="quote">${T('quote from the Protection Civile interview')}</div>
        <div class="dim">Needs to know where people are, and when to get out.</div></div>
    </div>
    <div class="k" style="margin-top:28px">// how we reach them: live demos at Protection Civile units · free training scenarios on the simulator · one pilot with a site operator · ${T('your channel')}</div></div>` },

  { cam:[6, 150, 52], at:[0, 0, -12], drift:0.01, html:`
    <div class="pos-tl"><div class="k">// {n} — A3TN Command</div><h2>A 3D twin of the site<br>that sees, forecasts<br>and talks.</h2>
      <div class="k hot">// not another fire detector: we keep crews alive after detection</div></div>
    <div class="pos-bl" style="max-width:1700px"><div class="verbs">
      <div><b>Detect</b><span>drones + fire/smoke vision</span></div>
      <div><b>Fuse</b><span>every sensor, with its uncertainty</span></div>
      <div><b>Forecast</b><span>smoke and heat, room by room</span></div>
      <div><b>Act</b><span>entry plans, voice, auto-withdraw</span></div></div></div>` },

  { cam:[34, 30, -58], at:[4, 6, -28], drift:0.05, html:`
    <div class="pos-tl"><div class="k">// {n} — Demo</div><h1>Live.</h1>
      <p class="lead dim">detection → auto-withdraw → indoor scan<br>→ rescue plan → “Visor, commit plan A”</p></div>` },

  { cam:[-50, 33, -6], at:[-26, -2, -28], drift:0.02, inside:'W1', hideGround:true, html:`
    <div class="pos-tl"><div class="k">// {n} — The AI</div><h2>Two models trained.<br>One laptop GPU.</h2></div>
    <div class="pos-bl" style="max-width:1730px"><div class="grid4">
      <div class="cell"><div class="t">YOLO11n · trained</div><div class="s">fire & smoke on drone video, fine-tuned on D-Fire (21,527 images)</div>
        <div class="m">mAP@.5 ${M.yoloMap50}<small>4,306 held-out images</small></div></div>
      <div class="cell"><div class="t">Smoke GNN · trained</div><div class="s">forecasts smoke and heat room to room, any floor plan</div>
        <div class="m">${M.gnnT}<small>error over 6 min, 200 unseen buildings</small></div></div>
      <div class="cell"><div class="t">Bayesian fusion</div><div class="s">not trained: probabilistic layer combining crews, drones, detectors, YOLO</div>
        <div class="m">64 ± 3 °C<small>every number shows its sources</small></div></div>
      <div class="cell"><div class="t">Voice</div><div class="s">pretrained, integrated: Whisper → Gemini → Piper</div>
        <div class="m">~3 s<small>order to spoken answer · refuses unsafe orders</small></div></div>
    </div><div class="k" style="margin-top:26px">// runs locally; only the language model needs internet, with an offline fallback</div></div>` },

  { cam:[18, 12, -4], at:[6, 3, -24], drift:0.02, withdraw:true, html:`
    <div class="pos-tl"><div class="k">// {n} — Realism & safety</div><h2>Physics, standards,<br>hard safety locks.</h2></div>
    <div class="pos-bl"><table class="std">
      <tr><td>Fire growth</td><td>t² “fast” curve · NFPA 72 / SFPE</td></tr>
      <tr><td>Flames & plume</td><td>Heskestad · McCaffrey · Gaussian dispersion</td></tr>
      <tr><td>Toxicity</td><td>ISO 13571 fractional effective dose</td></tr>
      <tr><td>Exposure limits</td><td>NIOSH IDLH · OSHA · 1.6 / 4.7 / 10 kW/m²</td></tr>
      <tr><td>Drones</td><td>120 m ceiling (EASA / ${T('OACA rule ref')}) · geofence · return-home</td></tr>
      <tr><td>Real data</td><td>live Gabès wind (Open-Meteo) · real fire imagery</td></tr></table></div>
    <div class="pos-br"><ul class="list" style="text-align:left">
      <li>Crews auto-withdrawn at critical exposure</li>
      <li>Routes never cross critical cells</li>
      <li>The AI cannot send a crew into danger</li></ul></div>` },

  { cam:[78, 30, -18], at:[46, 6, -56], drift:0.02, html:`
    <div class="pos-tl"><div class="k">// {n} — Technical feasibility</div><h2>Built on what sites<br>already have.</h2></div>
    <div class="pos-bl" style="max-width:1700px"><div class="grid2">
      <div><div class="k">// resources</div><ul class="list">
        <li>1 thermal drone + 1 caged indoor drone</li><li>Rugged laptop with a GPU</li>
        <li>Existing site heat detectors + crew wearables</li><li>${T('team size and roles')}</li></ul></div>
      <div><div class="k">// steps from idea to product · estimated duration</div><ul class="list">
        <li>1 · Prototype (done): twin, models, voice · 48 h</li>
        <li>2 · Site data: plans, detectors, drone flights · ${T('duration')}</li>
        <li>3 · Pilot on one site with the Protection Civile · ${T('duration')}</li>
        <li>4 · Certification, integration, regional rollout · ${T('duration')}</li>
        <li>Total to market: ${T('total duration')}</li></ul></div>
    </div>
    <div class="k" style="margin-top:24px">// supporting material: live demo · 1-min video · architecture schema · model report · public GitHub repo</div></div>` },

  { cam:[-128, 92, 124], at:[0, 0, -4], drift:0.012, html:`
    <div class="pos-tl"><div class="k">// {n} — Commercial feasibility</div><h2>Cheap enough for<br>every classified site.</h2></div>
    <div class="pos-bl" style="max-width:1700px"><div class="grid2">
      <div><div class="k">// market</div><ul class="list">
        <li>Tunisian classified industrial sites · ${T('count')}</li><li>Protection Civile regional units</li>
        <li>Insurers and site operators</li></ul></div>
      <div><div class="k">// cost per site kit</div><table class="std">
        <tr><td>Thermal drone</td><td>${T('price')}</td></tr><tr><td>Indoor caged drone</td><td>${T('price')}</td></tr>
        <tr><td>GPU laptop</td><td>${T('price')}</td></tr><tr><td>Software</td><td>open-source models · ${T('LLM cost / incident')}</td></tr>
        <tr><td>Total</td><td>${T('total')} + ${T('yearly subscription')}</td></tr></table></div>
    </div>
    <div class="grid2" style="margin-top:26px">
      <div><div class="k">// global project cost</div><table class="std">
        <tr><td>Development</td><td>${T('cost')}</td></tr><tr><td>Pilot site</td><td>${T('cost')}</td></tr>
        <tr><td>Rollout (per region)</td><td>${T('cost')}</td></tr></table></div>
      <div><div class="k">// funding & viability</div><ul class="list">
        <li>Site operators buy kits (regulatory safety duty)</li><li>Protection Civile: training licence</li>
        <li>${T('grants / incubator / partners')}</li><li>Subscriptions cover maintenance and updates</li></ul></div>
    </div></div>` },

  { cam:[-128, 70, 126], at:[0, 0, -4], drift:0.01, html:`
    <div class="pos-tl"><div class="k">// {n} — Business model canvas</div></div>
    <div style="position:absolute;left:96px;top:170px"><div class="bmc">
      <div class="kp"><b>key partners</b>${T('from team BMC')}</div>
      <div><b>key activities</b>${T('…')}</div>
      <div class="vp"><b>value proposition</b>${T('…')}</div>
      <div><b>customer relationships</b>${T('…')}</div>
      <div class="cs"><b>customer segments</b>${T('…')}</div>
      <div><b>key resources</b>${T('…')}</div>
      <div><b>channels</b>${T('…')}</div>
      <div class="cost"><b>cost structure</b>${T('…')}</div>
      <div class="rev"><b>revenue streams</b>${T('…')}</div></div></div>` },

  { cam:[-86, 22, 82], at:[-52, 2, 50], drift:0.02, html:`
    <div class="pos-tl"><div class="k">// {n} — With the Protection Civile</div><h2>Deployment,<br>step by step.</h2></div>
    <div class="pos-bl"><table class="std">
      <tr><td>Equipment</td><td>one drone kit + laptop per regional unit</td></tr>
      <tr><td>Data</td><td>site floor plans, detector feeds, hazardous-material inventory</td></tr>
      <tr><td>Training</td><td>the same simulator trains crews on realistic scenarios</td></tr>
      <tr><td>Maintenance</td><td>${T('who maintains drones / software, how often')}</td></tr>
      <tr><td>Support</td><td>on-call technical support, scenario updates, yearly joint exercise</td></tr>
      <tr><td>Pilot</td><td>one classified site, ${T('duration')}, measured against today’s practice</td></tr></table></div>` },

  { cam:[-160, 118, 150], at:[0, 0, -12], drift:0.01, html:`
    <div class="pos-tl"><div class="k">// {n}</div><h1>Know before<br>you go in.</h1>
      <p class="lead">The ask: one pilot site<br>with the Protection Civile.</p>
      <div class="k" style="margin-top:28px">// deliverables: BMC · team report · empathy map · 1-min video · model report · GitHub repo</div></div>
    <div class="pos-br"><div class="mark">A3TN</div><div class="k">// ${T(M.repo)}</div></div>` },
];

/* ---------------- scene setup: a static diorama with a live fire ---------------- */
document.addEventListener('contextmenu', e => e.preventDefault());
controls.enabled = false;
fires.push(new Fire({ id:'F1', name:'Drum yard D-1', x:DRUM.x, z:DRUM.z, Qmax:50000, I:0.85, light:lightPool[0] }));
ignite(W1); fires[1].I = 0.55;
const w = BUILDINGS.W1;
for (const r of w.rooms) r.scanned = true;
for (const p of w.persons){ p.found = true; p.prob = 0.97; }
Object.assign(w.state, { s:Float64Array.from([0.85, 0.7, 0.45, 0.32]), T:Float64Array.from([310, 120, 75, 58]) });
const place = (id, x, z, y = 0) => { const u = unitById(id); u.pos.set(x, y, z); u.targetHeading = u.heading = Math.atan2(4 - x, -28 - z); };
place('E1', -30, -22); place('E2', 20, -12); place('H1', -14, -9); place('R1', -60, 40);
place('D1', 26, -46, 30); place('D2', -40, -64, 16); place('D3', -21, -29.5, 2.2);
const D1 = unitById('D1');
updateRisk();
sim.paused = true;

function resize(){
  const W = innerWidth, H = innerHeight;
  renderer.setSize(W, H); composer.setSize(W, H); labelRenderer.setSize(W, H); bloom.resolution.set(W, H);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  uScale.value = renderer.getPixelRatio() * H / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const s = Math.min(W / 1920, H / 1080), f = document.getElementById('frame');
  f.style.transform = `scale(${s}) translate(-50%, -50%)`; f.style.transformOrigin = '0 0';
  f.style.left = '50%'; f.style.top = '50%'; f.style.marginLeft = '0';
}
// keep the 1920×1080 frame centred: translate in frame units after scaling
function placeFrame(){
  const W = innerWidth, H = innerHeight, s = Math.min(W / 1920, H / 1080), f = document.getElementById('frame');
  f.style.left = `${(W - 1920 * s) / 2}px`; f.style.top = `${(H - 1080 * s) / 2}px`; f.style.transform = `scale(${s})`;
}
addEventListener('resize', () => { resize(); placeFrame(); }); resize(); placeFrame();

/* ---------------- slide engine ---------------- */
const GLYPHS = '#%&*+=-/<>[]{}_01';
function decode(el, ms = 650){
  const nodes = []; const walk = n => { for (const c of n.childNodes){ if (c.nodeType === 3){ if (c.nodeValue.trim()) nodes.push({ n:c, s:c.nodeValue }); } else walk(c); } };
  walk(el); const t0 = performance.now(), id = (el._d = (el._d || 0) + 1);
  const tick = now => { if (el._d !== id) return; const k = Math.min(1, (now - t0) / ms);
    for (const { n, s } of nodes){ const cut = Math.floor(s.length * k); n.nodeValue = s.slice(0, cut) + [...s.slice(cut)].map(ch => ch === ' ' || ch === '\n' ? ch : GLYPHS[Math.random() * GLYPHS.length | 0]).join(''); }
    if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
let cur = -1, tween = null, t = 0;
const camFrom = new THREE.Vector3(), atFrom = new THREE.Vector3(), atNow = new THREE.Vector3();
function applyState(sl){
  if (sl.inside){ if (S.view !== sl.inside) enterBuilding(sl.inside); } else if (S.view) exitBuilding(true);
  for (const u of units) if (!u.isDrone) u.hiddenBySlide = !!sl.hideGround;
  const e2 = unitById('E2');
  if (sl.withdraw){ e2.pos.set(11, 0, -17); e2.level = 3; } else { e2.pos.set(20, 0, -12); e2.level = 0; }
}
function go(i, instant = false){
  i = Math.max(0, Math.min(SLIDES.length - 1, i)); if (i === cur && !instant) return;
  cur = i; const sl = SLIDES[i];
  applyState(sl);
  camFrom.copy(camera.position); atFrom.copy(atNow);
  tween = instant ? null : { t:0 };
  if (instant){ camera.position.set(...sl.cam); atNow.set(...sl.at); }
  t = 0;
  const el = document.getElementById('slide'); el.innerHTML = htmlOf(i);
  el.querySelectorAll('h1,h2,.lead,.k,.mark').forEach(n => decode(n));
  document.getElementById('count').textContent = `${String(i + 1).padStart(2, '0')} / ${SLIDES.length}`;
  document.getElementById('bar').style.width = `${(i + 1) / SLIDES.length * 100}%`;
  history.replaceState(null, '', `#${i + 1}`);
}
function camAt(sl, time){
  // slow igloo-style drift around the slide's target
  const base = new THREE.Vector3(...sl.cam), at = new THREE.Vector3(...sl.at);
  const off = base.clone().sub(at), a = time * (sl.drift || 0.02);
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(a) * 0.12);
  return { pos:at.clone().add(off), at };
}

/* ---------------- loop ---------------- */
const clock = new THREE.Clock();
function frame(dtOverride){
  const dt = dtOverride ?? Math.min(clock.getDelta(), 0.05);
  S.clock += dt; uTime.value = S.clock; t += dt;
  for (const f of fires) f.visualStep(dt, S.clock);
  const uf = overlayMat.uniforms.uFires.value;
  for (let i = 0; i < 3; i++){ const f = fires[i]; if (f && f.Ieff > 0.01){ const c = f.center(); uf[i].set(c.x, c.z, f.Q, c.y - 1.5); } else uf[i].set(0, 0, 0, 0); }
  // D1 orbits the fire
  D1.orbitA = (D1.orbitA || 0) + dt * 0.15; D1.pos.set(4 + Math.cos(D1.orbitA) * 34, 30, -28 + Math.sin(D1.orbitA) * 34); D1.targetHeading = D1.orbitA + Math.PI;
  for (const u of units){
    u.heading += (Math.atan2(Math.sin(u.targetHeading - u.heading), Math.cos(u.targetHeading - u.heading))) * Math.min(1, dt * 3);
    u.mesh.position.copy(u.pos); u.mesh.rotation.y = u.heading;
    const inW1 = u.id === 'D3'; u.mesh.visible = (!inW1 || S.view === 'W1') && !u.hiddenBySlide;
    if (u.isDrone){ for (const r of u.mesh.userData.rotors) r.rotation.y += dt * 40; u.tether.visible = false; u.mesh.position.y = u.pos.y + Math.sin(S.clock * 2 + u.home.z) * 0.15; }
    u.ring.position.set(u.pos.x, 0.12, u.pos.z); u.ring.visible = !u.isDrone && !u.hiddenBySlide;
    u.ring.material.color.setHex(LVL_COLORS[u.level]); u.ring.material.opacity = u.level >= 3 ? 0.55 + 0.4 * Math.sin(S.clock * 8) : 0.45;
  }
  updateInterior(dt, S.clock, null);
  const sl = SLIDES[cur];
  if (sl){
    const tgt = camAt(sl, t);
    if (tween){ tween.t = Math.min(1, tween.t + dt / 1.8); const e = tween.t < .5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
      camera.position.lerpVectors(camFrom, tgt.pos, e); atNow.lerpVectors(atFrom, tgt.at, e); if (tween.t >= 1) tween = null; }
    else { camera.position.copy(tgt.pos); atNow.copy(tgt.at); }
    camera.lookAt(atNow);
  }
  updateSound(Math.min(1, fires.reduce((a, f) => a + f.Ieff, 0)), 4, dt, S.clock);
  composer.render();
}
function loop(){ if (!exporting) frame(); requestAnimationFrame(loop); }

/* ---------------- navigation ---------------- */
addEventListener('keydown', e => {
  if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)){ e.preventDefault(); go(cur + 1); }
  if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)){ e.preventDefault(); go(cur - 1); }
  if (e.key === 'Home') go(0); if (e.key === 'End') go(SLIDES.length - 1);
  if (e.key === 'f') document.documentElement.requestFullscreen?.();
});
document.getElementById('next').onclick = () => go(cur + 1);
document.getElementById('prev').onclick = () => go(cur - 1);
document.getElementById('stage').addEventListener('click', () => go(cur + 1));
document.getElementById('sound').onclick = e => { e.target.textContent = `sound: ${toggleSound() ? 'on' : 'off'}`; };

/* ---------------- PDF export: identical content, 3D as stills ---------------- */
let exporting = false;
document.getElementById('export').onclick = async () => {
  exporting = true;
  const keep = cur, out = document.getElementById('print'); out.innerHTML = '';
  for (let i = 0; i < SLIDES.length; i++){
    go(i, true);
    for (let k = 0; k < 50; k++) frame(1 / 30);            // let flames and smoke fill in
    const img = renderer.domElement.toDataURL('image/jpeg', 0.9);
    const page = document.createElement('section'); page.className = 'page';
    page.innerHTML = `<img src="${img}" alt=""><div class="pshade"></div><div class="slide">${htmlOf(i)}</div>
      <div class="pfoot"><span>A3TN // Command</span><span>${String(i + 1).padStart(2, '0')} / ${SLIDES.length}</span></div>`;
    out.appendChild(page);
    await new Promise(r => setTimeout(r, 30));
  }
  go(keep, true); exporting = false;
  setTimeout(() => print(), 200);
};

/* ---------------- start ---------------- */
const start = Math.max(0, (parseInt(location.hash.slice(1)) || 1) - 1);
document.fonts.ready.then(() => setTimeout(() => document.getElementById('loader').classList.add('done'), 500));
go(start, true);
loop();
