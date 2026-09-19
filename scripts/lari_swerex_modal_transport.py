#!/usr/bin/env python3
"""Execute a Lari-authored patch in a tool-only SWE-ReX Modal sandbox.

This module contains no inference client and cannot author or change a patch.
It validates Lari prediction provenance, checks out the exact requested commit,
runs the exact declared tests before and after applying the patch, and returns
only command observations and integrity evidence.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ACTIVE_MODEL = ROOT / "models" / "lari" / "current" / "swarm-model.json"
REGISTRY = ROOT / "models" / "lari" / "registry.json"
CANONICAL_PATH = "sendMessageToLari -> runLariUnifiedTaskKernel"
MAX_CAPTURE = 65536
SECRET_KEY = re.compile(r"(?:api[_-]?key|token|secret|password|credential|authorization)", re.I)
MODEL_ENDPOINT = re.compile(
    r"(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|"
    r"ollama|vllm|litellm|openai[_-]?api|anthropic[_-]?api)",
    re.I,
)


class InvalidJob(ValueError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def read_rows(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict):
            return [parsed]
    except json.JSONDecodeError:
        pass
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise InvalidJob(f"Invalid JSONL at {path}:{number}: {error}") from error
        if not isinstance(row, dict):
            raise InvalidJob(f"Expected an object at {path}:{number}")
        rows.append(row)
    return rows


def inside(base: Path, raw: str, label: str) -> Path:
    candidate = (base / raw).resolve() if not Path(raw).is_absolute() else Path(raw).resolve()
    try:
        candidate.relative_to(ROOT)
    except ValueError as error:
        raise InvalidJob(f"{label} must stay inside the Lari workspace") from error
    return candidate


def normalized_command(raw: Any, label: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise InvalidJob(f"{label} must be an object")
    command = raw.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
        raise InvalidJob(f"{label}.command must be a non-empty string array; shell strings are forbidden")
    cwd = str(raw.get("cwd", ".")).replace("\\", "/")
    if cwd.startswith("/") or re.match(r"^[A-Za-z]:", cwd) or ".." in PurePosixPath(cwd).parts:
        raise InvalidJob(f"{label}.cwd must be relative to the checked-out repository")
    timeout = int(raw.get("timeoutSeconds", 900))
    if timeout < 1 or timeout > 7200:
        raise InvalidJob(f"{label}.timeoutSeconds must be between 1 and 7200")
    env = raw.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in env.items()):
        raise InvalidJob(f"{label}.env must contain string keys and values")
    unsafe_keys = [key for key in env if SECRET_KEY.search(key)]
    if unsafe_keys:
        raise InvalidJob(f"{label}.env may not contain credentials: {', '.join(unsafe_keys)}")
    serialized = json.dumps({"command": command, "env": env})
    if MODEL_ENDPOINT.search(serialized):
        raise InvalidJob(f"{label} references an external model endpoint or runtime")
    return {"command": command, "cwd": cwd, "timeoutSeconds": timeout, "env": env}


def embedded_secret_paths(value: Any, key_path: str = "") -> list[str]:
    findings: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            next_path = f"{key_path}.{key}" if key_path else str(key)
            if SECRET_KEY.search(str(key)) and child not in (None, "", False, [], {}):
                findings.append(next_path)
            findings.extend(embedded_secret_paths(child, next_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            findings.extend(embedded_secret_paths(child, f"{key_path}[{index}]"))
    return findings


def validate_job(job_path: Path) -> dict[str, Any]:
    raw = json.loads(job_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        raise InvalidJob("Job must be an object with schemaVersion 1")
    embedded = embedded_secret_paths(raw)
    if embedded:
        raise InvalidJob(f"Job embeds credential material at: {', '.join(embedded)}")
    architecture = raw.get("architecture", {})
    if architecture.get("reasoner") != "Lari" or architecture.get("externalModelCalls") != 0:
        raise InvalidJob("Job must declare Lari as the sole reasoner and zero external model calls")
    if architecture.get("canonicalRuntimePath") != CANONICAL_PATH:
        raise InvalidJob(f"canonicalRuntimePath must be {CANONICAL_PATH!r}")
    if architecture.get("externalModelEndpoint") is not None:
        raise InvalidJob("externalModelEndpoint must be null")

    instance = raw.get("instance", {})
    instance_id = str(instance.get("instanceId", "")).strip()
    repo = str(instance.get("repo", "")).strip()
    base_commit = str(instance.get("baseCommit", "")).strip().lower()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-\d+", instance_id):
        raise InvalidJob("instance.instanceId is not an official SWE-bench-style identifier")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise InvalidJob("instance.repo must be a GitHub owner/repository slug")
    if not re.fullmatch(r"[0-9a-f]{40}", base_commit):
        raise InvalidJob("instance.baseCommit must be a full 40-character Git commit")

    artifacts = raw.get("lariArtifacts", {})
    predictions_path = inside(job_path.parent, str(artifacts.get("predictionsPath", "")), "predictionsPath")
    provenance_path = inside(job_path.parent, str(artifacts.get("provenancePath", "")), "provenancePath")
    if not predictions_path.is_file() or not provenance_path.is_file():
        raise InvalidJob("Lari prediction and provenance artifacts must exist")
    predictions = [row for row in read_rows(predictions_path) if row.get("instance_id") == instance_id]
    provenances = [row for row in read_rows(provenance_path) if row.get("instanceId") == instance_id]
    if len(predictions) != 1 or len(provenances) != 1:
        raise InvalidJob("Exactly one prediction and one provenance record must match instanceId")
    prediction, provenance = predictions[0], provenances[0]
    patch = prediction.get("model_patch")
    if not isinstance(patch, str) or not patch.strip():
        raise InvalidJob("Lari prediction patch is empty")
    patch_hash = sha256_bytes(patch.encode("utf-8"))
    if provenance.get("patch", {}).get("sha256") != patch_hash:
        raise InvalidJob("Prediction patch hash does not match Lari provenance")
    if provenance.get("model", {}).get("identity") != "Lari":
        raise InvalidJob("Prediction provenance does not identify Lari")
    if provenance.get("model", {}).get("canonicalRuntimePath") != CANONICAL_PATH:
        raise InvalidJob("Prediction was not produced through the canonical Lari path")
    if provenance.get("externalModelCalls") != 0 or provenance.get("executor", {}).get("externalModelCalls") != 0:
        raise InvalidJob("Prediction provenance reports external model calls")
    if provenance.get("repo") != repo or str(provenance.get("baseCommit", "")).lower() != base_commit:
        raise InvalidJob("Prediction provenance does not match the requested repository and commit")
    if not provenance.get("activeModelReadOnly") or not provenance.get("registryReadOnly"):
        raise InvalidJob("Prediction generation did not prove active model and registry read-only")
    selected = provenance.get("response", {}).get("capabilitySelection", {}).get("learnedRecordId")
    executed = provenance.get("response", {}).get("executedRecordIds", [])
    if not selected or selected not in executed:
        raise InvalidJob("Selected learned capability was not bound to executed record provenance")
    binding = provenance.get("response", {}).get("executionBinding", {})
    if provenance.get("response", {}).get("exactRunnerFailToPass") is not True or binding.get("verified") is not True:
        raise InvalidJob("Prediction provenance lacks an exact declared-runner failure-to-pass proof")

    commands = raw.get("commands", {})
    setup = [normalized_command(item, f"commands.setup[{index}]") for index, item in enumerate(commands.get("setup", []))]
    tests = [normalized_command(item, f"commands.tests[{index}]") for index, item in enumerate(commands.get("tests", []))]
    if not tests:
        raise InvalidJob("At least one exact test command is required")
    deployment = raw.get("deployment", {})
    image = str(deployment.get("image", "python:3.12-bookworm"))
    if not re.fullmatch(r"[A-Za-z0-9_./:@-]+", image) or MODEL_ENDPOINT.search(image):
        raise InvalidJob("deployment.image is invalid")

    return {
        "schemaVersion": 1,
        "jobPath": str(job_path),
        "jobSha256": sha256_file(job_path),
        "instance": {"instanceId": instance_id, "repo": repo, "baseCommit": base_commit},
        "lariArtifacts": {
            "predictionsPath": str(predictions_path),
            "predictionsSha256": sha256_file(predictions_path),
            "provenancePath": str(provenance_path),
            "provenanceSha256": sha256_file(provenance_path),
            "modelHash": provenance.get("model", {}).get("sha256"),
            "selectedLearnedRecordId": selected,
            "executedLearnedRecordIds": executed,
            "patchSha256": patch_hash,
            "patchBytes": len(patch.encode("utf-8")),
        },
        "patch": patch,
        "commands": {"setup": setup, "tests": tests},
        "deployment": {
            "image": image,
            "startupTimeout": int(deployment.get("startupTimeout", 180)),
            "runtimeTimeout": int(deployment.get("runtimeTimeout", 3600)),
            "deploymentTimeout": int(deployment.get("deploymentTimeout", 7200)),
            "installPipx": bool(deployment.get("installPipx", True)),
        },
        "contract": {
            "reasoner": "Lari",
            "transport": "SWE-ReX ModalDeployment",
            "externalModelCalls": 0,
            "patchAuthoredRemotely": False,
            "shellStringsAllowed": False,
            "credentialsEmbedded": False,
            "requiresBaselineFailureThenPass": True,
        },
    }


def result_dict(response: Any, command: dict[str, Any], phase: str) -> dict[str, Any]:
    stdout = str(getattr(response, "stdout", ""))
    stderr = str(getattr(response, "stderr", ""))
    return {
        "phase": phase,
        "command": command["command"],
        "cwd": command["cwd"],
        "timeoutSeconds": command["timeoutSeconds"],
        "exitCode": getattr(response, "exit_code", None),
        "stdout": stdout[:MAX_CAPTURE],
        "stderr": stderr[:MAX_CAPTURE],
        "stdoutSha256": sha256_bytes(stdout.encode("utf-8")),
        "stderrSha256": sha256_bytes(stderr.encode("utf-8")),
        "stdoutTruncated": len(stdout) > MAX_CAPTURE,
        "stderrTruncated": len(stderr) > MAX_CAPTURE,
    }


def validate_runner_job(job_path: Path) -> dict[str, Any]:
    """Validate an intermediate test-execution job.

    This path can execute workspace bytes authored by Lari, but it cannot infer,
    select a capability, or change those bytes.
    """
    raw = json.loads(job_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        raise InvalidJob("Runner job must be an object with schemaVersion 1")
    if embedded_secret_paths(raw):
        raise InvalidJob("Runner job embeds credential material")
    architecture = raw.get("architecture", {})
    if architecture.get("reasoner") != "Lari" or architecture.get("externalModelCalls") != 0:
        raise InvalidJob("Runner job must declare Lari as sole reasoner and zero external model calls")
    if architecture.get("canonicalRuntimePath") != CANONICAL_PATH or architecture.get("externalModelEndpoint") is not None:
        raise InvalidJob("Runner job is not bound to the canonical Lari path")
    instance = raw.get("instance", {})
    instance_id = str(instance.get("instanceId", ""))
    repo = str(instance.get("repo", ""))
    base_commit = str(instance.get("baseCommit", "")).lower()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+-\d+", instance_id):
        raise InvalidJob("Runner instanceId is invalid")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise InvalidJob("Runner repo is invalid")
    if not re.fullmatch(r"[0-9a-f]{40}", base_commit):
        raise InvalidJob("Runner baseCommit must be a full Git hash")
    expected_image = f"swebench/sweb.eval.x86_64.{instance_id.lower().replace('__', '_1776_')}:latest"
    image = str(raw.get("deployment", {}).get("image", ""))
    if image != expected_image:
        raise InvalidJob(f"Runner image must be the official pinned instance image {expected_image}")
    test = raw.get("test", {})
    test_path = str(test.get("path", "")).replace("\\", "/")
    if not test_path or test_path.startswith("/") or ".." in PurePosixPath(test_path).parts:
        raise InvalidJob("Runner test.path must stay inside /testbed")
    if test.get("runnerId") != "python.pytest":
        raise InvalidJob("Only the canonical python.pytest runner is accepted for this curriculum")
    test_content = test.get("content")
    patch = raw.get("patch", "")
    if not isinstance(test_content, str) or not isinstance(patch, str):
        raise InvalidJob("Runner test content and patch must be strings")
    if len(test_content.encode()) > 256 * 1024 or len(patch.encode()) > 2 * 1024 * 1024:
        raise InvalidJob("Runner payload exceeds the bounded tool-execution limit")
    if MODEL_ENDPOINT.search(test_content) or MODEL_ENDPOINT.search(patch):
        raise InvalidJob("Runner payload references an external model runtime")
    return {
        "schemaVersion": 1,
        "jobSha256": sha256_file(job_path),
        "instance": {"instanceId": instance_id, "repo": repo, "baseCommit": base_commit},
        "deployment": {"image": image, "timeout": int(raw.get("deployment", {}).get("timeout", 1200))},
        "test": {"path": test_path, "runnerId": "python.pytest", "fingerprint": test.get("fingerprint"), "content": test_content},
        "patch": patch,
        "patchSha256": sha256_bytes(patch.encode()),
    }


async def execute_modal_direct_runner(validated: dict[str, Any]) -> dict[str, Any]:
    """Run one exact Lari repair-loop test through Modal's direct command channel."""
    try:
        import modal
    except ImportError as error:
        raise RuntimeError("Install Modal with: python -m pip install modal") from error
    app = await modal.App.lookup.aio("lari-swebench-tool", create_if_missing=True)
    image = modal.Image.from_registry(validated["deployment"]["image"])
    sandbox = await modal.Sandbox.create.aio(
        image=image,
        app=app,
        timeout=validated["deployment"]["timeout"],
        cpu=2,
    )
    observations: list[dict[str, Any]] = []

    async def run(command: list[str], phase: str, timeout: int = 600) -> dict[str, Any]:
        process = await sandbox.exec.aio(*command, workdir="/testbed", timeout=timeout)
        stdout, stderr = await asyncio.gather(process.stdout.read.aio(), process.stderr.read.aio())
        exit_code = await process.wait.aio()
        observation = {
            "phase": phase,
            "command": command,
            "cwd": "/testbed",
            "timeoutSeconds": timeout,
            "exitCode": exit_code,
            "stdout": str(stdout)[:MAX_CAPTURE],
            "stderr": str(stderr)[:MAX_CAPTURE],
            "stdoutSha256": sha256_bytes(str(stdout).encode()),
            "stderrSha256": sha256_bytes(str(stderr).encode()),
        }
        observations.append(observation)
        return observation

    async def write_remote(relative: str, content: str, phase: str) -> None:
        encoded = base64.b64encode(content.encode()).decode()
        writer = [
            "python", "-c",
            "import base64,pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(base64.b64decode(sys.argv[2]))",
            relative, encoded,
        ]
        result = await run(writer, phase, 120)
        if result["exitCode"] != 0:
            raise RuntimeError(f"Remote {phase} failed")

    try:
        checkout = await run(["git", "checkout", "--detach", "--force", validated["instance"]["baseCommit"]], "checkout_pin", 300)
        if checkout["exitCode"] != 0:
            raise RuntimeError("Official image cannot check out the selected base commit")
        # Keep the official image's ignored compiled environment artifacts; only
        # remove untracked source/test debris from an interrupted prior command.
        await run(["git", "clean", "-fd"], "workspace_clean", 180)
        head = await run(["git", "rev-parse", "HEAD"], "checkout_verify", 60)
        if head["stdout"].strip().lower() != validated["instance"]["baseCommit"]:
            raise RuntimeError("Official image checkout does not match the selected base commit")
        if validated["patch"]:
            await write_remote("/tmp/lari-current.patch", validated["patch"], "patch_write")
            check = await run(["git", "apply", "--check", "/tmp/lari-current.patch"], "patch_apply_check", 120)
            if check["exitCode"] != 0:
                detail = (check.get("stderr") or check.get("stdout") or "unknown apply failure").strip()
                raise RuntimeError(f"Current Lari workspace patch does not apply to the pinned image: {detail[:4000]}")
            applied = await run(["git", "apply", "/tmp/lari-current.patch"], "patch_apply", 120)
            if applied["exitCode"] != 0:
                raise RuntimeError("Current Lari workspace patch failed to apply")
        await write_remote(validated["test"]["path"], validated["test"]["content"], "public_test_write")
        test = await run([
            "/opt/miniconda3/envs/testbed/bin/python", "-m", "pytest", "-q", "--maxfail=1", "--disable-warnings", "--tb=short", validated["test"]["path"]
        ], "declared_test", 900)
        return {
            "passed": test["exitCode"] == 0,
            "output": test["stdout"],
            "error": test["stderr"] or (None if test["exitCode"] == 0 else test["stdout"]),
            "runnerAllowed": True,
            "executionBackend": "modal_direct_official_swebench_image",
            "externalModelCalls": 0,
            "evidenceHash": sha256_bytes(json.dumps(observations, sort_keys=True).encode()),
            "patchSha256": validated["patchSha256"],
            "observations": observations,
        }
    finally:
        await sandbox.terminate.aio(wait=True)


