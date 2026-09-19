#!/usr/bin/env python
"""Seal a fresh, gold-patch-withheld SWE-bench apprenticeship lane.

This script selects instance IDs audited as absent from Lari's prior evidence
corpus.  It writes public task metadata separately from sealed test material.
The upstream source patch is never copied out of the pinned parquet file; only
its hash is committed to the seal.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
from datetime import datetime, timezone

import pandas as pd


ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "consolidation" / "open-world-apprenticeship-20260901"
DATASET = OUT / "swebench-verified-test.parquet"
ACTIVE = ROOT / "models" / "lari" / "current" / "swarm-model.json"
REGISTRY = ROOT / "models" / "lari" / "registry.json"
PUBLIC = OUT / "public-tasks.json"
ORACLES = OUT / "sealed-test-oracles.json"
SEAL = OUT / "apprenticeship-seal.json"

SELECTED_IDS = [
    "pallets__flask-5014",
    "psf__requests-5414",
    "psf__requests-2931",
    "pytest-dev__pytest-10081",
    "pytest-dev__pytest-10356",
    "pytest-dev__pytest-5809",
    "pylint-dev__pylint-6903",
    "pylint-dev__pylint-7277",
    "pylint-dev__pylint-8898",
    "mwaskom__seaborn-3187",
]


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_file(path: pathlib.Path) -> str:
    return sha_bytes(path.read_bytes())


def canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()


def json_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    parsed = json.loads(str(value))
    if not isinstance(parsed, list):
        raise ValueError("Expected JSON list")
    return [str(item) for item in parsed]


def preexisting_paths(instance_id: str) -> list[str]:
    command = [
        "rg", "-l", "-F", instance_id, ".",
        "-g", "!node_modules/**",
        "-g", "!models/**",
        "-g", "!consolidation/stage-1-unified-candidate.json",
        "-g", "!consolidation/open-world-apprenticeship-20260901/**",
        "-g", "!scripts/seal_lari_open_world_apprenticeship.py",
    ]
    run = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    if run.returncode not in (0, 1):
        raise RuntimeError(run.stderr.strip() or "rg freshness audit failed")
    return sorted(line.strip().replace("\\", "/") for line in run.stdout.splitlines() if line.strip())


def main() -> None:
    for path in (DATASET, ACTIVE, REGISTRY):
        if not path.exists():
            raise FileNotFoundError(path)
    for path in (PUBLIC, ORACLES, SEAL):
        if path.exists():
            raise FileExistsError(f"Immutable seal artifact already exists: {path}")

    active_hash = sha_file(ACTIVE)
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    registry_hash = registry.get("activeModelSha256") or registry.get("metadata", {}).get("candidateHash")
    if registry_hash != active_hash:
        raise RuntimeError("Registry is not bound to active model bytes")

    frame = pd.read_parquet(DATASET)
    indexed = frame.set_index("instance_id", drop=False)
    missing = [item for item in SELECTED_IDS if item not in indexed.index]
    if missing:
        raise RuntimeError(f"Selected instances missing from dataset: {missing}")

    freshness = {instance_id: preexisting_paths(instance_id) for instance_id in SELECTED_IDS}
    contaminated = {key: value for key, value in freshness.items() if value}
    if contaminated:
        raise RuntimeError(f"Selected instances already occur in prior repository evidence: {contaminated}")

    public_rows = []
    oracle_rows = []
    commitments = []
    for instance_id in SELECTED_IDS:
        row = indexed.loc[instance_id]
        problem = str(row["problem_statement"])
        test_patch = str(row["test_patch"])
        gold_patch = str(row["patch"])
        fail_to_pass = json_list(row["FAIL_TO_PASS"])
        pass_to_pass = json_list(row["PASS_TO_PASS"])
        public_rows.append({
            "instanceId": instance_id,
            "repo": str(row["repo"]),
            "baseCommit": str(row["base_commit"]),
            "problemStatement": problem,
            "problemStatementSha256": sha_bytes(problem.encode()),
            "difficulty": str(row["difficulty"]),
            "language": "python",
        })
        oracle_rows.append({
            "instanceId": instance_id,
            "testPatch": test_patch,
            "testPatchSha256": sha_bytes(test_patch.encode()),
            "failToPass": fail_to_pass,
            "passToPass": pass_to_pass,
        })
        commitments.append({
            "instanceId": instance_id,
            "repo": str(row["repo"]),
            "baseCommit": str(row["base_commit"]),
            "problemStatementSha256": sha_bytes(problem.encode()),
            "testPatchSha256": sha_bytes(test_patch.encode()),
            "withheldGoldPatchSha256": sha_bytes(gold_patch.encode()),
            "goldPatchCopiedToArtifacts": False,
            "preexistingCorpusPaths": [],
        })

    public_doc = {
        "schemaVersion": 1,
        "kind": "lari.open-world-apprenticeship.public-tasks",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "parentHash": active_hash,
        "tasks": public_rows,
    }
    oracle_doc = {
        "schemaVersion": 1,
        "kind": "lari.open-world-apprenticeship.sealed-test-oracles",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "learnerReadable": False,
        "tasks": oracle_rows,
    }
    public_bytes = canonical_bytes(public_doc)
    oracle_bytes = canonical_bytes(oracle_doc)
    PUBLIC.write_bytes(public_bytes)
    ORACLES.write_bytes(oracle_bytes)

    seal = {
        "schemaVersion": 1,
        "kind": "lari.open-world-apprenticeship.seal",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "canonicalRuntime": "sendMessageToLari -> runLariUnifiedTaskKernel",
        "parent": {"path": "models/lari/current/swarm-model.json", "sha256": active_hash},
        "registry": {"path": "models/lari/registry.json", "sha256": sha_file(REGISTRY), "bound": True},
        "dataset": {
            "source": "princeton-nlp/SWE-bench_Verified test split",
            "path": str(DATASET.relative_to(ROOT)).replace("\\", "/"),
            "sha256": sha_file(DATASET),
            "rowCount": int(len(frame)),
        },
        "publicTasks": {"path": str(PUBLIC.relative_to(ROOT)).replace("\\", "/"), "sha256": sha_bytes(public_bytes)},
        "sealedTestOracles": {"path": str(ORACLES.relative_to(ROOT)).replace("\\", "/"), "sha256": sha_bytes(oracle_bytes)},
        "selection": {
            "count": len(commitments),
            "repositoryCount": len({item["repo"] for item in commitments}),
            "languages": ["python"],
            "freshnessRule": "instance ID absent from repository evidence before this seal",
            "commitments": commitments,
        },
        "protocol": {
            "learnerInputs": ["problem statement", "pinned buggy checkout", "test-side oracle applied to checkout"],
            "learnerForbiddenInputs": ["withheld upstream source patch", "hidden transfer tasks", "benchmark answer metadata"],
            "requiredLifecycle": [
                "baseline failure", "diagnostic hypothesis", "existing primitive search", "missing primitive diagnosis when exhausted",
                "candidate learning", "exact fail-to-pass", "sealed transfer", "cold reload", "exact ablation", "rollback",
            ],
            "qualificationTarget": {
                "independentTaskPasses": 6,
                "newReusableCapabilities": 3,
                "sealedTransfersPerCapability": 2,
                "familyRegressions": 0,
                "externalModelCalls": 0,
            },
            "productionPromotionAllowed": False,
        },
        "limitations": [
            "This first official lane contains Python tasks only; it does not satisfy the four-language end goal.",
            "Local Windows execution is developmental evidence, not an official SWE-bench score.",
            "A selected task counts only when its declared tests fail before and pass after the Lari-authored patch.",
        ],
    }
    SEAL.write_bytes(canonical_bytes(seal))
    print(json.dumps({
        "passed": True,
        "parentHash": active_hash,
        "tasks": len(commitments),
        "repositories": seal["selection"]["repositoryCount"],
        "languages": seal["selection"]["languages"],
        "publicTasksSha256": seal["publicTasks"]["sha256"],
        "sealedOraclesSha256": seal["sealedTestOracles"]["sha256"],
        "sealSha256": sha_file(SEAL),
    }, indent=2))


if __name__ == "__main__":
    main()
