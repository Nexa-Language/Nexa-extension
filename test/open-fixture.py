"""Deterministic provider and SDK state fixtures; never reads model credentials."""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path

from src.open_programs.compiler import OpenCompiler
from src.open_programs.controller import RuntimeController
from src.open_programs.executor import OCIExecutor
from src.open_programs.frontend import check
from src.open_programs.model import BuildArtifact, CompilerEnvironment, PatchProposal, ProgramError, ProgramRevision, SourceBundle, content_digest
from src.open_programs.protocol import AuthorProtocol, serve_stdio
from src.open_programs.store import ProgramStore
from src.runtime.providers import ModelReply, ModelRequest

IMAGE = "python@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704"


class FixtureProvider:
    name = "scripted"

    def complete(self, request: ModelRequest, on_text: Callable[[str], None] | None = None) -> ModelReply:
        del on_text
        answered = "Author clarification:" in json.dumps(request.messages)
        value = {"implementation": {"kind": "value", "body": "42"}, "clarification": ""} if answered else {"implementation": None, "clarification": "Which integer?"}
        return ModelReply({"role": "assistant", "content": json.dumps(value)}, input_tokens=1, output_tokens=1, usage_reported=True)


@contextmanager
def fixture_provider(environment: CompilerEnvironment) -> Generator[FixtureProvider, None, None]:
    del environment
    yield FixtureProvider()


def seed(directory: Path) -> None:
    store = ProgramStore(directory / "seed.db")
    source = 'language "3.0" program Seed { goal answer() -> Int { stage runtime intent "Return 42" implementation value 42 } }'
    report = check(SourceBundle(text=source))
    assert report.program is not None
    environment = CompilerEnvironment(image=IMAGE)
    revision = ProgramRevision(program_id="seed", program=report.program, environment_digest=environment.digest)
    store.commit_revision(None, revision, [])
    artifact = BuildArtifact(program_digest=report.program.digest, environment_digest=environment.digest, results=(), runtime_goals=("answer",))
    runtime = RuntimeController(OpenCompiler(environment, store, executor=OCIExecutor()))
    runtime.activate_revision(runtime.propose_revision(None, revision, artifact), None)
    activities = [runtime.start_activity("seed", "answer") for _ in range(2)]
    (directory / "offline.environment.json").write_text(environment.model_dump_json(), encoding="utf-8")
    print(json.dumps({"activities": [item.activity_id for item in activities], "revision": revision.digest}))


def main() -> None:
    mode = sys.argv.pop(1)
    if mode in {"pending-effect", "effect-status"}:
        store = ProgramStore(Path(sys.argv[1]))
        runtime = RuntimeController(OpenCompiler(CompilerEnvironment(image=IMAGE), store, executor=OCIExecutor()))
        if mode == "pending-effect":
            intent = runtime.effects.prepare("seed", "fixture-operation", content_digest("fixture-payload"), idempotent=False)

            def interrupted(operation_id: str) -> str:
                raise RuntimeError("fixture interruption after dispatch: " + operation_id)

            try:
                runtime.effects.execute(intent.operation_id, interrupted)
            except RuntimeError:
                pass
        pending = runtime.effects.pending("seed")
        try:
            runtime.start_activity("seed", "answer")
        except ProgramError as error:
            print(json.dumps({"state": pending[0].state, "blocked": error.code}))
            return
        raise AssertionError("Pending external effects must block new activity")
    if mode == "invalidate-evidence":
        store = ProgramStore(Path(sys.argv[1]))
        proposal = store.get(sys.argv[2], PatchProposal)
        failed = proposal.evidence[0].model_copy(update={"passed": False, "issued_at": time.time() + 1, "detail": "fixture later deterministic failure"})
        print(json.dumps({"evidence_id": store.put(failed)}))
        return
    if mode == "wrong-state":
        with sqlite3.connect(sys.argv[1]) as connection:
            connection.execute("PRAGMA user_version=99")
        print('{}')
        return
    if mode == "wal":
        store = ProgramStore(Path(sys.argv[1]))
        connection = sqlite3.connect(sys.argv[1])
        connection.execute("BEGIN")
        connection.execute("PRAGMA user_version").fetchone()
        runtime = RuntimeController(OpenCompiler(CompilerEnvironment(image=IMAGE), store, executor=OCIExecutor()))
        runtime.start_activity("seed", "answer")
        service = AuthorProtocol(store)
        try:
            serve_stdio(service, sys.stdin, sys.stdout)
        finally:
            service.close()
            connection.close()
        return
    if mode == "patch":
        from src.open_programs.workspace import snapshot_workspace

        snapshot = snapshot_workspace(Path(sys.argv[1]), ["calc.py"])
        print(json.dumps({"base_digest": snapshot.digest, "changes": [{"path": "calc.py", "before_digest": snapshot.files[0].digest, "content": "def add(a, b):\n return a + b\n"}]}))
        return
    if mode == "seed":
        seed(Path(sys.argv[1]))
        return
    if mode == "author":
        store = ProgramStore(Path(sys.argv[1]))
        environment = CompilerEnvironment(image=IMAGE, allow_model=True, model="fixture")
        service = AuthorProtocol(store, OpenCompiler(environment, store, executor=OCIExecutor(), provider=FixtureProvider()))
        try:
            serve_stdio(service, sys.stdin, sys.stdout)
        finally:
            service.close()
        return
    if mode == "cli":
        from src.open_programs import cli as open_cli
        from src.open_programs import commands

        from src import cli

        open_cli.model_provider = fixture_provider
        commands.model_provider = fixture_provider
        cli.main()
        return
    raise ValueError("Unknown fixture mode")


if __name__ == "__main__":
    main()