async def execute_modal(validated: dict[str, Any]) -> dict[str, Any]:
    try:
        from swerex.deployment.modal import ModalDeployment
        from swerex.runtime.abstract import Command
        try:
            from swerex.runtime.abstract import WriteFileRequest
        except ImportError:
            from swerex.runtime.data import WriteFileRequest
    except ImportError as error:
        raise RuntimeError("Install the tool transport with: python -m pip install 'swe-rex[modal]==1.4.0'") from error

    has_environment_credentials = bool(os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET"))
    has_profile_credentials = False
    if not has_environment_credentials:
        try:
            from modal.config import Config

            modal_config = Config()
            has_profile_credentials = bool(modal_config.get("token_id") and modal_config.get("token_secret"))
        except Exception:
            has_profile_credentials = False
    if not has_environment_credentials and not has_profile_credentials:
        raise RuntimeError(
            "Modal credentials are not configured; authenticate a Modal profile or set "
            "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET outside the job file"
        )

    deployment_config = validated["deployment"]
    deployment = ModalDeployment(
        image=deployment_config["image"],
        startup_timeout=deployment_config["startupTimeout"],
        runtime_timeout=deployment_config["runtimeTimeout"],
        deployment_timeout=deployment_config["deploymentTimeout"],
        install_pipx=deployment_config["installPipx"],
    )
    observations: list[dict[str, Any]] = []
    repo_dir = "/workspace/repo"
    remote_cwd = lambda relative: repo_dir if relative in ("", ".", "./") else f"{repo_dir}/{relative[2:] if relative.startswith('./') else relative}"

    async def run(command: list[str], phase: str, cwd: str = "/workspace", timeout: int = 900, env: dict[str, str] | None = None) -> dict[str, Any]:
        spec = {"command": command, "cwd": cwd, "timeoutSeconds": timeout, "env": env or {}}
        response = await deployment.runtime.execute(Command(command=command, cwd=cwd, timeout=timeout, env=env or None, check=False))
        observation = result_dict(response, spec, phase)
        observations.append(observation)
        return observation

    started = False
    try:
        await deployment.start()
        started = True
        alive = await deployment.is_alive(timeout=30)
        if not bool(alive):
            raise RuntimeError("SWE-ReX Modal runtime did not become alive")
        version = await run(["git", "--version"], "executor_probe", cwd="/", timeout=60)
        if version["exitCode"] != 0:
            raise RuntimeError("Selected Modal image does not contain git")
        await run(["mkdir", "-p", "/workspace"], "workspace_create", cwd="/", timeout=60)
        clone = await run(
            ["git", "clone", "--no-checkout", f"https://github.com/{validated['instance']['repo']}.git", repo_dir],
            "checkout_clone",
            timeout=1800,
        )
        if clone["exitCode"] != 0:
            raise RuntimeError("Pinned repository clone failed")
        checkout = await run(["git", "checkout", "--detach", validated["instance"]["baseCommit"]], "checkout_pin", cwd=repo_dir, timeout=600)
        if checkout["exitCode"] != 0:
            raise RuntimeError("Pinned commit checkout failed")
        head = await run(["git", "rev-parse", "HEAD"], "checkout_verify", cwd=repo_dir, timeout=60)
        if head["exitCode"] != 0 or head["stdout"].strip().lower() != validated["instance"]["baseCommit"]:
            raise RuntimeError("Remote checkout does not match baseCommit exactly")

        for command in validated["commands"]["setup"]:
            observation = await run(command["command"], "setup", cwd=remote_cwd(command["cwd"]), timeout=command["timeoutSeconds"], env=command["env"])
            if observation["exitCode"] != 0:
                detail = (observation.get("stderr") or observation.get("stdout") or "no command output").strip()
                raise RuntimeError(
                    f"Declared setup command {json.dumps(command['command'])} failed "
                    f"(exit {observation['exitCode']}): {detail[:4000]}"
                )

        baseline = []
        for command in validated["commands"]["tests"]:
            baseline.append(await run(command["command"], "baseline_test", cwd=remote_cwd(command["cwd"]), timeout=command["timeoutSeconds"], env=command["env"]))
        if all(item["exitCode"] == 0 for item in baseline):
            raise RuntimeError("Declared baseline tests did not reproduce a failure; repair cannot be verified")

        await deployment.runtime.write_file(WriteFileRequest(path="/tmp/lari.patch", content=validated["patch"]))
        remote_patch_hash = await run(["sha256sum", "/tmp/lari.patch"], "patch_hash", cwd="/tmp", timeout=60)
        if remote_patch_hash["exitCode"] != 0 or remote_patch_hash["stdout"].split()[0] != validated["lariArtifacts"]["patchSha256"]:
            raise RuntimeError("Remote patch bytes do not match the Lari-authored patch")
        apply_check = await run(["git", "apply", "--check", "/tmp/lari.patch"], "patch_apply_check", cwd=repo_dir, timeout=120)
        if apply_check["exitCode"] != 0:
            raise RuntimeError("Lari-authored patch cannot be applied to the pinned commit")
        applied = await run(["git", "apply", "/tmp/lari.patch"], "patch_apply", cwd=repo_dir, timeout=120)
        if applied["exitCode"] != 0:
            raise RuntimeError("Lari-authored patch application failed")
        diff_check = await run(["git", "diff", "--check"], "patch_diff_check", cwd=repo_dir, timeout=120)
        if diff_check["exitCode"] != 0:
            raise RuntimeError("Applied patch fails git diff --check")

        after = []
        for command in validated["commands"]["tests"]:
            after.append(await run(command["command"], "after_test", cwd=remote_cwd(command["cwd"]), timeout=command["timeoutSeconds"], env=command["env"]))
        if not after or any(item["exitCode"] != 0 for item in after):
            raise RuntimeError("Declared tests did not all pass after applying the patch")
        final_head = await run(["git", "rev-parse", "HEAD"], "final_head", cwd=repo_dir, timeout=60)
        if final_head["stdout"].strip().lower() != validated["instance"]["baseCommit"]:
            raise RuntimeError("Remote executor changed repository history")
        return {
            "passed": True,
            "baselineFailureReproduced": any(item["exitCode"] != 0 for item in baseline),
            "allAfterTestsPassed": all(item["exitCode"] == 0 for item in after),
            "remotePatchHashMatched": True,
            "pinnedCommitRetained": True,
            "observations": observations,
        }
    finally:
        if started:
            await deployment.stop()


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def self_test() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="lari-swerex-validate-", dir=ROOT / "benchmarks") as raw_root:
        root = Path(raw_root)
        predictions = root / "predictions.jsonl"
        provenance = root / "provenance.jsonl"
        patch = "diff --git a/a.txt b/a.txt\nindex 7898192..6178079 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n"
        patch_hash = sha256_bytes(patch.encode())
        instance_id = "owner__repo-1"
        commit = "1" * 40
        predictions.write_text(json.dumps({"instance_id": instance_id, "model_name_or_path": "lari-local-html-swarm", "model_patch": patch}) + "\n", encoding="utf-8")
        provenance.write_text(json.dumps({
            "instanceId": instance_id,
            "repo": "owner/repo",
            "baseCommit": commit,
            "model": {"identity": "Lari", "sha256": "2" * 64, "canonicalRuntimePath": CANONICAL_PATH},
            "executor": {"externalModelCalls": 0},
            "response": {
                "capabilitySelection": {"learnedRecordId": "lari.learned.repair.test"},
                "executedRecordIds": ["lari.learned.repair.test"],
                "exactRunnerFailToPass": True,
                "executionBinding": {"verified": True},
            },
            "patch": {"sha256": patch_hash},
            "activeModelReadOnly": True,
            "registryReadOnly": True,
            "externalModelCalls": 0,
        }) + "\n", encoding="utf-8")
        job = {
            "schemaVersion": 1,
            "architecture": {"reasoner": "Lari", "canonicalRuntimePath": CANONICAL_PATH, "externalModelEndpoint": None, "externalModelCalls": 0},
            "instance": {"instanceId": instance_id, "repo": "owner/repo", "baseCommit": commit},
            "lariArtifacts": {"predictionsPath": predictions.name, "provenancePath": provenance.name},
            "commands": {"tests": [{"command": ["python", "-m", "pytest", "tests/test_case.py"], "cwd": ".", "timeoutSeconds": 300}]},
            "deployment": {"image": "python:3.12-bookworm"},
        }
        job_path = root / "job.json"
        job_path.write_text(json.dumps(job, indent=2) + "\n", encoding="utf-8")
        valid = validate_job(job_path)
        negative: dict[str, bool] = {}
        mutations = {
            "rejects_external_model": lambda value: value["commands"]["tests"][0].update({"command": ["curl", "https://api.openai.com/v1/chat/completions"]}),
            "rejects_shell_string": lambda value: value["commands"]["tests"][0].update({"command": "pytest"}),
            "rejects_credentials": lambda value: value["commands"]["tests"][0].update({"env": {"API_TOKEN": "secret"}}),
            "rejects_unbound_commit": lambda value: value["instance"].update({"baseCommit": "3" * 40}),
        }
        for name, mutate in mutations.items():
            changed = json.loads(json.dumps(job))
            mutate(changed)
            mutated_path = root / f"{name}.json"
            mutated_path.write_text(json.dumps(changed), encoding="utf-8")
            try:
                validate_job(mutated_path)
                negative[name] = False
            except InvalidJob:
                negative[name] = True
        proof = {
            "validLariBoundJobAccepted": valid["lariArtifacts"]["patchSha256"] == patch_hash,
            "exactRunnerRetained": valid["commands"]["tests"][0]["command"] == ["python", "-m", "pytest", "tests/test_case.py"],
            "requiresFailureThenPass": valid["contract"]["requiresBaselineFailureThenPass"] is True,
            "doesNotImportSwerexDuringValidation": "swerex" not in sys.modules,
            "zeroExternalModelCalls": valid["contract"]["externalModelCalls"] == 0,
            **negative,
        }
        return {"schemaVersion": 1, "test": "lari-swerex-modal-tool-transport", "passed": all(proof.values()), "remoteExecuted": False, "proof": proof}


