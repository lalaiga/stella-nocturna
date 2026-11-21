"""Train the smoke-spread GNN on zone-model trajectories over random floor plans.

    python ml/train_gnn.py            # writes ml/models/gnn_smoke.pt and gnn_metrics.json
"""
from __future__ import annotations
import json, time, pathlib, sys
import numpy as np
import torch

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from zone_model import random_scenario, STEP
from gnn import SmokeGNN, node_features, edge_tensors, rollout, T_SCALE

OUT = pathlib.Path(__file__).parent / "models"
OUT.mkdir(exist_ok=True)
dev = "cuda" if torch.cuda.is_available() else "cpu"
rng = np.random.default_rng(7)

t0 = time.time()
train = [random_scenario(rng) for _ in range(3000)]
test = [random_scenario(rng) for _ in range(200)]
print(f"generated {len(train)} train / {len(test)} test trajectories in {time.time() - t0:.1f}s")


def batch(scen_list, bs=64, noise=0.01):
    xs, eis, eas, ys = [], [], [], []
    off = 0
    for sc in (scen_list[i] for i in rng.integers(0, len(scen_list), bs)):
        k = rng.integers(0, len(sc["S"]) - 1)
        s, T = sc["S"][k], sc["T"][k]
        # noise injection makes long rollouts stable
        s_in = np.clip(s + rng.normal(0, noise, s.shape), 0, 1)
        T_in = T + rng.normal(0, noise * T_SCALE, T.shape)
        x = node_features(s_in, T_in, sc["Q"][k], sc["Q"][k + 1], sc["V"], sc["ext"], sc["s_out"])
        y = np.stack([sc["S"][k + 1] - s_in, (sc["T"][k + 1] - T_in) / T_SCALE], -1)
        ei, ea = edge_tensors(sc["edges"])
        xs.append(x); ys.append(y); eis.append(ei + off); eas.append(ea); off += len(x)
    return (torch.as_tensor(np.concatenate(xs), device=dev), torch.as_tensor(np.concatenate(eis, 1), device=dev),
            torch.as_tensor(np.concatenate(eas), device=dev), torch.as_tensor(np.concatenate(ys).astype(np.float32), device=dev))


model = SmokeGNN().to(dev)
opt = torch.optim.AdamW(model.parameters(), 2e-3, weight_decay=1e-5)
ITERS = 6000
sched = torch.optim.lr_scheduler.OneCycleLR(opt, 2e-3, total_steps=ITERS)
t0 = time.time()
for it in range(ITERS):
    x, ei, ea, y = batch(train)
    loss = torch.nn.functional.mse_loss(model(x, ei, ea), y)
    opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    if it % 500 == 0:
        print(f"iter {it} loss {loss.item():.2e} ({time.time() - t0:.0f}s)")

# full-rollout evaluation on unseen floor plans (6 min horizon)
model.eval()
es, eT, eT_hot = [], [], []
for sc in test:
    S, TT = rollout(model, sc["V"], sc["edges"], sc["ext"], sc["s_out"], sc["S"][0], sc["T"][0], sc["Q"], dev)
    es.append(np.abs(S - sc["S"]).mean()); eT.append(np.abs(TT - sc["T"]).mean())
    hot = sc["T"] > 60
    if hot.any(): eT_hot.append(np.abs(TT - sc["T"])[hot].mean())
metrics = dict(rollout_horizon_s=int((len(test[0]["S"]) - 1) * STEP), test_floorplans=len(test),
               smoke_index_MAE=float(np.mean(es)), temperature_MAE_C=float(np.mean(eT)),
               temperature_MAE_hot_rooms_C=float(np.mean(eT_hot)), params=sum(p.numel() for p in model.parameters()),
               train_trajectories=len(train), iters=ITERS)
print(json.dumps(metrics, indent=2))
torch.save({"state_dict": model.state_dict(), "hidden": 96, "layers": 4}, OUT / "gnn_smoke.pt")
(OUT / "gnn_metrics.json").write_text(json.dumps(metrics, indent=2))
