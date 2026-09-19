from __future__ import annotations

import argparse
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from lari_lm_eval_adapter import LariModelAdapter


class LariThreadingHTTPServer(ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


class LariOpenAIHandler(BaseHTTPRequestHandler):
    adapter: LariModelAdapter
    api_key: str | None = None
    allowed_origins = {"http://127.0.0.1:8000", "http://localhost:8000"}
    max_request_bytes = 2 * 1024 * 1024

    @staticmethod
    def _diagnostics_requested(payload: dict[str, Any], lari_context: dict[str, Any]) -> bool:
        """Diagnostics are a Lari extension and must be explicitly requested."""
        return any(value is True for value in (
            payload.get("include_diagnostics"),
            payload.get("includeDiagnostics"),
            lari_context.get("includeDiagnostics"),
            lari_context.get("include_diagnostics"),
        ))

    @staticmethod
    def _runtime_context(lari_context: dict[str, Any]) -> dict[str, Any]:
        """Do not turn a response-format option into model input."""
        return {
            key: value
            for key, value in lari_context.items()
            if key not in {"includeDiagnostics", "include_diagnostics"}
        }

    @staticmethod
    def _public_api_response(payload: dict[str, Any], include_diagnostics: bool) -> dict[str, Any]:
        if include_diagnostics:
            return payload
        standard_fields = {
            "id", "object", "created", "model", "choices", "usage",
            "system_fingerprint", "service_tier",
        }
        return {key: value for key, value in payload.items() if key in standard_fields}

    @staticmethod
    def _with_user_scope(payload: dict[str, Any], lari_context: dict[str, Any]) -> dict[str, Any]:
        """Map the OpenAI `user` field onto Lari's existing scoped model context."""
        context = dict(lari_context)
        context["userScope"] = (
            context.get("userScope")
            or context.get("user_scope")
            or context.get("userId")
            or payload.get("user")
            or "local.default"
        )
        return context

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        origin = self.headers.get("Origin")
        if origin in self.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not self.api_key:
            return True
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {self.api_key}"
        return hmac.compare_digest(supplied, expected)

    @staticmethod
    def _normalize_messages(messages: Any) -> list[dict[str, str]]:
        def unwrap_chat_template_string(content: Any) -> list[dict[str, str]] | None:
            if not isinstance(content, str):
                return None
            text = content.strip()
            if not (text.startswith("[") and '"role"' in text and '"content"' in text):
                return None
            try:
                parsed = json.loads(text)
            except Exception:
                return None
            if not isinstance(parsed, list):
                return None
            unwrapped: list[dict[str, str]] = []
            for item in parsed:
                if not isinstance(item, dict):
                    return None
                role = str(item.get("role") or "user")
                value = item.get("content")
                if isinstance(value, list):
                    value = "\n".join(str(part.get("text", part)) if isinstance(part, dict) else str(part) for part in value)
                unwrapped.append({"role": role, "content": str(value or "")})
            return unwrapped or None

        if not isinstance(messages, list):
            unwrapped = unwrap_chat_template_string(messages)
            if unwrapped:
                return unwrapped
            return [{"role": "user", "content": str(messages or "")}]
        normalized: list[dict[str, str]] = []
        for message in messages:
            if isinstance(message, dict):
                role = str(message.get("role") or "user")
                content = message.get("content")
                if isinstance(content, list):
                    content = "\n".join(str(part.get("text", part)) if isinstance(part, dict) else str(part) for part in content)
                unwrapped = unwrap_chat_template_string(content)
                if unwrapped:
                    normalized.extend(unwrapped)
                    continue
                normalized.append({"role": role, "content": str(content or "")})
            else:
                unwrapped = unwrap_chat_template_string(message)
                if unwrapped:
                    normalized.extend(unwrapped)
                else:
                    normalized.append({"role": "user", "content": str(message or "")})
        return normalized or [{"role": "user", "content": ""}]

    def do_OPTIONS(self) -> None:
        self._json(200, {"ok": True})

    def do_GET(self) -> None:
        if not self._authorized():
            self._json(401, {"error": "Unauthorized"})
            return
        if self.path == "/v1/models":
            self._json(200, {
                "object": "list",
                "data": [{"id": self.adapter.model_name, "object": "model", "owned_by": "local"}],
            })
        elif self.path in {"/health", "/"}:
            self._json(200, {"ok": True, "model": self.adapter.model_name, "external_model_calls": 0})
        else:
            self._json(404, {"error": f"Unknown endpoint {self.path}"})

    def do_POST(self) -> None:
        include_diagnostics = False
        try:
            if not self._authorized():
                self._json(401, {"error": "Unauthorized"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > self.max_request_bytes:
                self._json(413, {"error": "Request body is too large"})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            raw_lari_context = payload.get("lari_context") if isinstance(payload.get("lari_context"), dict) else {}
            include_diagnostics = self._diagnostics_requested(payload, raw_lari_context)
            lari_context = self._with_user_scope(payload, self._runtime_context(raw_lari_context))
            if self.path == "/v1/chat/completions":
                messages = self._normalize_messages(payload.get("messages") or [{"role": "user", "content": payload.get("prompt", "")}])
                completion = self.adapter.chat_completion(messages, **lari_context)
                self._json(200, self._public_api_response(completion, include_diagnostics))
                return
            if self.path == "/v1/completions":
                prompt = payload.get("prompt", "")
                if isinstance(prompt, list):
                    prompt = "\n".join(str(item) for item in prompt)
                generation = self.adapter.generate(str(prompt), **lari_context)
                text = generation.text
                raw = generation.raw
                completion = {
                    "id": f"cmpl-lari-{raw.get('response', {}).get('id', 'local')}",
                    "object": "text_completion",
                    "model": self.adapter.model_name,
                    "choices": [{"text": text, "index": 0, "finish_reason": "stop"}],
                    "usage": raw.get("chat_completion", {}).get("usage", {}),
                    "lari": raw.get("chat_completion", {}).get("lari", {}),
                    "external_model_calls": 0,
                }
                self._json(200, self._public_api_response(completion, include_diagnostics))
                return
            self._json(404, {"error": f"Unknown endpoint {self.path}"})
        except Exception as error:
            failure: dict[str, Any] = {"error": "Lari could not process this request."}
            if include_diagnostics:
                failure["lari"] = {"adapter_error": str(error)}
                failure["external_model_calls"] = 0
            self._json(500, failure)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Lari through a local OpenAI-compatible API.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model-path", default=None)
    parser.add_argument("--model", default="lari")
    parser.add_argument("--state-path", default=os.environ.get("LARI_RUNTIME_STATE_PATH"))
    parser.add_argument("--stateless", action="store_true", help="Use one isolated model process per request.")
    args = parser.parse_args()

    LariOpenAIHandler.adapter = LariModelAdapter(
        model_path=args.model_path,
        model_name=args.model,
        save_model=False,
        persistent=not args.stateless,
        state_path=args.state_path,
    )
    LariOpenAIHandler.api_key = os.environ.get("LARI_API_KEY") or None
    server = LariThreadingHTTPServer((args.host, args.port), LariOpenAIHandler)
    print(f"Lari OpenAI-compatible server listening on http://{args.host}:{args.port}")
    print(f"Model path: {args.model_path or 'registry-resolved'}")
    try:
        server.serve_forever()
    finally:
        LariOpenAIHandler.adapter.close()


if __name__ == "__main__":
    main()
