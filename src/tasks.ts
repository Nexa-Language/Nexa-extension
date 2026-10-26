import * as path from 'node:path';
import * as vscode from 'vscode';
import { CliRunner, describeResult, taskExitCode, type CliResult } from './cli';
import { processEnvironment } from './config';
import { isSourceFile, requireTrust } from './resources';
import { errorText, savedDocument, settingsFor } from './workspace';
import { languageVersion } from './openProtocol';

export type TaskAction = 'build' | 'run';
interface RunningTask { controller: AbortController; uri: vscode.Uri; action: TaskAction }

class TaskTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private readonly controller = new AbortController();
  private opened = false;

  constructor(private readonly execute: (signal: AbortSignal, write: (text: string) => void) => Promise<number>) {}

  open(): void {
    if (this.opened) return;
    this.opened = true;
    const write = (text: string) => this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
    void this.execute(this.controller.signal, write).then(code => this.finish(code), error => {
      write(`Nexa: ${errorText(error)}\n`);
      this.finish(1);
    });
  }

  close(): void { this.controller.abort(); }
  private finish(code: number): void {
    this.closeEmitter.fire(code);
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

export class NexaTasks implements vscode.TaskProvider, vscode.Disposable {
  private readonly active = new Map<string, RunningTask>();
  private readonly pending = new Set<string>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private disposed = false;

  constructor(private readonly runner: CliRunner, private readonly output: vscode.OutputChannel,
    private readonly openExecute?: (action: TaskAction, document: vscode.TextDocument, signal: AbortSignal, write: (text: string) => void) => Promise<number>) {}
  get count(): number { return this.active.size; }

  async start(action: TaskAction, uri?: vscode.Uri): Promise<vscode.TaskExecution | undefined> {
    const document = await savedDocument(uri);
    const key = document.uri.toString();
    if (this.pending.has(key) || this.active.has(key)) throw new Error('A Nexa task is already running for this file. Stop it first.');
    this.pending.add(key);
    try { return await vscode.tasks.executeTask(this.create(action, document.uri)); }
    finally { this.pending.delete(key); }
  }

  create(action: TaskAction, uri: vscode.Uri): vscode.Task {
    const definition = { type: 'nexa', command: action, file: uri.fsPath };
    const scope = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.TaskScope.Workspace;
    const execution = new vscode.CustomExecution(async () => new TaskTerminal((signal, write) => this.execute(action, uri, signal, write)));
    const task = new vscode.Task(definition, scope, `${action}: ${path.basename(uri.fsPath)}`, 'Nexa', execution);
    if (action === 'build') task.group = vscode.TaskGroup.Build;
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, focus: false };
    return task;
  }

  private async execute(action: TaskAction, uri: vscode.Uri, signal: AbortSignal, write: (text: string) => void): Promise<number> {
    requireTrust(vscode.workspace.isTrusted);
    if (this.disposed || signal.aborted) return 130;
    const key = uri.toString();
    if (this.active.has(key)) throw new Error('A Nexa task is already running for this file.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.active.set(key, { controller, uri, action });
    this.changeEmitter.fire();
    try {
      const document = await savedDocument(uri);
      if (signal.aborted || controller.signal.aborted) return 130;
      if (languageVersion(document.getText()) === '3.0') {
        if (!this.openExecute) throw new Error('Open Programs commands are unavailable.');
        return await this.openExecute(action, document, controller.signal, write);
      }
      const settings = settingsFor(uri);
      write(`Nexa ${action}: ${uri.fsPath}\nWorking directory: ${settings.cwd}\n\n`);
      const result = await this.runner.run({
        executable: settings.executable, args: [...settings.args, action, uri.fsPath, '--harness', settings.harnessMode],
        cwd: settings.cwd, env: processEnvironment(settings, true), timeoutMs: settings.taskTimeoutMs, maxOutputBytes: settings.maxOutputBytes,
      }, { signal: controller.signal, onOutput: text => write(text) });
      return this.complete(action, uri, result, write);
    } finally {
      signal.removeEventListener('abort', abort);
      this.active.delete(key);
      this.changeEmitter.fire();
    }
  }

  private complete(action: TaskAction, uri: vscode.Uri, result: CliResult, write: (text: string) => void): number {
    const message = `${action} ${path.basename(uri.fsPath)}: ${describeResult(result)}`;
    write(`\n[Nexa] ${message}\n`);
    this.output.appendLine(message);
    if (result.kind === 'spawnError') void vscode.window.showErrorMessage(`Nexa: ${describeResult(result)}`);
    return taskExitCode(result);
  }

  provideTasks(): vscode.Task[] {
    if (!vscode.workspace.isTrusted) return [];
    return vscode.workspace.textDocuments
      .filter(document => document.uri.scheme === 'file' && isSourceFile(document.uri.fsPath))
      .flatMap(document => [this.create('build', document.uri), this.create('run', document.uri)]);
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const { command, file } = task.definition;
    if ((command !== 'build' && command !== 'run') || typeof file !== 'string') return undefined;
    if (typeof task.scope !== 'object' || task.scope.uri.scheme !== 'file') return undefined;
    const folder = task.scope.uri.fsPath;
    const execution = new vscode.CustomExecution(async resolved => {
      if (typeof resolved.file !== 'string') throw new Error('A Nexa task requires a file path.');
      const uri = vscode.Uri.file(path.resolve(folder, resolved.file));
      return new TaskTerminal((signal, write) => this.execute(command, uri, signal, write));
    });
    const resolved = new vscode.Task(task.definition, task.scope, task.name, 'Nexa', execution, task.problemMatchers);
    resolved.presentationOptions = task.presentationOptions;
    resolved.runOptions = task.runOptions;
    resolved.isBackground = task.isBackground;
    if (task.group) resolved.group = task.group;
    if (task.detail) resolved.detail = task.detail;
    return resolved;
  }

  async stop(): Promise<void> {
    const tasks = [...this.active.values()];
    if (!tasks.length) return;
    if (tasks.length === 1) { tasks[0]!.controller.abort(); return; }
    const selected = await vscode.window.showQuickPick([
      { label: 'Stop all Nexa tasks', task: undefined },
      ...tasks.map(task => ({ label: `${task.action}: ${path.basename(task.uri.fsPath)}`, description: task.uri.fsPath, task })),
    ], { placeHolder: 'Choose the Nexa task to stop' });
    if (!selected) return;
    if (selected.task) selected.task.controller.abort();
    else for (const task of tasks) task.controller.abort();
  }

  dispose(): void {
    this.disposed = true;
    for (const task of this.active.values()) task.controller.abort();
    this.changeEmitter.dispose();
  }
}
