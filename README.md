# Nexa Language Extension for VSCode

[![Version](https://img.shields.io/badge/version-0.1.0-brightgreen.svg)](https://github.com/Nexa-Language/Nexa)
[![License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

Syntax highlighting and one-click build/run commands for the [Nexa](https://github.com/Nexa-Language/Nexa) Agent-Native Programming Language.

## Features

### Syntax Highlighting
Full support for Nexa v2.2.1 syntax:
- **Declarations**: `agent`, `tool`, `flow`, `protocol`, `test`, `type`, `struct`, `enum`, `trait`, `impl`, `fn`, `job`, `server`, `db`, `auth`, `kv`
- **Harness six-tuple** (v2.0+): `autoloop`, `with_context`, `try_agent`, `catch_correction`, `snapshot`, `restore`, `fork`, `merge`, `verify`, `satisfies`, `reflect`, `unharnessed`, `context_policy`, `context`
- **Lifecycle hooks**: `before_step`, `after_step`, `on_error`, `before_tool`, `after_tool`
- **Actor model**: `spawn`, `pass`, `await`, `receive`, `channel`, `parallel`, `race`
- **Control flow**: `if`, `else`, `for`, `each`, `in`, `while`, `match`, `intent`, `semantic_if`, `loop`, `until`
- **DAG operators**: `>>`, `|>>`, `||`, `&>>`, `&&`, `??`, `|>`
- **Error propagation** (v1.2+): `?`, `otherwise`, `defer`
- **Pattern matching** (v1.3.7+): `let`, destructuring patterns
- **ADT** (v1.3+): `struct`, `enum`, `trait`, `impl`, `Option`, `Result`
- **Config** (v2.1+): `use config`, `include`
- **@tool annotation** (v2.0+): zero-cost tool binding
- **Secrets** (`.nxs` files): `config` blocks, `BASE_URL`, `API_KEY`

### One-Click Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| **Nexa: Build** | `Ctrl+Shift+B` | Compile `.nx` to Python (`nexa build`) |
| **Nexa: Run** | `F5` | Build and execute (`nexa run`) |
| **Nexa: Harness Check** | — | Run Harness Validator (`nexa harness-check --harness <mode>`) |
| **Nexa: Validate** | — | Type-check and lint (`nexa validate`) |

Commands are accessible via:
- Command Palette (`Ctrl+Shift+P` → "Nexa: ...")
- Editor title bar buttons (Build ▷, Run ▶)
- Right-click context menu
- Keyboard shortcuts

Output is streamed to the **Nexa Output Channel**.

## Installation

### From VSIX

```bash
code --install-extension nexa-lang-0.1.0.vsix
```

Or in VSCode: Extensions panel → ⋯ → "Install from VSIX..." → select `nexa-lang-0.1.0.vsix`.

### Prerequisites

The extension requires the `nexa` CLI to be installed and on your `PATH`:

```bash
pip install nexa-lang
```

If `nexa` is not on `PATH`, set the full path in VSCode Settings → `nexa.executable`.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `nexa.executable` | `nexa` | Path to the nexa CLI (use `python -m src.cli` if running from source) |
| `nexa.harnessMode` | `warn` | Default Harness validation mode: `off`, `warn`, or `strict` |
| `nexa.proxyUrl` | `""` | HTTPS proxy URL for agents needing network access (e.g. `http://127.0.0.1:7897`) |

## Usage

1. Open a `.nx` file in VSCode
2. Press `Ctrl+Shift+B` to build, or `F5` to run
3. View output in the **Nexa Output Channel** (View → Output → select "Nexa")

### Example

```nexa
agent Researcher uses web_search {
    model: "deepseek/deepseek-chat",
    prompt: "Research the topic."
}

flow main {
    result = "quantum computing" >> Researcher;
    print(result);
}
```

Press `F5` → extension runs `nexa run main.nx` → output streamed to channel.

## File Types

| Extension | Language ID | Description |
|-----------|-------------|-------------|
| `.nx` | `nexa` | Nexa source files |
| `.nxlib` | `nexa` | Nexa library files |
| `.nxs` | `nexa-secrets` | Nexa secrets/config files |

## License

AGPL-3.0 — see [LICENSE](LICENSE).
