"""Resident verifier for mutation repair.

Why this exists
---------------
Every candidate patch was costing a cold `pytest` invocation: roughly seven seconds, almost all of it
process startup, plugin discovery, and importing the package under test before a single assertion ran.
At that price a repair search takes half an hour per defect, which makes a continuous learning
curriculum impossible -- the loop can only ever run as a benchmark, never as a habit.

This keeps one process alive. pytest and the test modules are imported once; each request writes the
candidate source, invalidates only the modules belonging to the package under repair, and re-runs the
targeted tests in-process. Measured ceiling for reload-and-call on wcwidth is about 150ms against
7000ms cold, i.e. roughly 47x.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.

    {"source": "<patched file contents>"}   ->  {"passed": true|false, "ms": 123}
    {"cmd": "restore"}                      ->  {"ok": true}
    {"cmd": "shutdown"}                     ->  {"ok": true}

Honesty note: this changes only *how* the oracle is executed, never *what* it asserts. The same tests
run with the same assertions. A candidate that passes here is later confirmed by the full upstream
suite in the caller's stage 2, so a patch that fixes the target while breaking something else is still
rejected.
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
import importlib
import contextlib


def _invalidate(package_root: str, repo: str) -> None:
    """Drop every cached module that lives inside the repository.

    Invalidating only the package under repair is not enough, and the failure is silent rather than
    loud. A test module imported on the first request holds direct references to the function objects
    it pulled in at import time (`from wcwidth import clip`). Re-importing `wcwidth` afterwards leaves
    those references pointing at the *old* code, so the test runs against the unpatched behaviour and
    reports success for a mutation that genuinely breaks it.

    A verifier that says "passed" for broken code is far worse than one that says "failed" for working
    code: it would let a curriculum accept every candidate and quietly poison the retained vocabulary.
    So drop anything whose file lives under the repo -- the package and its tests alike -- and let
    pytest import both fresh.
    """
    repo_prefix = os.path.abspath(repo) + os.sep
    doomed = []
    for name, module in list(sys.modules.items()):
        if name == package_root or name.startswith(package_root + "."):
            doomed.append(name)
            continue
        origin = getattr(module, "__file__", None)
        if origin and os.path.abspath(origin).startswith(repo_prefix):
            doomed.append(name)
    for name in doomed:
        sys.modules.pop(name, None)
    importlib.invalidate_caches()


def main() -> None:
    # Force UTF-8 on the pipes before reading anything.
    #
    # On Windows sys.stdin decodes with the ANSI code page and errors='surrogateescape'. The caller
    # sends candidate source as UTF-8 JSON, so any non-ASCII byte arrives mis-decoded: `┐` is
    # E2 94 90, and cp1252 has no mapping for 0x90, which becomes the lone surrogate \udc90. Writing
    # that back out as UTF-8 then raises UnicodeEncodeError, the request is answered with
    # {"passed": false}, and the verifier rejects *correct* code.
    #
    # It rejected everything: on tabulate/__init__.py, which draws its table borders with box-drawing
    # characters, 87 curriculum defects across two runs scored 0 repaired, while cli.py -- pure ASCII,
    # same repository, same runs -- scored 57 of 103. Nothing in the output said "encoding".
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", errors="strict")
        except Exception:  # pragma: no cover - older interpreters without reconfigure
            pass

    # Never let a cached .pyc answer for a candidate.
    #
    # CPython keys its bytecode cache on (source mtime, source size). Almost every mutation this engine
    # makes is size-preserving -- ' + ' for ' - ', '>=' for '<=' -- and candidates are written to the
    # same path in rapid succession, so two different sources can share an mtime tick and a size. The
    # interpreter then reuses the previous candidate's bytecode and the verdict belongs to the wrong
    # patch. It shows up as an oracle that intermittently fails correct code, which is the hardest kind
    # of wrongness to notice: one observed instance took three attempts to fail to reproduce.
    #
    # importlib.invalidate_caches() does not cover this; it clears finder caches, not the staleness
    # check itself. Writing no bytecode at all removes the failure mode outright, at the cost of
    # re-compiling the module each request -- microseconds against a test run.
    sys.dont_write_bytecode = True

    repo = sys.argv[1]
    target_rel = sys.argv[2]
    test_ids = sys.argv[3:]

    # Existing caches predate this process and are just as capable of being stale.
    for current, dirs, _files in os.walk(repo):
        if ".git" in dirs:
            dirs.remove(".git")
        for name in list(dirs):
            if name != "__pycache__":
                continue
            dirs.remove(name)
            victim = os.path.join(current, name)
            for cached in os.listdir(victim):
                try:
                    os.remove(os.path.join(victim, cached))
                except OSError:
                    pass

    os.chdir(repo)
    if repo not in sys.path:
        sys.path.insert(0, repo)

    target_abs = os.path.join(repo, target_rel)
    with open(target_abs, "r", encoding="utf-8") as handle:
        original = handle.read()

    # The top-level package of the file under repair, e.g. "wcwidth/_clip.py" -> "wcwidth".
    package_root = target_rel.replace("\\", "/").split("/")[0]
    if package_root.endswith(".py"):
        package_root = package_root[:-3]

    # Import pytest once. Its startup is the cost this process exists to amortise.
    import pytest

    sys.stdout.write(json.dumps({"ready": True, "package": package_root, "tests": len(test_ids)}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as error:  # malformed input must not kill the daemon
            sys.stdout.write(json.dumps({"error": f"bad request: {error}"}) + "\n")
            sys.stdout.flush()
            continue

        command = request.get("cmd")
        if command == "shutdown":
            with open(target_abs, "w", encoding="utf-8", newline="") as handle:
                handle.write(original)
            sys.stdout.write(json.dumps({"ok": True}) + "\n")
            sys.stdout.flush()
            return
        if command == "restore":
            with open(target_abs, "w", encoding="utf-8", newline="") as handle:
                handle.write(original)
            _invalidate(package_root, repo)
            sys.stdout.write(json.dumps({"ok": True}) + "\n")
            sys.stdout.flush()
            continue

        source = request.get("source")
        if source is None:
            sys.stdout.write(json.dumps({"error": "no source"}) + "\n")
            sys.stdout.flush()
            continue

        started = time.time()
        passed = False
        error = None
        reason = None
        captured = ""

        # A candidate that does not parse is a failed candidate, decided here rather than by pytest.
        #
        # The generator can emit source that is not valid Python -- a numeric-constant rule once
        # rewrote the `0` inside `0xFE0E` and produced `1xFE0E`. Left to pytest, the unimportable
        # module surfaced as exit 4, which is indistinguishable from the oracle being misconfigured,
        # and five of them in a row stopped a measurement run outright. Compiling first is exact,
        # costs microseconds, and saves the test run entirely.
        try:
            compile(source, target_abs, "exec")
        except SyntaxError as syntax_error:
            sys.stdout.write(json.dumps({
                "passed": False,
                "ms": int((time.time() - started) * 1000),
                "reason": f"syntax-error: {syntax_error.msg} at line {syntax_error.lineno}"
            }) + "\n")
            sys.stdout.flush()
            continue

        try:
            with open(target_abs, "w", encoding="utf-8", newline="") as handle:
                handle.write(source)
            _invalidate(package_root, repo)
            # Quiet: the caller only needs the verdict, and pytest's output is expensive to pipe.
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
                code = pytest.main([
                    "-q", "-x", "--no-header", "-p", "no:cacheprovider",
                    "-o", "addopts=", *test_ids,
                ])
            code = int(code)
            output = buffer.getvalue()
            # pytest exit codes: 0 passed, 1 failed, 2 interrupted, 3 internal, 4 usage, 5 nothing
            # collected. Treating 4 or 5 as failure would make a misconfigured run look like universal
            # rejection, which is indistinguishable from an engine that can never repair anything -- a
            # silent way to corrupt an entire curriculum.
            #
            # Exit 2 is the exception, and it needs reading rather than classifying by number. A
            # candidate that breaks an import makes collection fail, and that is a verdict about the
            # candidate, not a malfunction of the oracle: the whole class of defects reached through
            # the ERROR fallback produces it for every wrong candidate. Reporting those as oracle
            # errors stopped a curriculum run outright, five in a row, when the verifier was working
            # perfectly and simply saying "no".
            # Whose fault is it?
            #
            # Matching pytest's wording has now failed three times -- "error" against "errors", exit 2
            # against exit 4 when the broken import happens to be reached through conftest. The wording
            # keeps changing because the exit code was never the right question. The right question is
            # whether the failure trace names the code this request just wrote: if it does, the
            # candidate broke it and that is a verdict, whatever pytest called it. If it does not, the
            # oracle really could not run and the caller must be told.
            blames_candidate = target_rel.replace("\\", "/").split("/")[-1] in output or package_root in output
            if code == 0:
                passed = True
            elif code == 1:
                passed = False
            elif code in (2, 4) and blames_candidate:
                passed = False
                reason = f"candidate broke collection (pytest exit {code})"
            else:
                error = f"pytest exit {code} (not a test failure)"
                captured = output[-400:]
        except Exception as exception:
            error = f"{type(exception).__name__}: {exception}"

        response = {"passed": passed, "ms": int((time.time() - started) * 1000)}
        if reason:
            response["reason"] = reason
        if error:
            response["error"] = error
            if captured:
                response["output"] = captured
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
