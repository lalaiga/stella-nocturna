"""Multi-room zone fire model used as ground truth for the GNN smoke-spread surrogate.

Each room is a well-mixed zone with:
  s  smoke optical-density index in [0, 1] (0 clear, 1 opaque; visibility ~ 3 / (s*K))
  T  gas temperature (°C)
Fire rooms follow the NFPA 72 / SFPE t-squared growth law  Q(t) = min(Qmax, alpha * t^2)
("fast" alpha = 0.0469 kW/s^2).  Rooms exchange smoke and heat through door openings with a
buoyancy-driven flow ~ A * sqrt(|dT|), and lose both through openings to the outside.

The same equations are mirrored in web/js/interior.js so the live view and the training data agree.
"""
from __future__ import annotations
import numpy as np

ALPHA_FAST = 0.0469     # kW/s^2
RHO_CP = 1.2            # kJ/(m^3 K), air
T_AMB = 20.0
DT = 1.0                # s, integration step
STEP = 5                # zone-model steps per GNN step (GNN predicts 5 s ahead)


def fire_hrr(t_since_ign: np.ndarray, qmax: np.ndarray) -> np.ndarray:
    t = np.maximum(t_since_ign, 0.0)
    return np.where(t_since_ign >= 0, np.minimum(qmax, ALPHA_FAST * t * t), 0.0)


def zone_step(s, T, Q, V, edges, ext_area, s_out, dt=DT):
    """One explicit step. edges: (E, 3) array of [i, j, open_area_m2]."""
    s = s.copy(); T = T.copy()
    # heat and smoke production in fire rooms (60 % of HRR heats the gas)
    T += dt * (0.6 * Q / (RHO_CP * V))
    s += dt * (0.0035 * Q / V) * (1.0 - s)
    # inter-room exchange through doors (buoyancy-driven, symmetric mixing)
    if len(edges):
        i = edges[:, 0].astype(int); j = edges[:, 1].astype(int); A = edges[:, 2]
        flow = 0.35 * A * np.sqrt(np.abs(T[i] - T[j]) + 4.0)          # m^3/s
        ds = flow * (s[i] - s[j]); dT = flow * (T[i] - T[j])
        np.add.at(s, i, -dt * ds / V[i]); np.add.at(s, j, dt * ds / V[j])
        np.add.at(T, i, -dt * dT / V[i]); np.add.at(T, j, dt * dT / V[j])
    # exchange with outside through open exterior doors / vents
    fo = 0.35 * ext_area * np.sqrt(np.abs(T - T_AMB) + 4.0)
    s += dt * fo * (s_out - s) / V
    T += dt * fo * (T_AMB - T) / V
    # wall heat loss
    T -= dt * 0.004 * (T - T_AMB)
    return np.clip(s, 0, 1), np.clip(T, T_AMB - 5, 1200)


def random_building(rng: np.random.Generator):
    """Random grid floor plan: rooms on a gx x gy grid, doors on a spanning tree + extras."""
    gx, gy = rng.integers(2, 6), rng.integers(2, 5)
    n = gx * gy
    w = rng.uniform(3, 12, size=gx); d = rng.uniform(3, 10, size=gy)
    h = rng.uniform(2.6, 6.0)
    V = np.array([w[k % gx] * d[k // gx] * h for k in range(n)])
    cand = []
    for k in range(n):
        x, y = k % gx, k // gx
        if x + 1 < gx: cand.append((k, k + 1))
        if y + 1 < gy: cand.append((k, k + gx))
    rng.shuffle(cand)
    parent = list(range(n))
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    edges = []
    for a, b in cand:
        ra, rb = find(a), find(b)
        if ra != rb or rng.random() < 0.3:
            parent[ra] = rb
            area = rng.choice([0.0, 1.0, 1.8, 2.0, 6.0], p=[0.1, 0.25, 0.35, 0.2, 0.1])  # closed/door/double/wide
            edges.append((a, b, area))
    edges = np.array(edges, dtype=float).reshape(-1, 3)
    boundary = np.array([(k % gx in (0, gx - 1)) or (k // gx in (0, gy - 1)) for k in range(n)])
    ext_area = np.where(boundary & (rng.random(n) < 0.35), rng.choice([0.0, 1.8, 6.0], size=n), 0.0)
    return V, edges, ext_area


def random_scenario(rng, steps=72):
    """Return graph + trajectory sampled every STEP seconds: arrays (steps+1, n) for s, T, Q."""
    V, edges, ext_area = random_building(rng)
    n = len(V)
    qmax = np.zeros(n); t_ign = np.full(n, -1e9)
    nf = rng.integers(1, 3)
    for r in rng.choice(n, size=min(nf, n), replace=False):
        qmax[r] = rng.uniform(300, 4000)
        t_ign[r] = -rng.uniform(0, 240)           # fire already burning for up to 4 min
    s_out = np.where(ext_area > 0, rng.uniform(0, 0.5, n) * (rng.random(n) < 0.3), 0.0)
    s = np.zeros(n); T = np.full(n, T_AMB)
    # spin up so initial states are diverse
    spin = int(rng.uniform(0, 120))
    for k in range(spin):
        s, T = zone_step(s, T, fire_hrr(-t_ign + k, qmax), V, edges, ext_area, s_out)
    t0 = -t_ign + spin                             # seconds since ignition at trajectory start
    S, TT, QQ = [s.copy()], [T.copy()], [fire_hrr(t0, qmax)]
    t = 0.0
    for _ in range(steps):
        for _ in range(STEP):
            Q = fire_hrr(t0 + t, qmax)
            s, T = zone_step(s, T, Q, V, edges, ext_area, s_out)
            t += DT
        S.append(s.copy()); TT.append(T.copy()); QQ.append(fire_hrr(t0 + t, qmax))
    return dict(V=V, edges=edges, ext=ext_area, s_out=s_out, qmax=qmax,
                S=np.array(S), T=np.array(TT), Q=np.array(QQ))
