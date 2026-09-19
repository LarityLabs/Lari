#!/usr/bin/env python
"""Seal and prepare two untouched external predicate-domain transfer tasks."""

from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
from datetime import datetime, timezone

import pandas as pd


ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "consolidation" / "predicate-domain-transfer-20260902"
DATASET = ROOT / "consolidation" / "open-world-apprenticeship-20260901" / "swebench-verified-test.parquet"
ACTIVE = ROOT / "models" / "lari" / "current" / "swarm-model.json"
REGISTRY = ROOT / "models" / "lari" / "registry.json"
CANDIDATE = ROOT / "consolidation" / "open-world-apprenticeship-20260901" / "provisional-candidates" / "0a3ce1e0c6bf51b5d61ddca8b0c089661905246d7ce5ae6577cddea8fad8c0fd.json"
IDS = ["astropy__astropy-7336", "sphinx-doc__sphinx-9673"]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(args: list[str], cwd: pathlib.Path = ROOT, timeout: int = 300, input_text: str | None = None):
    return subprocess.run(args, cwd=cwd, input=input_text, text=True, capture_output=True, timeout=timeout, check=False)


def require_ok(result, label: str) -> None:
    if result.returncode:
        raise RuntimeError(f"{label} failed ({result.returncode}): {(result.stderr or result.stdout)[-4000:]}")


def json_list(value) -> list[str]:
    parsed = value if isinstance(value, list) else json.loads(str(value))
    return [str(item) for item in parsed]


