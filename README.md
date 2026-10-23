# Nexa for Visual Studio Code

**An agent-native language and runtime.** Edit Nexa 2.4 programs with source diagnostics, native build/run tasks, structured inspection and an Outline backed by compiler source positions.

[Language and runtime](https://github.com/Nexa-Language/Nexa) · [Documentation](https://github.com/Nexa-Language/Nexa-docs) · [Extension source](https://github.com/Nexa-Language/Nexa-extension)

## Start with Nexa 2.4

Extension **0.2.0** targets the released [Nexa v2.4.0](https://github.com/Nexa-Language/Nexa/releases/tag/v2.4.0) CLI. Validation and CI use its source commit `c2162637236e4a73feea410c4183672411666521`. Install the runtime from that release source:

```sh
git clone --branch v2.4.0 --depth 1 https://github.com/Nexa-Language/Nexa.git
cd Nexa
uv sync --locked
uv run nexa --version
```

Select that environment in VS Code workspace settings:

```json
{
  "nexa.executablePath": "/absolute/path/to/Nexa/.venv/bin/nexa"
}
```

On Windows, use the environment's `Scripts\\nexa.exe`. If the source checkout is managed through `uv`, keep the executable and arguments separate:

```json
{
  "nexa.executablePath": "uv",
  "nexa.executableArgs": ["run", "--project", "/absolute/path/to/Nexa", "nexa"]
}
```

Paths containing spaces work without adding shell quotes inside `executablePath` or individual arguments. `${workspaceFolder}` and `${fileDirname}` are supported in these settings. `cwd` is the source file's own workspace folder, or its parent directory for an explicitly executed standalone file. Multi-root workspaces resolve settings per resource.

Install the local extension package with VS Code **1.96 or later**:

```sh
code --install-extension nexa-lang-0.2.0.vsix
```

Open a trusted workspace and create `main.nx`:

```nexa
flow main {
    print "Hello, Nexa!";
}
```

Press **F5** to run. This example makes no model calls. Provider credentials and model configuration are managed by the Nexa runtime for programs that use agents.

## Editor workflow

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
```

`test:host` uses an installed macOS VS Code when available, accepts `VSCODE_EXECUTABLE_PATH`, or downloads the pinned VS Code 1.96.4 baseline. It uses temporary profiles and fake local CLI processes, testing trusted and restricted workspaces separately. The official test helper forces trust on, so the runner launches the test host directly to exercise the real trust service. Linux hosts need a graphical session, for example `xvfb-run -a pnpm run test:host`.

Behavior tests cover process trees, output streaming, errors/signals, cancellation, bounds, paths with spaces, configuration migration, save failures, resource containment, stale diagnostics and TextMate tokenization. The real CLI suite validates all snippets and runs only a local hello flow. Test evidence is written under `.test-artifacts/` and stays out of the VSIX.

The VSIX allowlist includes compiled JavaScript, grammar, snippets, documentation, icon and the MIT license. Publishing requires a separately verified Marketplace publisher and a compatible published Nexa 2.4 runtime. No publish action is included in CI.

## License

This extension is licensed under **MIT**, as recorded in the existing [LICENSE](LICENSE). Nexa's runtime has its own license in its repository.
