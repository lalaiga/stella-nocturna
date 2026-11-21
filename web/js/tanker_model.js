// Procedural aerial firefighting aircraft (amphibious water bomber), shared by both scenarios.
// Red-and-white livery, high wing, twin turboprops with spinning propellers, T-tail, nav lights + strobes.
// Local axes: +z = nose, +y = up. Real-world size ≈ 20 m long, 29 m span.
export function makeTankerMesh(THREE, scale = 1){
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const M = (c, r = 0.45, m = 0.25, e = 0) => new THREE.MeshStandardMaterial({ color:c, roughness:r, metalness:m, emissive:e ? c : 0, emissiveIntensity:e });
  const white = M(0xf2f2ee), red = M(0xc8261b), dark = M(0x23262c, 0.6, 0.4), glass = M(0x1b2a3c, 0.1, 0.9);
  const add = (geo, m, x, y, z, p = body) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; p.add(o); return o; };
  // fuselage: boat-hull bottom (red), white upper
  add(new THREE.CylinderGeometry(1.35, 1.2, 15, 16).rotateX(Math.PI / 2), white, 0, 0.3, 0);
  add(new THREE.BoxGeometry(2.3, 1.1, 15), red, 0, -0.55, 0);
  add(new THREE.ConeGeometry(1.2, 3.2, 16).rotateX(Math.PI / 2), white, 0, 0.3, 9.1);           // nose
  add(new THREE.ConeGeometry(1.15, 5, 16).rotateX(-Math.PI / 2), white, 0, 0.6, -10);            // tail cone
  add(new THREE.BoxGeometry(1.8, 0.7, 1.6), glass, 0, 1.15, 7.2);                                 // cockpit glazing
  add(new THREE.BoxGeometry(2.42, 0.18, 14), red, 0, 0.2, 0.3);                                   // cheat line
  // high wing with red tips and engine nacelles
  add(new THREE.BoxGeometry(29, 0.45, 3.2), white, 0, 1.75, 1.0);
  for (const sx of [-1, 1]){
    add(new THREE.BoxGeometry(3, 0.47, 3.22), red, sx * 13.5, 1.75, 1.0);
    add(new THREE.CylinderGeometry(0.5, 0.35, 2.4, 10), dark, sx * 13.6, 0.6, 1.0);              // wing float
    add(new THREE.CylinderGeometry(0.75, 0.65, 5, 14).rotateX(Math.PI / 2), white, sx * 5, 1.5, 2.2);  // nacelle
    add(new THREE.CylinderGeometry(0.76, 0.76, 0.6, 14).rotateX(Math.PI / 2), red, sx * 5, 1.5, 4.1);
  }
  // T-tail
  add(new THREE.BoxGeometry(0.4, 5, 3), white, 0, 3.0, -10.2);
  add(new THREE.BoxGeometry(0.42, 1.6, 3.02), red, 0, 4.6, -10.2);
  add(new THREE.BoxGeometry(9.5, 0.3, 2.2), white, 0, 5.4, -10.6);
  // propellers
  const props = [];
  for (const sx of [-5, 5]){
    const hub = new THREE.Group(); hub.position.set(sx, 1.5, 4.75); body.add(hub);
    add(new THREE.SphereGeometry(0.35, 10, 8), red, 0, 0, 0.15, hub);
    for (let b = 0; b < 4; b++){ const bl = add(new THREE.BoxGeometry(0.28, 3.6, 0.08), dark, 0, 0, 0, hub); bl.rotation.z = b * Math.PI / 2; bl.position.set(Math.sin(b * Math.PI / 2) * 1.6, Math.cos(b * Math.PI / 2) * 1.6, 0); }
    const disc = add(new THREE.CircleGeometry(3.4, 24), new THREE.MeshBasicMaterial({ color:0x2a2a2a, transparent:true, opacity:0.12, side:THREE.DoubleSide, depthWrite:false }), 0, 0, 0.05, hub);
    disc.castShadow = false;
    props.push(hub);
  }
  // navigation lights (red port, green starboard, white tail) + strobes
  const bulb = (c, x, y, z) => add(new THREE.SphereGeometry(0.25, 8, 6), new THREE.MeshBasicMaterial({ color:c }), x, y, z);
  bulb(0xff2a2a, -14.6, 1.75, 1.0); bulb(0x2aff6a, 14.6, 1.75, 1.0); bulb(0xffffff, 0, 1.0, -12.4);
  const strobes = [bulb(0xffffff, -14.6, 2.0, 0.4), bulb(0xffffff, 14.6, 2.0, 0.4), bulb(0xff3030, 0, 5.8, -10.2), bulb(0xff3030, 0, -1.2, 0)];
  // belly doors (open during the drop)
  const doors = [-0.5, 0.5].map(x => add(new THREE.BoxGeometry(0.9, 0.1, 3), red, x, -1.12, -0.5));
  g.userData = { body, props, strobes, doors };
  g.scale.setScalar(scale);
  return g;
}
// per-frame animation: props spin, strobes flash, roll/pitch applied to the body
export function animateTanker(g, t, { roll = 0, pitch = 0, doorsOpen = false } = {}){
  const u = g.userData;
  for (const p of u.props) p.rotation.z += 1.6;
  u.strobes.forEach((s, i) => { s.visible = (Math.floor(t * 1.4 + (i > 1 ? 0.5 : 0)) % 2 === 0) && (t * 1.4 % 1) < 0.18; });
  u.body.rotation.z = roll; u.body.rotation.x = pitch;
  for (const d of u.doors) d.rotation.z = doorsOpen ? (d.position.x < 0 ? 0.9 : -0.9) : 0;
}