def main() -> None:
    if OUT.exists():
        raise FileExistsError(f"Immutable transfer directory already exists: {OUT}")
    for file in (DATASET, ACTIVE, REGISTRY, CANDIDATE):
        if not file.exists():
            raise FileNotFoundError(file)
    active_before = sha(ACTIVE.read_bytes())
    registry_before = sha(REGISTRY.read_bytes())
    candidate_hash = sha(CANDIDATE.read_bytes())
    if candidate_hash != CANDIDATE.stem:
        raise RuntimeError("Candidate filename does not match immutable bytes")

    frame = pd.read_parquet(DATASET).set_index("instance_id", drop=False)
    OUT.mkdir(parents=True)
    public_tasks = []
    oracle_tasks = []
    commitments = []
    for instance_id in IDS:
        row = frame.loc[instance_id]
        problem = str(row.problem_statement)
        test_patch = str(row.test_patch)
        gold_patch = str(row.patch)
        public_tasks.append({
            "instanceId": instance_id,
            "repo": str(row.repo),
            "baseCommit": str(row.base_commit),
            "problemStatement": problem,
            "problemStatementSha256": sha(problem.encode()),
        })
        oracle_tasks.append({
            "instanceId": instance_id,
            "testPatch": test_patch,
            "testPatchSha256": sha(test_patch.encode()),
            "failToPass": json_list(row.FAIL_TO_PASS),
            "passToPass": json_list(row.PASS_TO_PASS),
        })
        commitments.append({
            "instanceId": instance_id,
            "repo": str(row.repo),
            "baseCommit": str(row.base_commit),
            "problemStatementSha256": sha(problem.encode()),
            "testPatchSha256": sha(test_patch.encode()),
            "withheldGoldPatchSha256": sha(gold_patch.encode()),
            "goldPatchExposedToRuntime": False,
        })

    public = {"schemaVersion": 1, "kind": "lari.predicate-domain-transfer.public", "tasks": public_tasks}
    oracles = {"schemaVersion": 1, "kind": "lari.predicate-domain-transfer.sealed-oracles", "learnerReadable": False, "tasks": oracle_tasks}
    public_bytes = (json.dumps(public, indent=2, sort_keys=True) + "\n").encode()
    oracle_bytes = (json.dumps(oracles, indent=2, sort_keys=True) + "\n").encode()
    (OUT / "public-tasks.json").write_bytes(public_bytes)
    (OUT / "sealed-test-oracles.json").write_bytes(oracle_bytes)
    seal = {
        "schemaVersion": 1,
        "kind": "lari.predicate-domain-transfer.seal",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "canonicalRuntime": "sendMessageToLari -> runLariUnifiedTaskKernel",
        "candidate": {"path": str(CANDIDATE.relative_to(ROOT)).replace("\\", "/"), "sha256": candidate_hash, "promoted": False},
        "incumbent": {"path": str(ACTIVE.relative_to(ROOT)).replace("\\", "/"), "sha256": active_before},
        "publicTasksSha256": sha(public_bytes),
        "sealedOraclesSha256": sha(oracle_bytes),
        "commitments": commitments,
        "protocol": {
            "primitiveDiscovery": False,
            "semanticOperatorDiscovery": False,
            "expressionOperatorDiscovery": False,
            "goldPatchAvailableToRuntime": False,
            "required": ["fail before", "reuse-only pass", "cold reload", "exact primitive ablation", "production read-only"],
        },
    }
    (OUT / "transfer-seal.json").write_text(json.dumps(seal, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    mirrors = OUT / "mirrors"
    workspaces = OUT / "workspaces"
    mirrors.mkdir()
    workspaces.mkdir()
    workspace_map = {}
    rows = []
    for task in public_tasks:
        instance_id = task["instanceId"]
        oracle = next(item for item in oracle_tasks if item["instanceId"] == instance_id)
        mirror = mirrors / f"{task['repo'].replace('/', '__')}.git"
        workspace = workspaces / instance_id
        row = {"instanceId": instance_id, "repo": task["repo"]}
        try:
            require_ok(run(["git", "--no-optional-locks", "clone", "--mirror", f"https://github.com/{task['repo']}.git", str(mirror)], timeout=900), f"mirror {task['repo']}")
            require_ok(run(["git", "--no-optional-locks", "clone", "--shared", str(mirror), str(workspace)], timeout=600), f"workspace {instance_id}")
            require_ok(run(["git", "--no-optional-locks", "checkout", "--detach", task["baseCommit"]], cwd=workspace), f"checkout {instance_id}")
            require_ok(run(["git", "--no-optional-locks", "apply", "--whitespace=nowarn", "-"], cwd=workspace, input_text=oracle["testPatch"]), f"test patch {instance_id}")
            require_ok(run(["git", "config", "user.name", "Lari Sealed Oracle"], cwd=workspace), "git user")
            require_ok(run(["git", "config", "user.email", "lari-oracle@invalid.local"], cwd=workspace), "git email")
            require_ok(run(["git", "add", "-A"], cwd=workspace), "stage oracle")
            require_ok(run(["git", "commit", "-m", f"sealed oracle {instance_id}"], cwd=workspace), "commit oracle")
            runner = ["python", "-m", "pytest", *oracle["failToPass"], "-q"]
            baseline = run(runner, cwd=workspace, timeout=300)
            output = f"{baseline.stdout or ''}{baseline.stderr or ''}"
            behavioral = baseline.returncode == 1 and (" failed" in output.lower() or "failure" in output.lower())
            row.update({"prepared": True, "baselineExitCode": baseline.returncode, "behavioralFailure": behavioral, "baselineOutput": output[-8000:]})
            workspace_map[instance_id] = {
                "path": str(workspace),
                "testPath": oracle["failToPass"][0].split("::", 1)[0],
                "testSelectors": oracle["failToPass"],
            }
        except Exception as error:
            row.update({"prepared": False, "error": str(error)})
        rows.append(row)

    (OUT / "workspace-map.json").write_text(json.dumps(workspace_map, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    active_after = sha(ACTIVE.read_bytes())
    registry_after = sha(REGISTRY.read_bytes())
    report = {
        "schemaVersion": 1,
        "kind": "lari.predicate-domain-transfer.preparation",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "rows": rows,
        "behavioralFailures": sum(bool(row.get("behavioralFailure")) for row in rows),
        "productionReadOnly": active_before == active_after and registry_before == registry_after,
    }
    (OUT / "preparation-report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"behavioralFailures": report["behavioralFailures"], "productionReadOnly": report["productionReadOnly"], "rows": [{"id": row["instanceId"], "prepared": row.get("prepared"), "behavioral": row.get("behavioralFailure"), "error": row.get("error")} for row in rows]}, indent=2))


if __name__ == "__main__":
    main()
