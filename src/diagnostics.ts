import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { CliRunner, describeResult } from './cli';
import { processEnvironment, type CliSettings } from './config';
import { parseDiagnostics, toUtf16Position, type CheckKind, type Problem } from './protocol';
import { canCheckAutomatically, isSourceFile } from './resources';
import { CheckScheduler } from './scheduler';
import { errorText, hasDirtySources, resourceContext, settingsFor } from './workspace';
import { languageVersion, openProblems, type CheckReport } from './openProtocol';
import type { OpenServices } from './openServices';

export class NexaDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('nexa');
  private readonly contributions = new Map<string, Problem[]>();
  private readonly scheduler = new CheckScheduler(2);
  private readonly requests = new Map<string, object>();
  private disposed = false;

  constructor(private readonly runner: CliRunner, private readonly output: vscode.OutputChannel, private readonly open?: OpenServices) {}

  invalidate(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.requests.delete(key);
    this.scheduler.cancel(key);
    this.contributions.delete(key);
    this.publish();
  }

  async acceptOpenReport(document: vscode.TextDocument, report: CheckReport): Promise<void> {
    this.invalidate(document);
    const key = document.uri.toString(); const request = {}; const version = document.version;
    this.requests.set(key, request);
    try {
      const problems = await this.mapColumns(openProblems(report, resourceContext(document.uri)));
      if (this.requests.get(key) === request && this.eligible(document) && document.version === version) {
        this.contributions.set(key, problems); this.publish();
      }
    } finally { if (this.requests.get(key) === request) this.requests.delete(key); }
  }

  async check(document: vscode.TextDocument, automatic = true, kinds: CheckKind[] = ['validate', 'harness'], token?: vscode.CancellationToken): Promise<void> {
    if (!this.eligible(document)) { this.invalidate(document); return; }
    if (token?.isCancellationRequested) return;
    const key = document.uri.toString();
    const request = {};
    const version = document.version;
    const context = resourceContext(document.uri);
    this.requests.set(key, request);
    this.scheduler.cancel(key);
    const active = () => this.requests.get(key) === request && this.eligible(document) && document.version === version &&
      resourceContext(document.uri).folder === context.folder;
    const subscription = token?.onCancellationRequested(() => {
      if (this.requests.get(key) !== request) return;
      this.requests.delete(key);
      this.scheduler.cancel(key);
    });
    try {
      if (token?.isCancellationRequested) return;
      if (automatic && !(await canCheckAutomatically(context.file, context.folder, vscode.workspace.isTrusted))) return;
      if (!active()) return;
      const settings = settingsFor(document.uri);
      let versionError: string | undefined;
      try { if (languageVersion(document.getText()) === '3.0') kinds = ['check']; }
      catch (error) { versionError = errorText(error); }
      if (automatic && !settings.diagnosticsEnabled) { this.invalidate(document); return; }
      await this.scheduler.schedule(key, automatic ? settings.delayMs : 0, async (signal, current) => {
        const fresh = () => current() && active();
        if (!fresh()) return;
        const problems: Problem[] = [];
        if (versionError) {
          problems.push({ file: context.file, message: versionError, severity: 'error', code: 'language_version', source: 'check' });
          if (fresh()) { this.contributions.set(key, problems); this.publish(); }
          return;
        }
        for (const kind of kinds) {
          const result = await this.runCheck(document, kind, settings, signal);
          if (!fresh()) return;
          problems.push(...result);
          if (kind === 'validate' && result.some(item => item.severity === 'error')) break;
        }
        if (fresh()) { this.contributions.set(key, problems); this.publish(); }
      });
    } finally {
      subscription?.dispose();
      if (this.requests.get(key) === request) this.requests.delete(key);
    }
  }

  private eligible(document: vscode.TextDocument): boolean {
    return !this.disposed && vscode.workspace.isTrusted && !document.isClosed && !hasDirtySources(document) &&
      document.uri.scheme === 'file' && isSourceFile(document.uri.fsPath);
  }

  private async runCheck(document: vscode.TextDocument, kind: CheckKind, settings: CliSettings, signal: AbortSignal): Promise<Problem[]> {
    const subcommand = kind === 'check' ? 'program/check' : kind === 'validate' ? 'validate' : 'harness-check';
    const args = [subcommand, document.uri.fsPath, '--json'];
    if (kind === 'harness') args.push('--harness', settings.harnessMode);
    try {
      if (!this.eligible(document) || signal.aborted) return [];
      if (kind === 'check') {
        if (!this.open) throw new Error('Open Programs Author service is unavailable.');
        return this.mapColumns(openProblems(await this.open.check(document, signal), resourceContext(document.uri)));
      }
      const result = await this.runner.run({
        executable: settings.executable, args: [...settings.args, ...args], cwd: settings.cwd,
        env: processEnvironment(settings, false), timeoutMs: settings.checkTimeoutMs, maxOutputBytes: settings.maxOutputBytes,
      }, { signal });
      if (result.kind === 'cancelled') return [];
      if (result.kind !== 'exited') throw new Error(describeResult(result));
      const problems = parseDiagnostics(result.stdout, kind, resourceContext(document.uri));
      if (result.code !== 0 && !problems.some(item => item.severity === 'error')) throw new Error(describeResult(result));
      if (result.stderr) this.output.appendLine(`Nexa ${subcommand}: ${result.stderr}`);
      return await this.mapColumns(problems);
    } catch (error) {
      const message = `Nexa ${subcommand} failed: ${errorText(error)}`;
      this.output.appendLine(message);
      return [{ file: document.uri.fsPath, message, severity: 'error', code: 'cli', source: kind }];
    }
  }

  private async mapColumns(problems: Problem[]): Promise<Problem[]> {
    const sources = new Map<string, Promise<string[]>>();
    return Promise.all(problems.map(async problem => {
      const { position, end, ...fileLevel } = problem;
      if (!position) return problem;
      try {
        let source = sources.get(problem.file);
        if (!source) { source = readFile(problem.file, 'utf8').then(text => text.split(/\r?\n/)); sources.set(problem.file, source); }
        const lines = await source;
        const mapped = toUtf16Position(position, lines);
        const mappedEnd = end ? toUtf16Position(end, lines) : undefined;
        return mapped ? { ...fileLevel, position: mapped, ...(mappedEnd ? { end: mappedEnd } : {}) } : fileLevel;
      } catch (error) {
        this.output.appendLine(`Nexa source position unavailable: ${errorText(error)}`);
        return fileLevel;
      }
    }));
  }

  private publish(): void {
    if (this.disposed) return;
    const files = new Map<string, vscode.Diagnostic[]>();
    const unique = new Set<string>();
    for (const problems of this.contributions.values()) {
      for (const problem of problems) {
        const identity = JSON.stringify(problem);
        if (unique.has(identity)) continue;
        unique.add(identity);
        const list = files.get(problem.file) ?? [];
        list.push(this.diagnostic(problem));
        files.set(problem.file, list);
      }
    }
    this.collection.clear();
    for (const [file, diagnostics] of files) this.collection.set(vscode.Uri.file(file), diagnostics);
  }

  private diagnostic(problem: Problem): vscode.Diagnostic {
    const point = problem.position ?? { line: 0, character: 0 };
    const end = problem.end ?? point;
    const range = new vscode.Range(point.line, point.character, end.line, end.character);
    const severity = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information }[problem.severity];
    const message = problem.position ? problem.message : `[File-level] ${problem.message}`;
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = problem.source === 'harness' ? 'Nexa Harness' : 'Nexa';
    diagnostic.code = problem.code;
    return diagnostic;
  }

  dispose(): void {
    this.disposed = true;
    this.requests.clear();
    this.scheduler.dispose();
    this.contributions.clear();
    this.collection.dispose();
  }
}
