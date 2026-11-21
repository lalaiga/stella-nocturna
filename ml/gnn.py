"""Message-passing GNN that predicts how smoke and heat move through a building's room graph.

Nodes are rooms, edges are door openings. Given the current state of every room it predicts the
change over the next 5 s; rolling it forward gives a multi-minute forecast for any floor plan.
"""
from __future__ import annotations
import math
import numpy as np
import torch
from torch import nn

T_SCALE = 500.0
Q_SCALE = 2000.0


def mlp(i, h, o):
    return nn.Sequential(nn.Linear(i, h), nn.SiLU(), nn.Linear(h, h), nn.SiLU(), nn.Linear(h, o))


class SmokeGNN(nn.Module):
    NODE_IN = 7   # s, T, Q, Q_next, logV, ext_area, s_out
    EDGE_IN = 1   # door open area

    def __init__(self, hidden=96, layers=4):
        super().__init__()
        self.enc = mlp(self.NODE_IN, hidden, hidden)
        self.eenc = mlp(self.EDGE_IN, hidden, hidden)
        self.edge_mlps = nn.ModuleList([mlp(3 * hidden, hidden, hidden) for _ in range(layers)])
        self.node_mlps = nn.ModuleList([mlp(2 * hidden, hidden, hidden) for _ in range(layers)])
        self.dec = mlp(hidden, hidden, 2)

    def forward(self, x, ei, ea):
        h = self.enc(x); e = self.eenc(ea)
        src, dst = ei
        for em, nm in zip(self.edge_mlps, self.node_mlps):
            m = em(torch.cat([h[src], h[dst], e], dim=-1))
            e = e + m
            agg = torch.zeros_like(h).index_add_(0, dst, m)
            h = h + nm(torch.cat([h, agg], dim=-1))
        return self.dec(h)


def node_features(s, T, Q, Qn, V, ext, s_out):
    return np.stack([s, (T - 20) / T_SCALE, Q / Q_SCALE, Qn / Q_SCALE,
                     (np.log(V) - 4.0) / 1.5, ext / 6.0, s_out], axis=-1).astype(np.float32)


def edge_tensors(edges):
    """Undirected door list (E,3) -> directed edge_index (2,2E) and attr (2E,1)."""
    if len(edges) == 0:
        return np.zeros((2, 0), np.int64), np.zeros((0, 1), np.float32)
    i = edges[:, 0].astype(np.int64); j = edges[:, 1].astype(np.int64); a = edges[:, 2].astype(np.float32) / 6.0
    ei = np.stack([np.concatenate([i, j]), np.concatenate([j, i])])
    return ei, np.concatenate([a, a])[:, None]


@torch.no_grad()
def rollout(model, V, edges, ext, s_out, s0, T0, Q_sched, device="cpu"):
    """Q_sched: (steps+1, n) HRR per room at each 5 s step. Returns s, T arrays (steps+1, n)."""
    ei, ea = edge_tensors(np.asarray(edges, float).reshape(-1, 3))
    ei = torch.as_tensor(ei, device=device); ea = torch.as_tensor(ea, device=device)
    s, T = np.asarray(s0, float), np.asarray(T0, float)
    S, TT = [s.copy()], [T.copy()]
    for k in range(len(Q_sched) - 1):
        x = torch.as_tensor(node_features(s, T, Q_sched[k], Q_sched[k + 1], V, ext, s_out), device=device)
        d = model(x, ei, ea).cpu().numpy()
        s = np.clip(s + d[:, 0], 0, 1); T = np.clip(T + d[:, 1] * T_SCALE, 15, 1200)
        S.append(s.copy()); TT.append(T.copy())
    return np.array(S), np.array(TT)
