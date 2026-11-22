// A3TN pitch deck: one live 3D world, each slide is a camera move + scene state, text decodes in.
// [ export pdf ] renders every slide to a still and prints it with the exact same text (deck == PDF).
import {
  THREE, S, scene, camera, controls, renderer, composer, labelRenderer, bloom, uScale, uTime, fires, Fire, DRUM, lightPool,
  units, unitById, updateRisk, overlayMat, W1, ignite, sim, LVL_COLORS, emit, stepLayer, rand,
} from './core.js';
import { BUILDINGS, enterBuilding, exitBuilding, updateInterior } from './interior.js';
import { toggleSound, updateSound } from './sound.js';
import { updateFx } from './fx.js';
import { animateHumans, updateCrews, updateMuster } from './human.js';

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
    <div class="pos-tl"><div class="k">// {n} — A chemical plant in Gabès, 2:14 pm</div>
      <h1>Two workers<br>are inside.</h1>
      <p class="lead">Where are they?<br><span class="dim">Can we get them out alive?</span></p></div>
    <div class="pos-br"><div class="mark">A3TN</div><div class="k">// Tunisian Aeroday · ${T(M.team)}</div></div>` },

  { cam:[-36, 20, -4], at:[-8, 13, -36], drift:0.015, html:`
    <div class="pos-tl"><div class="k">// {n} — The problem</div><h2>Firefighters go in<br>without seeing.</h2></div>
    <div class="pos-bl"><ul class="list">
      <li>Toxic smoke and explosion risk</li>
      <li>Big buildings, people still inside</li>
      <li>No one knows how hot it is where each firefighter stands</li>
      <li>No one knows where the smoke will go next</li>
      <li>Thick gloves: they can’t use a screen</li></ul></div>
    <div class="pos-br"><div class="k">${T('2 real figures with sources, e.g. industrial fires in Gabès')}</div></div>` },

  { cam:[-62, 46, 30], at:[-10, 0, -20], drift:0.015, html:`
    <div class="pos-tl"><div class="k">// {n} — The need</div><h2>Who needs this,<br>and why.</h2>
      <div class="k">// we start with industrial sites: the most dangerous fires, the most people at risk</div></div>
    <div class="pos-bl" style="max-width:1730px"><div class="grid2">
      <div><div class="k">// who it helps</div><ul class="list">
        <li>Firefighters and their commanders</li>
        <li>Factory safety managers</li>
        <li>Local authorities</li>
        <li>Neighbours, warned when smoke heads their way</li></ul></div>
      <div><div class="k">// today → with A3TN</div><table class="std">
        <tr><td>Guess from outside</td><td>drones look inside in minutes</td></tr>
        <tr><td>Shouting over the radio</td><td>one shared map, controlled by voice</td></tr>
        <tr><td>“Is it too hot?”</td><td>automatic warning, pull out in time</td></tr>
        <tr><td>Go in and hope</td><td>a safe route, checked before entering</td></tr></table></div>
    </div></div>` },

  { cam:[-84, 5.5, 80], at:[-65, 1.6, 56], drift:0.03, html:`
    <div class="pos-tl"><div class="k">// {n} — The people we listened to</div><h2>Two people,<br>one decision.</h2></div>
    <div class="pos-bl" style="max-width:1500px"><div class="grid2">
      <div class="persona"><div class="t">// the commander</div><div class="n">Decides who goes in.</div>
        <div class="quote">${T('quote from the Protection Civile interview')}</div>
        <div class="dim">Needs to see the whole site, right now.</div></div>
      <div class="persona"><div class="t">// the firefighter</div><div class="n">Can’t see. Can’t type.</div>
        <div class="quote">${T('quote from the Protection Civile interview')}</div>
        <div class="dim">Needs to know where people are, and when to get out.</div></div>
    </div>
    <div class="k" style="margin-top:28px">// how we reach them: demos at fire stations · free training scenarios · a pilot with one factory · ${T('your channel')}</div></div>` },

  { cam:[6, 150, 52], at:[0, 0, -12], drift:0.01, html:`
    <div class="pos-tl"><div class="k">// {n} — Our solution</div><h2>A live 3D map<br>of the fire<br>you can talk to.</h2>
      <div class="k hot">// others detect the fire. we help get everyone out safely.</div></div>
    <div class="pos-bl" style="max-width:1700px"><div class="verbs">
      <div><b>See</b><span>drones spot fire, smoke and people</span></div>
      <div><b>Understand</b><span>all sensors on one map</span></div>
      <div><b>Predict</b><span>where the smoke will go</span></div>
      <div><b>Protect</b><span>drones and crews put out the fire · safe routes · automatic pull-out</span></div></div></div>` },

  { cam:[34, 30, -58], at:[4, 6, -28], drift:0.05, html:`
    <div class="pos-tl"><div class="k">// {n} — Demo</div><h1>Live.</h1>
      <p class="lead dim">one click runs the whole response:<br>drones, foam, safety, rescue.</p></div>` },

  { cam:[-26, 30, -7], at:[4, 12, -28], drift:0.03, html:`
    <div class="pos-tl"><div class="k">// {n} — What you will see</div><h2>One fire,<br>nine steps.</h2></div>
    <div class="pos-bl" style="max-width:1150px"><table class="std">
      <tr><td>1</td><td>Fire reported. Recon drone, gas drone, hazmat and rescue launch.</td></tr>
      <tr><td>2</td><td>Safety lock: an engine sent too close pulls out by itself.</td></tr>
      <tr><td>3</td><td>Two firefighting drones spray foam on the flames.</td></tr>
      <tr><td>4</td><td>The engine attacks again, from a safe distance.</td></tr>
      <tr><td>5</td><td>Roll call: two missing. The indoor drone scans the warehouse.</td></tr>
      <tr><td>6</td><td>Workers found. The safest way in is chosen. The rescue team goes in.</td></tr>
      <tr><td>7</td><td>Warehouse clear. The indoor drone scans the admin block.</td></tr>
      <tr><td>8</td><td>Person found there too. Plan, then rescue.</td></tr>
      <tr><td>9</td><td>Everyone out, fire out. Summary on screen.</td></tr></table></div>
    <div class="pos-br"><div class="k">// narrated by Visor · one button: “Run full scenario”</div></div>` },

  { cam:[-50, 33, -6], at:[-26, -2, -28], drift:0.02, inside:'W1', hideGround:true, html:`
    <div class="pos-tl"><div class="k">// {n} — The AI</div><h2>What the AI does.</h2></div>
    <div class="pos-bl" style="max-width:1730px"><div class="grid4">
      <div class="cell"><div class="t">Spots fire & smoke</div><div class="s">in the drone’s camera, trained on 21,500 real fire photos</div>
        <div class="m">tested<small>on 4,300 photos it had never seen</small></div></div>
      <div class="cell"><div class="t">Predicts smoke</div><div class="s">room by room, minutes ahead, in any building</div>
        <div class="m">±2 °C<small>accuracy on 200 new buildings</small></div></div>
      <div class="cell"><div class="t">Combines sensors</div><div class="s">drones, firefighters, alarms: one picture</div>
        <div class="m">honest<small>always says how sure it is</small></div></div>
      <div class="cell"><div class="t">Listens & talks</div><div class="s">firefighters speak, it answers out loud</div>
        <div class="m">~3 s<small>and refuses unsafe orders</small></div></div>
    </div><div class="k" style="margin-top:26px">// runs on one laptop · keeps working if the internet drops (basic voice commands)</div></div>` },

  { cam:[24, 15, -12], at:[1, 2, -27], drift:0.02, withdraw:true, html:`
    <div class="pos-tl"><div class="k">// {n} — Realistic and safe</div><h2>Real fire science.<br>Real safety rules.</h2></div>
    <div class="pos-bl"><ul class="list">
      <li>Fire and smoke follow the formulas fire engineers use</li>
      <li>Safety limits come from international firefighter standards</li>
      <li>Drones stay under the legal 120 m ceiling</li>
      <li>Real wind data from Gabès, real fire photos</li></ul></div>
    <div class="pos-br"><div class="k" style="text-align:left">// three things it will never do</div><ul class="list" style="text-align:left">
      <li>Let a firefighter stay where it’s deadly</li>
      <li>Route anyone through the danger zone</li>
      <li>Obey an order that puts a crew at risk</li></ul></div>` },

  { cam:[78, 30, -18], at:[46, 6, -56], drift:0.02, html:`
    <div class="pos-tl"><div class="k">// {n} — Can we build it?</div><h2>Yes. Most of it<br>already works.</h2></div>
    <div class="pos-bl" style="max-width:1700px"><div class="grid2">
      <div><div class="k">// what it needs</div><ul class="list">
        <li>5 drones: recon, gas survey, an indoor scout and 2 that spray foam</li>
        <li>One laptop</li>
        <li>The fire alarms the factory already has</li>
        <li>${T('our team and roles')}</li></ul></div>
      <div><div class="k">// the steps</div><ul class="list">
        <li>1 · Working prototype · done this weekend</li>
        <li>2 · Map a real factory · ${T('duration')}</li>
        <li>3 · Test it with the Protection Civile · ${T('duration')}</li>
        <li>4 · Roll it out region by region · ${T('duration')}</li></ul></div>
    </div>
    <div class="k" style="margin-top:24px">// see it: live demo · 1-min video · code on GitHub</div></div>` },

  { cam:[-128, 92, 124], at:[0, 0, -4], drift:0.012, html:`
    <div class="pos-tl"><div class="k">// {n} — Does it make sense financially?</div><h2>Cheap enough for<br>every factory.</h2></div>
    <div class="pos-bl" style="max-width:1700px"><div class="grid2">
      <div><div class="k">// who pays</div><ul class="list">
        <li>Factories with dangerous materials · ${T('how many in Tunisia')}</li>
        <li>The Protection Civile, for training</li>
        <li>Insurers</li></ul></div>
      <div><div class="k">// what it costs</div><table class="std">
        <tr><td>One kit per factory</td><td>${T('price')}</td></tr>
        <tr><td>Yearly subscription</td><td>${T('price')}</td></tr>
        <tr><td>Whole project</td><td>${T('total cost')}</td></tr>
        <tr><td>Funding</td><td>${T('grants / partners')}</td></tr></table></div>
    </div>
    <div class="k" style="margin-top:24px">// off-the-shelf drones and free software keep the price low</div></div>` },

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
    <div class="pos-tl"><div class="k">// {n} — With the Protection Civile</div><h2>How we roll it out<br>together.</h2></div>
    <div class="pos-bl"><table class="std">
      <tr><td>Equipment</td><td>one drone kit and laptop per regional unit</td></tr>
      <tr><td>Information</td><td>building plans and alarm data from each factory</td></tr>
      <tr><td>Training</td><td>the same 3D scene becomes a training simulator</td></tr>
      <tr><td>Maintenance</td><td>${T('who maintains it, how often')}</td></tr>
      <tr><td>Support</td><td>help line, new scenarios, a yearly joint exercise</td></tr>
      <tr><td>First step</td><td>a pilot on one factory, ${T('duration')}</td></tr></table></div>` },

  { cam:[-160, 118, 150], at:[0, 0, -12], drift:0.01, html:`
    <div class="pos-tl"><div class="k">// {n}</div><h1>Know before<br>you go in.</h1>
      <p class="lead">Our ask: one pilot factory<br>with the Protection Civile.</p></div>
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
place('E1', -30, -22); place('E2', 20, -12);
for (const id of ['E1', 'E2', 'H1']) unitById(id).mode = 'working'; place('H1', -14, -9); place('R1', -60, 40);
place('D1', 26, -46, 30); place('D2', -40, -64, 16); place('D3', -21, -29.5, 2.2);
place('D4', -10, -30, 17); place('D5', 8, -19, 17);                 // firefighting drones hover upwind of the fire
for (const id of ['D4', 'D5', 'E2']){ const u = unitById(id); u.sprayOn = true; u.sprayTo.set(4, 1.5, -28); }
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
const _o = new THREE.Vector3();
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
  for (const u of units){
    if (!u.spray) continue;
    const L = u.spray;
    if (u.sprayOn){
      _o.set(Math.sin(u.heading) * 1.5, u.isDrone ? -1.6 : 3.2, Math.cos(u.heading) * 1.5).add(u.pos);
      emit(L, 110, dt, (i, j) => {
        const T = 1.0 + rand() * 0.35; L.life[i] = T;
        L.pos[j] = _o.x; L.pos[j + 1] = _o.y; L.pos[j + 2] = _o.z;
        const tx = u.sprayTo.x + (rand() - 0.5) * 2.5, ty = u.sprayTo.y, tz = u.sprayTo.z + (rand() - 0.5) * 2.5;
        L.vel[j] = (tx - _o.x) / T; L.vel[j + 1] = (ty - _o.y) / T + 4.9 * T; L.vel[j + 2] = (tz - _o.z) / T; L.size[i] = 0.45 + rand() * 0.5;
      });
    }
    stepLayer(L, dt, (i, a, j, P_, V_) => { V_[j + 1] -= 9.8 * dt; P_[j] += V_[j] * dt; P_[j + 1] = Math.max(0.1, P_[j + 1] + V_[j + 1] * dt); P_[j + 2] += V_[j + 2] * dt; });
  }
  updateInterior(dt, S.clock, null);
  updateCrews(dt); updateMuster(dt, S.clock, 17); updateFx(dt, S.clock); animateHumans(dt, S.clock);
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
