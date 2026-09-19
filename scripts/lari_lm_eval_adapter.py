"""Lari public benchmark adapter.

This module intentionally keeps the contract boring:

    prompt/messages -> Lari local runtime -> assistant text

It can be used directly from Python, wrapped by a public harness, or served
through scripts/lari_openai_server.py for OpenAI-compatible benchmark clients.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CLI = ROOT / "scripts" / "lari_model_cli.js"


@dataclass
class LariGeneration:
    text: str
    raw: dict[str, Any]


class LariModelAdapter:
    """Small dependency-free adapter for public benchmark harnesses.

    The adapter supports text generation today. Multiple-choice benchmarks that
    require token log-likelihood need a scoring shim or a generation-based task
    prompt, because Lari is not a transformer exposing token probabilities.
    """

    def __init__(
        self,
        model_path: str | os.PathLike[str] | None = None,
        node: str = "node",
        cli_path: str | os.PathLike[str] = DEFAULT_CLI,
        model_name: str = "lari",
        timeout: int = 60,
        save_model: bool = False,
        persistent: bool = False,
        state_path: str | os.PathLike[str] | None = None,
    ) -> None:
        self.model_path = str(model_path) if model_path else None
        self.node = node
        self.cli_path = str(cli_path)
        self.model_name = model_name
        self.timeout = timeout
        self.save_model = save_model
        self.persistent = persistent
        self.state_path = str(state_path) if state_path else None
        self._worker: subprocess.Popen[str] | None = None
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: dict[str, queue.Queue[dict[str, Any]]] = {}

    def _ensure_worker(self) -> None:
        if self._worker is not None and self._worker.poll() is None:
            return
        command = [self.node, str(ROOT / "scripts" / "lari_persistent_runtime_worker.js")]
        if self.model_path:
            command.extend(["--model-path", self.model_path])
        if self.state_path:
            command.extend(["--state-path", self.state_path])
        self._worker = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(ROOT),
            bufsize=1,
        )
        threading.Thread(target=self._read_worker, daemon=True).start()

    def _read_worker(self) -> None:
        worker = self._worker
        if worker is None or worker.stdout is None:
            return
        for line in worker.stdout:
            try:
                response = json.loads(line)
            except Exception:
                continue
            request_id = str(response.get("request_id") or "")
            with self._pending_lock:
                target = self._pending.get(request_id)
            if target is not None:
                target.put(response)

    def _persistent_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._ensure_worker()
        request_id = uuid.uuid4().hex
        response_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = response_queue
        try:
            worker = self._worker
            if worker is None or worker.stdin is None or worker.poll() is not None:
                raise RuntimeError("Lari persistent runtime worker is unavailable")
            request = {**payload, "request_id": request_id}
            with self._write_lock:
                worker.stdin.write(json.dumps(request) + "\n")
                worker.stdin.flush()
            deadline = time.monotonic() + self.timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise queue.Empty
                try:
                    response = response_queue.get(timeout=min(0.25, remaining))
                    break
                except queue.Empty:
                    if worker.poll() is not None:
                        raise RuntimeError(
                            f"Lari persistent runtime worker exited with code {worker.returncode}"
                        )
            if response.get("error"):
                raise RuntimeError(str(response["error"]))
            return response["result"]
        except queue.Empty as error:
            raise RuntimeError("Lari persistent runtime request timed out") from error
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

    def close(self) -> None:
        worker = self._worker
        self._worker = None
        if worker is None:
            return
        try:
            if worker.stdin:
                worker.stdin.close()
            worker.terminate()
            worker.wait(timeout=5)
        except Exception:
            worker.kill()

    def health(self) -> dict[str, Any]:
        if not self.persistent:
            return {"ok": True, "persistent": False}
        return self._persistent_request({"operation": "health"})

    def health(self) -> dict[str, Any]:
        if not self.persistent:
            return {"ok": True, "persistent": False}
        return self._persistent_request({"operation": "health"})

    def generate(self, prompt: str, **context: Any) -> LariGeneration:
        payload: dict[str, Any] = {
            "model": self.model_name,
            "prompt": prompt,
            "model_path": self.model_path,
            "save_model": self.save_model,
            "adapter_mode": "direct",
            "context": context,
        }
        if self.persistent:
            raw = self._persistent_request(payload)
            return LariGeneration(text=raw.get("output_text", ""), raw=raw)
        completed = subprocess.run(
            [self.node, self.cli_path],
            input=json.dumps(payload),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            cwd=str(ROOT),
            timeout=self.timeout,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"Lari adapter failed with code {completed.returncode}:\n"
                f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
            )
        raw = json.loads(completed.stdout)
        return LariGeneration(text=raw.get("output_text", ""), raw=raw)

    def chat_completion(self, messages: list[dict[str, str]], **context: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model_name,
            "messages": messages,
            "model_path": self.model_path,
            "save_model": self.save_model,
            "adapter_mode": "direct",
            "context": context,
        }
        if self.persistent:
            return self._persistent_request(payload)["chat_completion"]
        completed = subprocess.run(
            [self.node, self.cli_path],
            input=json.dumps(payload),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            cwd=str(ROOT),
            timeout=self.timeout,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr or completed.stdout)
        return json.loads(completed.stdout)["chat_completion"]

    def generate_until(self, requests: Iterable[Any]) -> list[str]:
        """Compatibility helper shaped like lm-eval generation calls.

        Each request may be a prompt string, a `(prompt, until)` tuple, or an
        object with `.args` where the first arg is the prompt. Stop strings are
        applied after generation because Lari returns full assistant text.
        """
        outputs: list[str] = []
        for request in requests:
            prompt, until = self._unpack_generate_request(request)
            text = self.generate(prompt).text
            for stop in until:
                if stop and stop in text:
                    text = text.split(stop, 1)[0]
            outputs.append(text)
        return outputs

    def loglikelihood(self, requests: Iterable[Any]) -> list[tuple[float, bool]]:
        """Generation-only placeholder for harnesses that probe this method.

        Public multiple-choice benchmarks usually rely on token likelihoods.
        Lari does not expose token probabilities, so this returns a neutral
        score and marks exact greedy scoring unavailable. Use generation-based
        task configs first, then add a Lari-specific choice scorer later.
        """
        return [(0.0, False) for _ in requests]

    @staticmethod
    def _unpack_generate_request(request: Any) -> tuple[str, list[str]]:
        if isinstance(request, str):
            return request, []
        if isinstance(request, tuple):
            prompt = str(request[0])
            until = request[1] if len(request) > 1 else []
            if isinstance(until, str):
                until = [until]
            if isinstance(until, dict):
                until = until.get("until", [])
            return prompt, list(until or [])
        args = getattr(request, "args", None)
        if args:
            prompt = str(args[0])
            until = args[1] if len(args) > 1 else []
            if isinstance(until, dict):
                until = until.get("until", [])
            if isinstance(until, str):
                until = [until]
            return prompt, list(until or [])
        return str(request), []


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run one prompt through the Lari public model adapter.")
    parser.add_argument("prompt", nargs="?", default="What are you?")
    parser.add_argument("--model-path", default=None)
    parser.add_argument("--required-concepts", nargs="*", default=[])
    parser.add_argument("--min-words", type=int, default=None)
    parser.add_argument("--threshold", type=float, default=None)
    parser.add_argument("--user", default=os.environ.get("LARI_USER_SCOPE") or os.environ.get("LARI_USER") or "local.default")
    parser.add_argument("--save-model", action="store_true", help="Explicitly persist the supplied disposable model path.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    adapter = LariModelAdapter(model_path=args.model_path, save_model=args.save_model)
    context: dict[str, Any] = {"userScope": args.user}
    if args.required_concepts:
        context["requiredConcepts"] = args.required_concepts
    if args.min_words is not None:
        context["minWords"] = args.min_words
    if args.threshold is not None:
        context["threshold"] = args.threshold
    generation = adapter.generate(args.prompt, **context)
    if args.json:
        print(json.dumps(generation.raw, indent=2))
    else:
        print(generation.text)


if __name__ == "__main__":
    main()
