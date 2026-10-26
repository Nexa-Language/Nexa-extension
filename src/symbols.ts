import * as path from 'node:path';
import * as vscode from 'vscode';
import { CliRunner, describeResult } from './cli';
import { processEnvironment } from './config';
import { parseInspection, toUtf16Position, type Inspection } from './protocol';
import { canCheckAutomatically } from './resources';
import { errorText, resourceContext, settingsFor } from './workspace';
import { languageVersion, openInspection } from './openProtocol';
import type { OpenServices } from './openServices';

const kinds: Record<string, vscode.SymbolKind> = {
  agents: vscode.SymbolKind.Class, tools: vscode.SymbolKind.Function, protocols: vscode.SymbolKind.Interface,
  flows: vscode.SymbolKind.Function, tests: vscode.SymbolKind.Method, types: vscode.SymbolKind.Struct,
  goals: vscode.SymbolKind.Function, handlers: vscode.SymbolKind.Event,
};

export class NexaSymbols implements vscode.DocumentSymbolProvider, vscode.Disposable {
  private readonly requests = new Map<string, AbortController>();
  private readonly cache = new Map<string, { version: number; inspection: Inspection }>();
  private disposed = false;

  constructor(private readonly runner: CliRunner, private readonly output: vscode.OutputChannel, private readonly open?: OpenServices) {}

  invalidate(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.requests.get(key)?.abort();
    this.requests.delete(key);
    this.cache.delete(key);
  }

  async inspect(document: vscode.TextDocument, token: vscode.CancellationToken, automatic = false): Promise<Inspection | undefined> {
    if (!vscode.workspace.isTrusted || this.disposed || document.isDirty || document.isClosed || token.isCancellationRequested) return;
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    const context = resourceContext(document.uri);
    this.requests.get(key)?.abort();
    const controller = new AbortController();
    this.requests.set(key, controller);
    const cancellation = token.onCancellationRequested(() => controller.abort());
    const version = document.version;
    const fresh = () => this.requests.get(key) === controller && !controller.signal.aborted && !this.disposed &&
      !document.isDirty && document.version === version && !document.isClosed && vscode.workspace.isTrusted &&
      resourceContext(document.uri).folder === context.folder;
    try {
      if (automatic && !(await canCheckAutomatically(context.file, context.folder, vscode.workspace.isTrusted))) return;
      if (!fresh()) return;
      if (cached?.version === version) return cached.inspection;
      if (languageVersion(document.getText()) === '3.0') {
        if (!this.open) throw new Error('Open Programs Author service is unavailable.');
        const report = await this.open.check(document, controller.signal);
        if (!fresh()) return;
        const inspection = openInspection(report, context);
        this.cache.set(key, { version, inspection });
        return inspection;
      }
      const settings = settingsFor(document.uri);
      const result = await this.runner.run({
        executable: settings.executable, args: [...settings.args, 'inspect', document.uri.fsPath, '--format', 'json'],
        cwd: settings.cwd, env: processEnvironment(settings, false), timeoutMs: settings.checkTimeoutMs, maxOutputBytes: settings.maxOutputBytes,
      }, { signal: controller.signal });
      if (!fresh()) return;
      if (result.kind !== 'exited' || result.code !== 0) throw new Error(describeResult(result));
      const inspection = parseInspection(result.stdout, resourceContext(document.uri));
      this.cache.set(key, { version, inspection });
      return inspection;
    } finally {
      cancellation.dispose();
      if (this.requests.get(key) === controller) this.requests.delete(key);
    }
  }

  async provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
    try {
      const inspection = await this.inspect(document, token, true);
      const symbols: vscode.DocumentSymbol[] = [];
      const lines = document.getText().split(/\r?\n/);
      for (const entry of inspection?.entries ?? []) {
        const span = entry.span;
        if (!span || path.normalize(span.file) !== path.normalize(document.uri.fsPath)) continue;
        const start = toUtf16Position(span.start, lines);
        const end = toUtf16Position(span.end, lines);
        if (!start || !end) continue;
        const range = new vscode.Range(start.line, start.character, end.line, end.character);
        if (!document.validateRange(range).isEqual(range)) continue;
        symbols.push(new vscode.DocumentSymbol(entry.name, entry.kind, kinds[entry.kind] ?? vscode.SymbolKind.Variable, range, new vscode.Range(range.start, range.start)));
      }
      return symbols;
    } catch (error) {
      this.output.appendLine(`Nexa inspect failed: ${errorText(error)}`);
      return [];
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    this.cache.clear();
  }
}