def main() -> int:
    parser = argparse.ArgumentParser(description="Tool-only SWE-ReX Modal transport for Lari-authored patches")
    parser.add_argument("--job", type=Path)
    parser.add_argument("--runner-job", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.self_test:
        report = self_test()
        default_report = ROOT / "benchmarks" / "latest-lari-swerex-modal-transport-self-test.json"
        write_report(args.report.resolve() if args.report else default_report, report)
        print(json.dumps(report, indent=2))
        return 0 if report["passed"] else 1
    if args.runner_job:
        if args.job or not args.report or args.validate_only or args.execute:
            parser.error("--runner-job requires --report and cannot be combined with patch transport flags")
        before = {"active": sha256_file(ACTIVE_MODEL), "registry": sha256_file(REGISTRY)}
        validated_runner = validate_runner_job(args.runner_job.resolve())
        execution = asyncio.run(execute_modal_direct_runner(validated_runner))
        after = {"active": sha256_file(ACTIVE_MODEL), "registry": sha256_file(REGISTRY)}
        result = {
            "schemaVersion": 1,
            "passed": execution["passed"],
            "mode": "direct-runner",
            "remoteExecuted": True,
            "validated": {key: value for key, value in validated_runner.items() if key not in {"patch", "test"}},
            "execution": execution,
            "integrity": {
                "activeBefore": before["active"], "activeAfter": after["active"],
                "registryBefore": before["registry"], "registryAfter": after["registry"],
                "activeModelReadOnly": before["active"] == after["active"],
                "registryReadOnly": before["registry"] == after["registry"],
                "externalModelCalls": 0,
            },
        }
        result["passed"] = result["passed"] and result["integrity"]["activeModelReadOnly"] and result["integrity"]["registryReadOnly"]
        write_report(args.report.resolve(), result)
        print(json.dumps(result, indent=2))
        return 0 if result["passed"] else 1
    if not args.job or args.validate_only == args.execute:
        parser.error("provide --job and exactly one of --validate-only or --execute")
    job_path = args.job.resolve()
    before = {"active": sha256_file(ACTIVE_MODEL), "registry": sha256_file(REGISTRY)}
    validated = validate_job(job_path)
    public = {key: value for key, value in validated.items() if key != "patch"}
    if args.validate_only:
        result = {"schemaVersion": 1, "passed": True, "mode": "validate-only", "remoteExecuted": False, "validated": public}
    else:
        if not args.report:
            parser.error("--execute requires --report")
        execution = asyncio.run(execute_modal(validated))
        result = {"schemaVersion": 1, "passed": execution["passed"], "mode": "execute", "remoteExecuted": True, "validated": public, "execution": execution}
    after = {"active": sha256_file(ACTIVE_MODEL), "registry": sha256_file(REGISTRY)}
    result["integrity"] = {
        "activeBefore": before["active"], "activeAfter": after["active"],
        "registryBefore": before["registry"], "registryAfter": after["registry"],
        "activeModelReadOnly": before["active"] == after["active"],
        "registryReadOnly": before["registry"] == after["registry"],
        "externalModelCalls": 0,
    }
    result["passed"] = result["passed"] and result["integrity"]["activeModelReadOnly"] and result["integrity"]["registryReadOnly"]
    if args.report:
        write_report(args.report.resolve(), result)
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InvalidJob, json.JSONDecodeError, OSError, RuntimeError) as error:
        print(json.dumps({"passed": False, "error": str(error), "externalModelCalls": 0}, indent=2), file=sys.stderr)
        raise SystemExit(1)
