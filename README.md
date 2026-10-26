# Nexa for Visual Studio Code

Extension **0.3.0** adds native Nexa 3.0 Open Programs authoring, persistent activities, evidence and exact patch review. Nexa 2.4 syntax, CLI settings, tasks and shortcuts remain available.

[Runtime](https://github.com/Nexa-Language/Nexa) · [Documentation](https://github.com/Nexa-Language/Nexa-docs) · [Extension source](https://github.com/Nexa-Language/Nexa-extension)

## Start with Nexa 3.0

Install [Nexa v3.0.0](https://github.com/Nexa-Language/Nexa/releases/tag/v3.0.0). CI and packaged schemas use release commit `274379606e53c90d2d25774f6bb8984c777d0759`. The Python runtime supports Linux/macOS. Candidate execution needs Docker Engine, Docker Desktop or Colima.

```sh
git clone --branch v3.0.0 --depth 1 https://github.com/Nexa-Language/Nexa.git
cd Nexa
uv sync --locked --all-extras
code --install-extension nexa-lang-0.3.0.vsix
```

Configure each workspace folder explicitly:

```json
{
  "nexa.executablePath": "/absolute/path/to/Nexa/.venv/bin/nexa",
  "nexa.open.pythonPath": "/absolute/path/to/Nexa/.venv/bin/python",
  "nexa.open.environment": "offline.environment.json",
  "nexa.open.state": ".nexa/open-programs.sqlite3",
  "nexa.open.programId": "demo",
  "nexa.open.maxModelCalls": 4,
  "nexa.open.maxTokens": 20000,
  "nexa.open.timeoutSeconds": 120
}
```

The explicit Python setting runs the packaged read-only SDK bridge and must contain Nexa 3.0.0. The extension never infers or installs an interpreter. `nexa.open.pythonArgs` supplies launcher prefix arguments. Existing CLI options remain available, including executable `uv` with args `["run", "--project", "/path/to/Nexa", "nexa"]`. Arguments are passed without a shell; paths with spaces work as individual arguments.

Create `offline.environment.json`:

```json
{"image":"python@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704"}
```

Create `answer.nx`:

```nexa
language "3.0"
program Answer {
    goal answer() -> Int {
        intent "Return 42"
        implementation value 42
    }
}
```

**Check Open Program** is local and sends only `program/check` to an Author process without a provider environment. Build explicitly invokes OCI. Run asks for an exact goal and an optional JSON input file. Open goals need a provider environment; credentials stay in the runtime process environment. Explicit resolution displays the configured call, token and time budgets.

## Open Programs workflow

The Explorer's **Nexa Open Programs** view separates source goals/obligations, draft and active runtime revisions, Author activities, Runtime activities, clarification requests and evidence. Select a row to open its exact record in a native JSON editor. Refresh Status restores activities created by other clients and shows each activity's pinned revision.

| Command ID | Action |
| --- | --- |
| `nexa.open.check` | Native contract check, Problems and goals |
| `nexa.build` / `nexa.run` | Build / execute the selected source using workspace environment and budgets |
| `nexa.open.buildLocked` | Verify source, environment, stored artifact and evidence without model requests |
| `nexa.open.resolve` | Propose the source draft with CAS, select a goal and start an Author activity |
| `nexa.open.revise` | Build and activate using the exact current draft revision |
| `nexa.open.maintain` | Choose repository, included paths, change request and event; produce a proposal |
| `nexa.open.status` / `nexa.open.cancel` | Restore state / select the exact Author or Runtime activity ID for durable cancellation |
| `nexa.open.answer` / `nexa.open.syncSource` | Answer an exact clarification / review and synchronize its intent-only source edit |
| `nexa.open.proposal` / `nexa.open.apply` | Review file diffs and evidence / explicitly authorize and apply the exact proposal |
| `nexa.open.recover` / `nexa.open.resumeApply` | Inspect program recovery or patch journal / explicitly authorize resumed application |
| `nexa.open.capsuleImport` / `nexa.open.capsuleExport` | Import a capsule / export a selected runtime activity with origin, creator and license |

Answering first changes the database draft. The extension durably records pending synchronization before the answer request, reads the exact new IR and shows a source diff. Confirmation changes only the selected intent JSON token, using source/document checks. The native frontend validates the whole resulting program before synchronization with the exact expected revision. Edits, concurrent revisions, declined confirmation and restarts preserve the pending record and block build/run/resolve/revise. A current draft answered by another client also blocks replacement from an older source file; complete synchronization in that client first.

Patch approval is separate from acceptance and from 2.4 tool approvals. The extension shows per-file baseline/proposed diffs and current evidence, requests human confirmation and an actor, issues a ten-minute grant, then passes that exact grant ID to native apply. The runtime rechecks scope, baseline, policy, evidence, task and expiry. Unsaved target documents block approval. Recovery preserves native journal and preserved-file information. Stopping a CLI task stops its process; use **Cancel Activity** to obtain a durable runtime cancellation result.

The packaged SDK bridge exposes only initialize/snapshot/revision/proposal queries. It opens existing state with SQLite `mode=ro`, checks the 3.0 schema/application identity and uses native model/digest validation. SQLite may manage WAL reader sidecars; the bridge performs no business writes or migrations and reads active WAL state. Missing runtimes and incompatible databases are visible failures.

## Open Programs settings

All settings resolve in the source's owning workspace folder. Configuration changes replace Author/bridge connections. Explicit Author sessions bind a private snapshot of the configured environment (up to 2 MiB). Every queued RPC rechecks the original file's content before dispatch. External edits, replacements or deletion invalidate the old session; the next Resolve loads the current environment. Session shutdown removes its snapshot. Automatic Check uses no provider environment.

Unknown language versions produce errors; files without a declaration retain 2.4 routing. A 3.0 declaration accepts leading whitespace and `//` comments, matching the released frontend. BOM/block-comment prefixes are rejected. Native syntax errors, including EOF errors, retain their original message and point location in Problems; Unicode columns are converted to VS Code's UTF16 coordinates.

| Setting | Default | Purpose |
| --- | --- | --- |
| `nexa.open.environment` | Empty | Compiler environment JSON path for explicit execution |
| `nexa.open.state` | `.nexa/open-programs.sqlite3` | Native state database |
| `nexa.open.programId` | Source filename stem | Persistent program identity |
| `nexa.open.pythonPath` / `pythonArgs` | Empty / `[]` | Explicit runtime interpreter/launcher for SDK queries |
| `nexa.open.dockerContext` | Empty | Optional OCI context for build/run/Author candidate evaluation |
| `nexa.open.capsule` | Empty | Exact imported capsule digest selected for run/maintenance |
| `nexa.open.maxModelCalls` | `4` | Model call budget |
| `nexa.open.maxTokens` | `20000` | Cumulative token budget |
| `nexa.open.timeoutSeconds` | `120` | Resolution deadline in seconds |

Use `nx-program` and `nx-open-goal` for 3.0 snippets. Official schemas are packaged for `*.environment.json`, `*.nx.lock`, `*.capsule.json`, `*.program.json` and `*.patch.json`.

## 2.4 compatibility workflow

| Command | Shortcut | Result |
| --- | --- | --- |
| Nexa: Build | Ctrl+Shift+B / Cmd+Shift+B | Compile with the configured Harness mode in a native task terminal |
| Nexa: Run | F5 | Compile and execute, streaming stdout and stderr |
| Nexa: Validate | Command Palette | Parse/semantic checks in Problems |
| Nexa: Harness Check | Command Palette | Harness diagnostics in Problems |
| Nexa: Inspect Structure | Command Palette or title bar | Open the CLI's structure report in a JSON editor |
| Nexa: Stop Running Tasks | Status bar, title bar or Command Palette | Cancel a selected task, or all Nexa tasks |

The original four command IDs and build/run shortcuts are retained. The status bar exposes running tasks and a keyboard-accessible stop action. VS Code's **Tasks: Run Task** also lists build/run tasks for open Nexa sources. A workspace task can be checked into `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    { "type": "nexa", "command": "build", "file": "src/main.nx", "label": "Build Nexa" }
  ]
}
```

Commands save the target document and stop when saving fails. Save other changed Nexa files in that workspace folder before executing, so included modules use the same saved source state. Diagnostics check saved files on open/save with a debounce; editing clears related results and cancels old checks. Checks resume after the folder's changed Nexa sources are saved. Closing a source removes its diagnostics. Result versions are checked before publication.

Problems use the CLI's actual file, line and column. Messages without a position are explicitly marked **File-level**. Syntax errors skip the subsequent Harness pass. Missing executables, malformed JSON, process signals, deadlines and output limits are visible failures. The **Nexa Output** channel records check failures and task summaries; task terminals carry live build/run output.

Outline symbols use `inspect` entries with `source: { file, line, column, end_line, end_column }`. Source positions are 1-based with exclusive ends. Included declarations retain their source files and are excluded from the current file's Outline. Older or partial inspector output without positions remains available through Inspect. The extension uses CLI tooling; a language server is not required.

Tasks have one active execution per file, enforce a timeout and combined output limit, and distinguish nonzero exits from signals and cancellation. On macOS/Linux, stopping a task terminates its process group, escalating after 600 ms. Windows uses `taskkill /T /F`. Task stdin is closed; run programs that request interactive terminal input directly with `nexa run` in an integrated terminal.

## Files and snippets

| Extension | Language ID | Support |
| --- | --- | --- |
| `.nx` | `nexa` | Syntax, snippets, diagnostics, tasks and positioned Outline |
| `.nxlib` | `nexa` | Library syntax and the same commands; the runtime may emit its extension warning |
| `.nxs` | `nexa-secrets` | Configuration syntax highlighting; no automatic CLI execution |

Type `nx-flow`, `nx-agent`, `nx-tool` or `nx-harness-flow` for examples validated against the local 2.4 parser. Syntax rules cover agent declarations, typed tools, protocols, Harness constructs, actor operations, strings/comments and DAG operators.

## Settings and migration

| Setting | Default | Purpose |
| --- | --- | --- |
| `nexa.executablePath` | Empty | Exact executable; empty falls back to the legacy setting |
| `nexa.executableArgs` | `[]` | Prefix arguments before a Nexa subcommand |
| `nexa.executable` | `nexa` | Legacy setting, still accepting `uv run nexa`, `python -m src.cli` and quoted paths |
| `nexa.harnessMode` | `warn` | `off`, `warn` or `strict`, applied to build/run and Harness checks |
| `nexa.proxyUrl` | Empty | HTTP/HTTPS proxy override for explicit build/run tasks; empty inherits the environment |
| `nexa.diagnostics.enabled` | `true` | Automatic saved-source checks |
| `nexa.diagnostics.delayMs` | `500` | Automatic check debounce |
| `nexa.checkTimeoutMs` | `30000` | Deadline per validate, Harness or inspect process |
| `nexa.taskTimeoutMs` | `300000` | Deadline per build/run task |
| `nexa.maxOutputBytes` | `4194304` | Combined stdout/stderr limit per process |

Legacy settings remain readable and produce a one-time migration hint during a command. Explicit `executablePath` takes precedence. Arguments are passed directly without a shell. Shell variables, redirections and command substitution are not expanded. Prefer native executables such as `uv.exe` or `python.exe` to Windows batch wrappers.

Restricted Mode retains syntax and snippets. CLI execution, checks and inspection require Workspace Trust, including commands triggered programmatically. Automatic operations are limited to real files inside their workspace folder; symlinks escaping the folder and virtual resources are excluded. These checks execute no model calls. Build/run executes the user's program after an explicit command.

## Develop and verify

Use **Node 22+** and the pinned **pnpm 10.28.2** toolchain. The newer packaging tools require Node 22; the extension itself targets VS Code 1.96's API and ships no npm runtime dependencies.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm run test:host
NEXA_CLI=/absolute/path/to/Nexa/.venv/bin/nexa pnpm run test:cli
pnpm run package
pnpm run verify:package
NEXA_CLI=/path/to/nexa NEXA_PYTHON=/path/to/python pnpm run test:open
NEXA_CLI=/path/to/nexa NEXA_PYTHON=/path/to/python pnpm run test:oci
NEXA_CLI=/path/to/nexa NEXA_PYTHON=/path/to/python pnpm run test:host:open
```

