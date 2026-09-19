#!/usr/bin/env python
"""Prepare pinned historical-bug workspaces and measure local fail-before viability."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess
from datetime import datetime, timezone


ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "consolidation" / "open-world-apprenticeship-20260901"
SEAL = OUT / "apprenticeship-seal.json"
PUBLIC = OUT / "public-tasks.json"
ORACLES = OUT / "sealed-test-oracles.json"
MIRRORS = OUT / "mirrors"
WORKSPACES = OUT / "workspaces"
INSTANCES = OUT / "execution-instances.jsonl"
WORKSPACE_MAP = OUT / "workspace-map.json"
REPORT = OUT / "baseline-viability-report.json"
ACTIVE = ROOT / "models" / "lari" / "current" / "swarm-model.json"
REGISTRY = ROOT / "models" / "lari" / "registry.json"


def sha_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command: list[str], cwd: pathlib.Path | None = None, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd or ROOT, text=True, capture_output=True, timeout=timeout, check=False)


def git(args: list[str], cwd: pathlib.Path | None = None, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return run(["git", "--no-optional-locks", *args], cwd=cwd, timeout=timeout)


def require_ok(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-4000:]
        raise RuntimeError(f"{label} failed ({result.returncode}): {detail}")


def repo_slug(repo: str) -> str:
    return repo.replace("/", "__")


def first_test_path(node_ids: list[str]) -> str:
    if not node_ids:
        raise ValueError("Task has no FAIL_TO_PASS tests")
    return node_ids[0].split("::", 1)[0].replace("\\", "/")


def classify_baseline(result: subprocess.CompletedProcess[str]) -> str:
    output = f"{result.stdout or ''}\n{result.stderr or ''}"
    lowered = output.lower()
    blocked_markers = [
        "error collecting", "modulenotfounderror", "importerror while importing",
        "no module named", "unrecognized arguments", "could not find a version",
        "failed to import", "internalerror", "syntaxerror",
    ]
    if result.returncode == 0:
        return "unexpected_pass"
    if any(marker in lowered for marker in blocked_markers) or result.returncode not in (1,):
        return "harness_blocked"
    if " failed" in lowered or "failure" in lowered:
        return "behavioral_failure"
    return "harness_blocked"


def main() -> None:
    if REPORT.exists() or INSTANCES.exists() or WORKSPACE_MAP.exists():
        raise FileExistsError("Immutable apprenticeship preparation artifacts already exist")
    seal = json.loads(SEAL.read_text(encoding="utf-8"))
    public = json.loads(PUBLIC.read_text(encoding="utf-8"))
    oracles = json.loads(ORACLES.read_text(encoding="utf-8"))
    if sha_file(PUBLIC) != seal["publicTasks"]["sha256"] or sha_file(ORACLES) != seal["sealedTestOracles"]["sha256"]:
        raise RuntimeError("Apprenticeship seal mismatch")
    active_before = sha_file(ACTIVE)
    registry_before = sha_file(REGISTRY)
    if active_before != seal["parent"]["sha256"]:
        raise RuntimeError("Active model no longer matches sealed parent")

    tasks = {item["instanceId"]: item for item in public["tasks"]}
    tests = {item["instanceId"]: item for item in oracles["tasks"]}
    MIRRORS.mkdir(parents=True, exist_ok=True)
    WORKSPACES.mkdir(parents=True, exist_ok=True)
    instances: list[dict[str, object]] = []
    workspace_map: dict[str, object] = {}
    rows: list[dict[str, object]] = []

    for instance_id in [item["instanceId"] for item in seal["selection"]["commitments"]]:
        task = tasks[instance_id]
        oracle = tests[instance_id]
        mirror = MIRRORS / f"{repo_slug(task['repo'])}.git"
        workspace = WORKSPACES / instance_id
        row: dict[str, object] = {
            "instanceId": instance_id,
            "repo": task["repo"],
            "upstreamBaseCommit": task["baseCommit"],
            "workspace": str(workspace.relative_to(ROOT)).replace("\\", "/"),
        }
        try:
            if not mirror.exists():
                cloned = git(["clone", "--mirror", f"https://github.com/{task['repo']}.git", str(mirror)], timeout=900)
                require_ok(cloned, f"clone mirror {task['repo']}")
            fetched = git(["fetch", "origin", task["baseCommit"]], cwd=mirror, timeout=600)
            require_ok(fetched, f"fetch {instance_id}")
            if workspace.exists():
                raise FileExistsError(f"Workspace already exists: {workspace}")
            cloned_workspace = git(["clone", "--shared", str(mirror), str(workspace)], timeout=600)
            require_ok(cloned_workspace, f"clone workspace {instance_id}")
            checkout = git(["checkout", "--detach", task["baseCommit"]], cwd=workspace)
            require_ok(checkout, f"checkout {instance_id}")
            applied = subprocess.run(
                ["git", "--no-optional-locks", "apply", "--whitespace=nowarn", "-"],
                cwd=workspace, input=oracle["testPatch"], text=True, capture_output=True, timeout=120, check=False,
            )
            require_ok(applied, f"apply sealed test patch {instance_id}")
            require_ok(git(["config", "user.name", "Lari Sealed Oracle"], cwd=workspace), "configure oracle author")
            require_ok(git(["config", "user.email", "lari-oracle@invalid.local"], cwd=workspace), "configure oracle email")
            require_ok(git(["add", "-A"], cwd=workspace), f"stage oracle {instance_id}")
            committed = git(["commit", "-m", f"sealed test oracle for {instance_id}"], cwd=workspace)
            require_ok(committed, f"commit oracle {instance_id}")
            oracle_commit_run = git(["rev-parse", "HEAD"], cwd=workspace)
            require_ok(oracle_commit_run, f"resolve oracle commit {instance_id}")
            oracle_commit = oracle_commit_run.stdout.strip()
            runner_args = ["python", "-m", "pytest", *oracle["failToPass"], "-q"]
            baseline = run(runner_args, cwd=workspace, timeout=180)
            classification = classify_baseline(baseline)
            test_path = first_test_path(oracle["failToPass"])
            row.update({
                "prepared": True,
                "oracleCommit": oracle_commit,
                "testPath": test_path,
                "testRunner": " ".join(runner_args),
                "baseline": {
                    "classification": classification,
                    "exitCode": baseline.returncode,
                    "output": f"{baseline.stdout or ''}{baseline.stderr or ''}"[-8000:],
                },
            })
            instances.append({
                "instance_id": instance_id,
                "repo": task["repo"],
                "base_commit": oracle_commit,
                "problem_statement": task["problemStatement"],
            })
            workspace_map[instance_id] = {
                "path": str(workspace),
                "testPath": test_path,
                "testRunner": " ".join(runner_args),
                "executor": "local_isolated_checkout",
            }
        except Exception as error:  # preserve every partial workspace for audit
            row.update({"prepared": False, "preparationError": str(error)})
        rows.append(row)

    INSTANCES.write_text("".join(json.dumps(item, sort_keys=True) + "\n" for item in instances), encoding="utf-8")
    WORKSPACE_MAP.write_text(json.dumps(workspace_map, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    active_after = sha_file(ACTIVE)
    registry_after = sha_file(REGISTRY)
    counts = {
        key: sum(1 for row in rows if row.get("baseline", {}).get("classification") == key)
        for key in ("behavioral_failure", "harness_blocked", "unexpected_pass")
    }
    report = {
        "schemaVersion": 1,
        "kind": "lari.open-world-apprenticeship.baseline-viability",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "parentHash": seal["parent"]["sha256"],
        "sealSha256": sha_file(SEAL),
        "rows": rows,
        "counts": {**counts, "prepared": sum(1 for row in rows if row.get("prepared"))},
        "integrity": {
            "activeBefore": active_before, "activeAfter": active_after,
            "registryBefore": registry_before, "registryAfter": registry_after,
            "readOnly": active_before == active_after and registry_before == registry_after,
        },
        "externalModelCalls": 0,
        "passed": counts["behavioral_failure"] > 0 and active_before == active_after and registry_before == registry_after,
        "interpretation": "Only behavioral_failure rows are eligible to enter Lari learning. Harness-blocked rows are neither model passes nor model failures.",
    }
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "passed": report["passed"], "counts": report["counts"], "readOnly": report["integrity"]["readOnly"],
        "report": str(REPORT.relative_to(ROOT)).replace("\\", "/"),
    }, indent=2))


if __name__ == "__main__":
    main()
