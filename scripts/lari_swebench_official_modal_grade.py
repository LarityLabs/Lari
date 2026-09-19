#!/usr/bin/env python3
"""Grade existing Lari patches with the official SWE-bench script in Modal.

This module is an execution-only harness. It never generates or alters a patch,
and it does not call a language model.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import tempfile
import types
from pathlib import Path


def _allow_swebench_import_on_windows() -> None:
    if "resource" in sys.modules:
        return
    resource = types.ModuleType("resource")
    resource.RLIMIT_NOFILE = 7
    resource.getrlimit = lambda _key: (2048, 2048)
    resource.setrlimit = lambda _key, _value: None
    sys.modules["resource"] = resource


async def _write(process_owner, path: str, content: str) -> None:
    encoded = base64.b64encode(content.encode()).decode()
    process = await process_owner.exec.aio(
        "python",
        "-c",
        "import base64,pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(sys.argv[2]))",
        path,
        encoded,
        workdir="/testbed",
        timeout=120,
    )
    await process.wait.aio()


async def grade(prediction_path: Path) -> dict:
    _allow_swebench_import_on_windows()
    import modal
    from datasets import load_dataset
    from swebench.harness.grading import get_eval_report
    from swebench.harness.test_spec.test_spec import make_test_spec

    prediction = json.loads(prediction_path.read_text(encoding="utf-8").splitlines()[0])
    instance_id = prediction["instance_id"]
    dataset = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
    instance = next(dict(row) for row in dataset if row["instance_id"] == instance_id)
    spec = make_test_spec(instance, namespace="swebench")
    image_name = f"swebench/sweb.eval.x86_64.{instance_id.lower().replace('__', '_1776_')}:latest"
    app = await modal.App.lookup.aio("lari-swebench-tool", create_if_missing=True)
    sandbox = await modal.Sandbox.create.aio(
        image=modal.Image.from_registry(image_name), app=app, timeout=1800, cpu=2
    )
    try:
        async def run(*command: str, timeout: int = 1200):
            process = await sandbox.exec.aio(*command, workdir="/testbed", timeout=timeout)
            stdout, stderr = await asyncio.gather(process.stdout.read.aio(), process.stderr.read.aio())
            code = await process.wait.aio()
            return int(code), str(stdout), str(stderr)

        code, _, err = await run("git", "checkout", "--detach", "--force", instance["base_commit"], timeout=300)
        if code:
            raise RuntimeError(f"checkout failed: {err[-2000:]}")
        await run("git", "clean", "-fd", timeout=180)
        patch = prediction.get("model_patch") or ""
        if patch:
            await _write(sandbox, "/tmp/lari.patch", patch)
            code, out, err = await run("git", "apply", "--check", "/tmp/lari.patch", timeout=120)
            if code:
                raise RuntimeError(f"patch check failed: {(err or out)[-2000:]}")
            code, out, err = await run("git", "apply", "/tmp/lari.patch", timeout=120)
            if code:
                raise RuntimeError(f"patch apply failed: {(err or out)[-2000:]}")
        await _write(sandbox, "/tmp/lari-eval.sh", spec.eval_script)
        code, stdout, stderr = await run("bash", "/tmp/lari-eval.sh", timeout=1500)
        log_text = stdout + "\n" + stderr
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            handle.write(log_text)
            log_path = handle.name
        report = get_eval_report(spec, prediction, log_path, include_tests_status=True)[instance_id]
        tests = report.get("tests_status", {})
        f2p = tests.get("FAIL_TO_PASS", {})
        p2p = tests.get("PASS_TO_PASS", {})
        return {
            "instanceId": instance_id,
            "resolved": bool(report.get("resolved")),
            "patchApplied": bool(report.get("patch_successfully_applied")),
            "evalExitCode": code,
            "failToPass": {"success": len(f2p.get("success", [])), "failure": len(f2p.get("failure", []))},
            "passToPass": {"success": len(p2p.get("success", [])), "failure": len(p2p.get("failure", []))},
            "failedTests": list(f2p.get("failure", [])) + list(p2p.get("failure", [])),
            "externalModelCalls": 0,
            "image": image_name,
        }
    finally:
        await sandbox.terminate.aio(wait=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("predictions", nargs="+", type=Path)
    args = parser.parse_args()
    async def run_all():
        return await asyncio.gather(*(grade(prediction.resolve()) for prediction in args.predictions))

    for result in asyncio.run(run_all()):
        print("FINAL_SUMMARY=" + json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
