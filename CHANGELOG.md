# Changelog

## 0.3.0 — Nexa 3.0 native authoring

- Route checks and goal/handler Outline through native Author while preserving 2.4 tooling.
- Add bounded JSON-RPC lifecycle, explicit read-only SDK bridge and per-root environment/budgets.
- Add persistent activity/evidence view and exact patch review, approval, apply, cancellation, recovery and capsule commands.
- Persist clarification synchronization across interruption/restart and enforce source/draft CAS.
- Bind Author to an environment snapshot and recheck current permissions before every RPC dispatch.
- Preserve native syntax/EOF point diagnostics and Unicode positions in Problems.
- Package official 3.0 schemas/snippets and verify native CLI/SDK/Author, real OCI and installed VSIX on VS Code 1.96.4.

## 0.2.0 — Nexa 2.4 tooling upgrade

- Migrate the extension to typed modules and a locked Node/pnpm toolchain.
- Add CLI-backed Problems, include-aware source positions, Outline and Inspect.
- Add native build/run tasks, streaming output, cancellation, process-tree cleanup, deadlines and output limits.
- Preserve command IDs, shortcuts, file associations and common executable configurations.
- Apply Workspace Trust, per-resource configuration and stale-result protection.
- Add validated snippets, TextMate regressions, real-process tests and extension-host smoke tests.
- Correct package/README license metadata to the repository's existing MIT license.
