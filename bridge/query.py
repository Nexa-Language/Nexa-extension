"""Read-only Nexa 3.0 SDK queries. Pinned to runtime 274379606e53c90d2d25774f6bb8984c777d0759."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections.abc import Generator
from contextlib import contextmanager
from importlib.metadata import version
from pathlib import Path
from typing import Any

from src.open_programs.compiler import OpenCompiler
from src.open_programs.controller import RuntimeController
from src.open_programs.executor import OCIExecutor
from src.open_programs.model import CompilerEnvironment, FrozenModel, PatchProposal, ProgramError, ProgramRevision, RuntimeActivity, RuntimeHead, content_digest
from src.open_programs.protocol import AuthorActivity
from src.open_programs.store import ProgramStore

METHODS = ("initialize", "snapshot", "revision", "proposal")
MAX_FRAME = 2 * 1024 * 1024


class ReadOnlyStore(ProgramStore):
    def __init__(self, path: Path) -> None:
        # The released constructor creates schemas and backfills indices; query clients must never call it.
        self.path = path.resolve(strict=True)
        if not self.path.is_file():
            raise ProgramError("state_missing", "Select an existing Nexa 3.0 state file")
        with self._connection() as connection:
            schema = connection.execute("PRAGMA user_version").fetchone()[0]
            application = connection.execute("PRAGMA application_id").fetchone()[0]
            if schema != 1 or application != 0x4E585033:
                raise ProgramError("unsupported_schema", "Expected Nexa 3.0 state schema 1")

    @contextmanager
    def _connection(self) -> Generator[sqlite3.Connection, None, None]:
        connection = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=10)
        try:
            yield connection
        finally:
            connection.close()


def dump(record: FrozenModel | None) -> dict[str, Any] | None:
    if record is None:
        return None
    return {"digest": record.digest, **record.model_dump(mode="json")}


def snapshot(store: ReadOnlyStore, program_id: str) -> dict[str, Any]:
    events = store.events(program_id)
    # Event object_id identifies immutable snapshots. Resolve their actual IDs, then read current state.
    identifiers = {store.get(event.object_id, RuntimeActivity).activity_id for _, event in events if event.kind.startswith("activity_")}
    compiler = OpenCompiler(CompilerEnvironment(image="python@sha256:" + "0" * 64), store, executor=OCIExecutor())
    runtime = RuntimeController(compiler)
    activities = [runtime.activity(identifier) for identifier in sorted(identifiers)]
    return {
        "draft": dump(store.current_revision(program_id)),
        "runtime": dump(store.reference("runtime:" + content_digest(program_id), RuntimeHead)),
        "runtime_activities": [dump(activity) for activity in activities if activity.program_id == program_id],
        "author_activities": [dump(activity) for activity in store.references("activity:", AuthorActivity) if activity.program_id == program_id],
        "events": [{"cursor": cursor, "event": event.model_dump(mode="json")} for cursor, event in events],
    }


def dispatch(state: Path, method: str, params: dict[str, Any]) -> dict[str, Any] | None:
    if method == "initialize":
        installed = version("nexa-lang")
        if installed != "3.0.0" or params.get("protocol_version") != "3.0":
            raise ProgramError("protocol_version", "Read-only bridge requires Nexa 3.0.0")
        return {"protocol_version": "3.0", "runtime_version": installed, "max_inflight": 1, "methods": METHODS, "read_only": True}
    if method not in METHODS:
        raise ProgramError("method_not_found", "Query is not in the read-only whitelist")
    store = ReadOnlyStore(state)
    program_id = params.get("program_id")
    if not isinstance(program_id, str) or not program_id:
        raise ProgramError("invalid_params", "program_id is required")
    if method == "snapshot":
        return snapshot(store, program_id)
    identifier = params.get("object_id")
    if not isinstance(identifier, str) or len(identifier) != 64:
        raise ProgramError("invalid_params", "An exact object digest is required")
    if method == "revision":
        revision = store.get(identifier, ProgramRevision)
        if revision.program_id != program_id:
            raise ProgramError("identity_mismatch", "Revision belongs to another program")
        return dump(revision)
    proposal = store.get(identifier, PatchProposal)
    activities = snapshot(store, program_id)["runtime_activities"]
    if not any(activity["activity_id"] == proposal.task_id for activity in activities):
        raise ProgramError("identity_mismatch", "Proposal belongs to another program")
    return dump(proposal)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    while line := sys.stdin.readline(MAX_FRAME + 1):
        identifier: object = None
        try:
            if len(line) > MAX_FRAME or not line.endswith("\n"):
                raise ProgramError("frame_limit", "Frame exceeds the bridge limit")
            request = json.loads(line)
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or type(request.get("id")) not in {str, int}:
                raise ProgramError("invalid_request", "Expected a JSON-RPC request")
            identifier = request["id"]
            method, params = request.get("method"), request.get("params", {})
            if not isinstance(method, str) or not isinstance(params, dict):
                raise ProgramError("invalid_params", "Expected method and object params")
            response = {"jsonrpc": "2.0", "id": identifier, "result": dispatch(args.state, method, params)}
        except (ProgramError, OSError, ValueError, sqlite3.Error) as error:
            code = error.code if isinstance(error, ProgramError) else "query_failed"
            response = {"jsonrpc": "2.0", "id": identifier, "error": {"code": -32000, "message": "Read-only SDK query failed", "data": {"code": code}}}
        encoded = json.dumps(response, ensure_ascii=False)
        if len(encoded) > MAX_FRAME:
            encoded = json.dumps({"jsonrpc": "2.0", "id": identifier, "error": {"code": -32000, "message": "Query output limit exceeded"}})
        print(encoded, flush=True)


if __name__ == "__main__":
    main()
