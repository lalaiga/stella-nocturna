// The "perfect scenario": a scripted, hands-off run of the whole factory response that exercises every component.
// Steps fire on simulation time or on events (never on wall-clock), so it works at any speed. Runs from a clean
// start: the button reloads the page with #run, which starts it automatically.
import {
  S, sim, units, unitById, tasks, fires, camera, controls, assignTask, moveUnit, cellCenter, addLog, setVisorEvent, onEv, tplus,
} from './core.js';
import { BUILDINGS, startScan, enterBuilding, exitBuilding } from './interior.js';
import { P, makePlans, commitPlan } from './planner.js';

export const SC = { running:false, t0:0, steps:[], done:new Set(), cam:null, stats:{ withdrawals:0 } };
const taskById = id => tasks.find(t => t.id === id);
const allRescued = id => BUILDINGS[id].persons.every(p => p.rescued);
const say = (text, html, secs = 8) => { addLog(text, 'ok', text); if (html) setVisorEvent(html, secs); };
const camTo = (pos, at) => { SC.cam = { pos, at }; };

async function planAndCommit(id){
  await makePlans(id);
  // hold on the plan view so the audience can read the options, then commit the best GO plan
  setTimeout(() => {
    if (!P.plans.length) return;
    const k = Math.max(0, P.plans.findIndex(p => p.verdict === 'GO'));
    say(`Committing plan ${P.plans[k].id}, ${P.plans[k].door.name}.`, `<b>PLAN ${P.plans[k].id}</b>${P.plans[k].door.name} · ${P.plans[k].verdict}`, 6);
    commitPlan(k);
  }, 7000);
}

// each step: trigger = { at: seconds since start } and/or { when: () => bool } and/or { after: [step ids] }
const STEPS = [
  { id:'intro', title:'Fire reported · recon, gas survey, evacuation, drain', at:0, run(){
      sim.speed = 5; sim.paused = false;
      fires[0].I = Math.max(fires[0].I, 0.7);      // reported once it is already well developed
      say('Scenario start. Fire at drum yard D-1, workers unaccounted for. Drones, hazmat and rescue are launching.', '<b>SCENARIO</b>fire at drum yard D-1', 8);
      camTo([-58, 40, 44], [4, 5, -28]); } },
  { id:'safety', title:'Safety lock: Engine 2 advances too far and is auto-withdrawn', at:3, run(){
      const c = cellCenter('F4'); if (c) moveUnit(unitById('E2'), c.x, c.z);
      say('Engine 2 is ordered right up to the fire, to show the safety lock.', null);
      camTo([-70, 26, 14], [-8, 2, -20]); } },
  { id:'drones', title:'Firefighting drones D4 and D5 attack with foam', at:26, after:['safety'], run(){
      for (const id of ['t7', 't8']){ const t = taskById(id); if (t) assignTask(t, unitById(t.unit)); }
      say('Firefighting drones D4 and D5, foam on the drum yard.', '<b>DRONES</b>D4 · D5 foam attack', 8);
      camTo([-16, 24, -8], [4, 9, -28]); } },
  { id:'foam', title:'Engine 2 foam attack from a safe standoff', at:85, after:['safety', 'drones'], run(){
      const t = taskById('t5'); if (t) assignTask(t, unitById('E2'));
      say('Engine 2 back in, foam attack from the safe standoff.', '<b>ENGINE 2</b>foam attack, upwind standoff', 8);
      camTo([-92, 62, 76], [0, 0, -14]); } },
  { id:'scan1', title:'Roll call: 2 missing in W-1 · scout D3 scans the warehouse', when:() => S.rollCall, run(){
      if (startScan(unitById('D3'), 'W1')){ enterBuilding('W1'); SC.cam = null; }
      say('Roll call. Two workers missing, last seen in warehouse W 1. Scout D3 is going in.', '<b>ROLL CALL</b>2 missing · W-1', 8); } },
  { id:'plan1', title:'Casualties found · entry plans · rescue team goes in', when:() => false, run(){ say('Casualties located in warehouse W 1. Building entry plans.', null); planAndCommit('W1'); } },
  { id:'resweep', hidden:true, when:() => SC.done.has('plan1') && tasks.some(t => t.kind === 'rescue' && t.plan.b === 'W1' && t.status === 'done') && !tasks.some(t => t.kind === 'rescue' && t.plan.b === 'W1' && !['done', 'cancelled'].includes(t.status)) && !allRescued('W1'), run(){
      SC.done.delete('plan1'); say('One more person in warehouse W 1. Scout D3 is sweeping again.', null); startScan(unitById('D3'), 'W1'); } },
  { id:'scan2', title:'W-1 cleared · scout D3 scans the admin block', when:() => allRescued('W1') && BUILDINGS.W1.persons.length > 0 && BUILDINGS.A1.missing > 0, run(){
      exitBuilding(); SC.cam = null;
      say('Warehouse W 1 casualties are out. Now the admin block: one person missing.', '<b>W-1 CLEAR</b>2 rescued', 8);
      if (startScan(unitById('D3'), 'A1')) enterBuilding('A1'); } },
  { id:'plan2', title:'Admin casualty found · plan · rescue', when:() => false, run(){ say('Casualty located in the admin block. Building entry plans.', null); planAndCommit('A1'); } },
  { id:'finish', title:'All rescued · fire out · summary', when:() => allRescued('W1') && allRescued('A1') && fires.every(f => f.out), run(){ finish('all casualties rescued and the fire is out'); } },
];
STEPS.forEach(s => { s.at = s.at ?? null; });