`test:host` uses an installed macOS VS Code when available, accepts `VSCODE_EXECUTABLE_PATH`, or downloads the pinned VS Code 1.96.4 baseline. It uses temporary profiles and fake local CLI processes, testing trusted and restricted workspaces separately. The official test helper forces trust on, so the runner launches the test host directly to exercise the real trust service. Linux hosts need a graphical session, for example `xvfb-run -a pnpm run test:host`.

Behavior tests cover process trees, output streaming, errors/signals, cancellation, bounds, paths with spaces, configuration migration, save failures, resource containment, stale diagnostics and TextMate tokenization. The real CLI suite validates 2.4/3.0 snippets and runs a 2.4 hello flow. The Open Programs suites use the released Author/SDK and deterministic provider fixtures. OCI checks exercise clarification, build/run, locked replay, exact proposal/grant/application, cancellation, recovery and capsules. Test evidence is written under `.test-artifacts/` and stays out of the VSIX.

The VSIX includes compiled JavaScript, the read-only Python bridge, all official 3.0 schemas, grammar, snippets, documentation, icon and MIT license. The installed-package host suite uses trusted/restricted profiles on VS Code 1.96.4. Marketplace publishing requires separate authorization and is excluded from CI.

## License

This extension is licensed under **MIT**, as recorded in the existing [LICENSE](LICENSE). Nexa's runtime has its own license in its repository.
