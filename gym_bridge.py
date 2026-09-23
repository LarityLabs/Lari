#!/usr/bin/env python3
"""Lari gym bridge: wraps Gymnasium environments behind a JSON-stdio protocol.

The Node driver (swarm_gym.js) spawns this as a one-shot child process per
request (same sandboxing bar as runCodeSandbox: fresh process, hard timeout
enforced by the caller, stdio captured, no network use). This script reads ONE
JSON document from stdin and writes ONE JSON document to stdout.

Commands:
  {"cmd": "envs"}
    -> {"ok": true, "envs": ["CartPole-v1", ...]}

  {"cmd": "reset", "env": "CartPole-v1", "seed": 0}
    -> {"ok": true, "obs": [...]}
  {"cmd": "step", "action": 1}
    -> {"ok": true, "obs": [...], "reward": 1.0, "done": true}
  (reset/step keep session state in this process; intended for a long-lived
  child driven interactively, e.g. demos or outer-loop inspection.)

  {"cmd": "evaluate", "env": "CartPole-v1", "policy": "<python source>",
   "episodes": 30, "max_steps": 500, "seed": 0}
    -> {"ok": true, "mean": .., "std": .., "min": .., "max": ..,
        "rewards": [...], "episodes": N}
  (runs the whole evaluation in-process: fast, no per-step IPC.)

Policy code contract:
  - Must define `act(obs)`. `obs` is ALWAYS a list of numbers; discrete
    observation spaces arrive as a single-element list, e.g. FrozenLake
    state 5 arrives as [5]. Blackjack (player_sum, dealer_card, usable_ace)
    arrives as [21.0, 10.0, 1.0].
  - Must return an int action valid for the env's discrete action space.
  - Executed with restricted builtins (no imports, no I/O). Induced policies
    are threshold rules / small tables; they do not need more.

Requires the `gymnasium` package. Lari's venv lives at
~/workspace/venvs/lari-gym (see LARI_GYM_PYTHON in swarm_gym.js).
"""

import json
import math
import sys

try:
    import gymnasium as gym
except ImportError as exc:  # pragma: no cover
    sys.stdout.write(json.dumps({"ok": False, "error": "gymnasium not installed: %s" % exc}))
    sys.exit(0)

# ---------------------------------------------------------------------------
# Env registry: env id -> {max_steps}
# ---------------------------------------------------------------------------
ENV_REGISTRY = {
    "CartPole-v1": {"max_steps": 500},
    "FrozenLake-v1": {"max_steps": 200},
    "Blackjack-v1": {"max_steps": 100},
    "Taxi-v3": {"max_steps": 500},
}

_session_env = None
_session_env_id = None


def _to_list(obs):
    """Normalize any Gymnasium observation to a plain list of numbers."""
    try:
        import numpy as np
        if isinstance(obs, np.ndarray):
            return [float(x) for x in obs.flat]
        if isinstance(obs, np.generic):
            return [float(obs)]
    except ImportError:
        pass
    if isinstance(obs, (tuple, list)):
        out = []
        for x in obs:
            out.append(1.0 if x is True else (0.0 if x is False else float(x)))
        return out
    if isinstance(obs, bool):
        return [1.0 if obs else 0.0]
    return [float(obs)]


_SAFE_BUILTINS = {
    "abs": abs, "min": min, "max": max, "round": round,
    "len": len, "range": range, "int": int, "float": float,
    "sum": sum, "sorted": sorted,
}


def _load_policy(code):
    """Compile induced policy source; returns act(obs) or raises."""
    namespace = {"__builtins__": dict(_SAFE_BUILTINS)}
    exec(compile(str(code), "<lari_policy>", "exec"), namespace)
    act = namespace.get("act")
    if not callable(act):
        raise ValueError("policy code must define a callable act(obs)")
    return act


def _cmd_envs(_req):
    return {"ok": True, "envs": sorted(ENV_REGISTRY.keys())}


def _cmd_reset(req):
    global _session_env, _session_env_id
    env_id = req.get("env")
    if env_id not in ENV_REGISTRY:
        return {"ok": False, "error": "unknown env: %r" % (env_id,)}
    if _session_env_id != env_id:
        if _session_env is not None:
            _session_env.close()
        _session_env = gym.make(env_id)
        _session_env_id = env_id
    obs, _info = _session_env.reset(seed=req.get("seed"))
    return {"ok": True, "obs": _to_list(obs)}


def _cmd_step(req):
    if _session_env is None:
        return {"ok": False, "error": "no env: call reset first"}
    action = int(req.get("action", 0))
    out = _session_env.step(action)
    if len(out) == 5:
        obs, reward, terminated, truncated, _info = out
        done = bool(terminated or truncated)
    else:  # pragma: no cover - very old gym API
        obs, reward, done, _info = out
    return {"ok": True, "obs": _to_list(obs),
            "reward": float(reward), "done": done}


def _cmd_evaluate(req):
    env_id = req.get("env")
    if env_id not in ENV_REGISTRY:
        return {"ok": False, "error": "unknown env: %r" % (env_id,)}
    try:
        act = _load_policy(req.get("policy", ""))
    except Exception as exc:
        return {"ok": False, "error": "bad policy: %s" % exc}
    episodes = max(1, int(req.get("episodes", 30)))
    max_steps = int(req.get("max_steps", ENV_REGISTRY[env_id]["max_steps"]))
    base_seed = int(req.get("seed", 0))
    env = gym.make(env_id)
    rewards = []
    try:
        n_actions = int(env.action_space.n)
        for ep in range(episodes):
            obs, _info = env.reset(seed=base_seed + ep)
            total = 0.0
            for _ in range(max_steps):
                try:
                    action = int(act(_to_list(obs)))
                except Exception:
                    action = 0
                action = max(0, min(n_actions - 1, action))
                out = env.step(action)
                if len(out) == 5:
                    obs, reward, terminated, truncated, _info = out
                    done = bool(terminated or truncated)
                else:  # pragma: no cover
                    obs, reward, done, _info = out
                total += float(reward)
                if done:
                    break
            rewards.append(total)
    finally:
        env.close()
    n = len(rewards)
    mean = sum(rewards) / n
    var = sum((r - mean) ** 2 for r in rewards) / n
    return {"ok": True, "mean": mean, "std": math.sqrt(var),
            "min": min(rewards), "max": max(rewards),
            "rewards": rewards, "episodes": n}


_HANDLERS = {
    "envs": _cmd_envs,
    "reset": _cmd_reset,
    "step": _cmd_step,
    "evaluate": _cmd_evaluate,
}


def main():
    # --serve: NDJSON session mode. Each stdin line is one JSON request,
    # each stdout line is the JSON response. Used by GymSession for
    # interactive reset/step driving.
    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception as exc:
                sys.stdout.write(json.dumps({"ok": False, "error": "bad JSON: %s" % exc}) + "\n")
                sys.stdout.flush()
                continue
            handler = _HANDLERS.get(req.get("cmd"))
            if handler is None:
                resp = {"ok": False, "error": "unknown cmd"}
            else:
                try:
                    resp = handler(req)
                except Exception as exc:  # never let a traceback escape as non-JSON
                    resp = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        return
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": "bad JSON: %s" % exc}))
        return
    handler = _HANDLERS.get(req.get("cmd"))
    if handler is None:
        sys.stdout.write(json.dumps({"ok": False, "error": "unknown cmd"}))
        return
    try:
        resp = handler(req)
    except Exception as exc:  # never let a traceback escape as non-JSON
        resp = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    sys.stdout.write(json.dumps(resp))


if __name__ == "__main__":
    main()
