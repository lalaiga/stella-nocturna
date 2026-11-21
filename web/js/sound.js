// Ambient sound, synthesized with WebAudio (no files): fire roar + crackle scaled by heat release, wind by wind speed.
let ctx = null, master, roarG, windG, windF, on = false, crackleT = 0;

function noiseBuffer(c, seconds = 2, brown = false){
  const b = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate), d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++){ const w = Math.random() * 2 - 1; if (brown){ last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
  return b;
}
function loop(c, buf){ const s = c.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; }

function init(){
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
  // fire roar: brown noise, low-passed
  const roar = loop(ctx, noiseBuffer(ctx, 3, true)); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
  roarG = ctx.createGain(); roarG.gain.value = 0; roar.connect(lp).connect(roarG).connect(master);
  // wind: white noise through a slowly moving band-pass
  const wind = loop(ctx, noiseBuffer(ctx, 3)); windF = ctx.createBiquadFilter(); windF.type = 'bandpass'; windF.frequency.value = 500; windF.Q.value = 0.6;
  windG = ctx.createGain(); windG.gain.value = 0; wind.connect(windF).connect(windG).connect(master);
  ctx.crackle = noiseBuffer(ctx, 0.05);
}
function crackle(level){
  const s = ctx.createBufferSource(); s.buffer = ctx.crackle;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500 + Math.random() * 3000;
  const g = ctx.createGain(); const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15 + 0.5 * Math.random() * level, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + Math.random() * 0.08);
  s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + 0.2);
}
export function toggleSound(){
  if (!ctx) init();
  on = !on;
  if (ctx.state === 'suspended') ctx.resume();
  master.gain.setTargetAtTime(on ? 0.55 : 0, ctx.currentTime, 0.4);
  return on;
}
export const soundOn = () => on;
// fire: 0..1 total intensity; wind: m/s; dt: s
export function updateSound(fire, wind, dt, time){
  if (!ctx || !on) return;
  roarG.gain.setTargetAtTime(0.55 * Math.min(1, fire), ctx.currentTime, 0.5);
  windG.gain.setTargetAtTime(0.04 + 0.025 * wind, ctx.currentTime, 0.8);
  windF.frequency.setTargetAtTime(380 + 160 * Math.sin(time * 0.31) + 25 * wind, ctx.currentTime, 0.8);
  crackleT -= dt;
  if (fire > 0.02 && crackleT <= 0){ crackle(fire); crackleT = (0.02 + Math.random() * 0.25) / (0.3 + fire); }
}
