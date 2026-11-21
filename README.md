# A3TN Command

3D command-and-control prototype for industrial fire response, built for the Tunisian Aeroday aero-entrepreneur challenge (in partnership with the Protection Civile).

A simulated fire at a chemical site drives live sensor readings on drones and ground crews, a risk grid that explains itself, hazard-aware routing, and an alert banner (Visor) that warns and auto-withdraws crews before they exceed exposure limits.

> Prototype. Simulated data only.

## Run it

Open `index.html` in a recent desktop browser (Chrome, Edge, Firefox). It loads three.js from a CDN, so an internet connection is needed. Or serve the folder locally:

```
python -m http.server 8765
```

then open http://localhost:8765.

## What it does

- **Fire, smoke and embers**: CPU-simulated particles with curl-noise turbulence and soft billboard sprites; a flickering point light casts shadows on the site.
- **Fire physics**: logistic growth, Heskestad flame height, point-source radiant heat flux, a McCaffrey/Heskestad plume and a Gaussian plume for CO₂ / CO / soot. Wind changes everything.
- **Fire spread**: radiant heat dose on the neighbouring warehouse can ignite a second fire; cooling the wall slows it.
- **Sensors and alerts**: each unit reads air temperature, heat flux, CO₂, CO and visibility against firefighter exposure limits; the Visor escalates from quiet to advisory, warning and hazard, and can auto-withdraw a crew.
- **Risk grid**: 10×10 cells, colour-coded, with a "Why is this red?" explanation for any cell.
- **Routing**: A* over a 4 m navigation grid that avoids hazard cells and re-plans as the fire evolves.
- **Commands**: tap the map, use quick actions, or type / speak commands such as `send E2 to C4`, `foam E1`, `pull back all in red`, `wind from N 6`.