function finish(reason){
  if (SC.finished) return; SC.finished = true;
  exitBuilding(); camTo([-92, 62, 76], [0, 0, -14]);
  const saved = Object.values(BUILDINGS).reduce((a, b) => a + b.persons.filter(p => p.rescued).length, 0);
  const total = Object.values(BUILDINGS).reduce((a, b) => a + b.persons.length, 0);
  const summary = `${saved} of ${total} people rescued · ${tplus(sim.t - SC.t0)} · ${SC.stats.withdrawals} auto-withdrawal${SC.stats.withdrawals === 1 ? '' : 's'}`;
  setVisorEvent(`<b>SCENARIO COMPLETE</b>${summary}`, 60);
  addLog(`Scenario complete (${reason}): ${summary}`, 'ok', `Scenario complete. ${saved} of ${total} people rescued in ${Math.round((sim.t - SC.t0) / 60)} minutes.`);
  SC.running = false; SC.summary = summary;
}

onEv('scan-done', ({ building, found }) => {
  if (!SC.running) return;
  if (building === 'W1' && !SC.done.has('plan1')) fire('plan1');
  if (building === 'A1' && !SC.done.has('plan2')) fire('plan2');
});
onEv('log', ({ text }) => { if (SC.running && /auto-withdrawn/.test(text)) SC.stats.withdrawals++; });
onEv('ignite', () => { if (!SC.running) return; for (const t of tasks) if (t.kind === 'foam' && t.status === 'queued' && t.fireId !== 'F1') assignTask(t, unitById(t.unit)); });
function fire(id){ const s = STEPS.find(x => x.id === id); if (!s || SC.done.has(id)) return; SC.done.add(id); s.run(); }

S.hooks.step.push(() => {
  if (!SC.running) return;
  const t = sim.t - SC.t0;
  for (const s of STEPS){
    if (SC.done.has(s.id) || s.at === null && !s.when) continue;
    if (s.after && !s.after.every(a => SC.done.has(a))) continue;
    if ((s.at !== null && t >= s.at && (!s.when || s.when())) || (s.at === null && s.when && s.when())) fire(s.id);
  }
  if (t > 1500 && !SC.finished) finish('time limit');
});

export function startScenario(){
  S.scripted = true; SC.running = true; SC.t0 = sim.t; SC.done = new Set(); SC.finished = false; SC.stats.withdrawals = 0; SC.summary = null;
}
export const scenarioStatus = () => ({ running:SC.running, finished:SC.finished, summary:SC.summary,
  steps:STEPS.filter(s => !s.hidden).map(s => ({ title:s.title, state:SC.done.has(s.id) ? 'done' : 'todo' })) });

// director camera: eases toward the current shot until the operator grabs the view
controls.addEventListener('start', () => { SC.cam = null; });
const _v = camera.position.clone();
export function updateScenario(dt){
  if (!SC.cam) return;
  const k = Math.min(1, dt * 1.2);
  camera.position.lerp(_v.set(...SC.cam.pos), k);
  controls.target.lerp(_v.set(...SC.cam.at), k);
  _v.copy(camera.position);
}
if (location.hash === '#run' || location.hash === '#record') setTimeout(startScenario, 1800);
