import * as vscode from 'vscode';
import { CliRunner } from './cli';
import { registerCommands } from './commands';
import { NexaDiagnostics } from './diagnostics';
import { isSourceFile } from './resources';
import { NexaSymbols } from './symbols';
import { NexaTasks } from './tasks';
import { errorText, hasDirtySources, relatedDocuments } from './workspace';
import { OpenServices } from './openServices';
import { OpenWorkbench } from './openWorkbench';

let currentRunner: CliRunner | undefined;
let openServices: OpenServices | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Nexa');
  const runner = new CliRunner();
  currentRunner = runner;
  const services = new OpenServices(context.extensionPath);
  openServices = services;
  const open = new OpenWorkbench(context, services, runner, output);
  const diagnostics = new NexaDiagnostics(runner, output, services);
  const symbols = new NexaSymbols(runner, output, services);
  const tasks = new NexaTasks(runner, output, (action, document, signal, write) => open.execute(action, document, signal, write));
  const status = vscode.window.createStatusBarItem('nexa.status', vscode.StatusBarAlignment.Left, 25);
  status.name = 'Nexa';
  context.subscriptions.push(output, runner, services, open, diagnostics, symbols, tasks, status);
  open.register(diagnostics);
  registerCommands(context, tasks, diagnostics, symbols);
  context.subscriptions.push(vscode.tasks.registerTaskProvider('nexa', tasks));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider({ language: 'nexa', scheme: 'file' }, symbols));

  const updateStatus = () => {
    const document = vscode.window.activeTextEditor?.document;
    void vscode.commands.executeCommand('setContext', 'nexa.hasRunningTasks', tasks.count > 0);
    if (!tasks.count && (!document || !isSourceFile(document.uri.fsPath))) { status.hide(); return; }
    status.text = tasks.count ? `$(sync~spin) Nexa: ${tasks.count} running` : vscode.workspace.isTrusted ? '$(checklist) Nexa' : '$(shield) Nexa: Restricted';
    status.tooltip = tasks.count ? 'Stop a running Nexa task' : document && hasDirtySources(document) ? 'Save Nexa sources in this folder to refresh diagnostics' : 'Validate the active Nexa file';
    status.command = tasks.count ? 'nexa.stop' : 'nexa.validate';
    status.accessibilityInformation = { label: tasks.count ? `Nexa, ${tasks.count} tasks running. Activate to stop.` : status.tooltip, role: 'button' };
    status.show();
  };
  const check = (document: vscode.TextDocument) => {
    void diagnostics.check(document).catch(error => output.appendLine(`Nexa check failed: ${errorText(error)}`));
  };
  const refresh = () => {
    for (const document of vscode.workspace.textDocuments) {
      symbols.invalidate(document);
      diagnostics.invalidate(document);
      check(document);
    }
    updateStatus();
  };
  context.subscriptions.push(
    tasks.onDidChange(updateStatus),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidSaveTextDocument(() => refresh()),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (!isSourceFile(document.uri.fsPath)) return;
      for (const related of relatedDocuments(document)) { diagnostics.invalidate(related); symbols.invalidate(related); }
      open.invalidateDocument(document);
      updateStatus();
    }),
    vscode.workspace.onDidCloseTextDocument(document => { diagnostics.invalidate(document); symbols.invalidate(document); if (document.uri.scheme === 'file' && isSourceFile(document.uri.fsPath)) open.invalidateDocument(document); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('nexa')) { services.reset(); open.invalidate(); runner.stopAll(); refresh(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { services.reset(); open.invalidate(); refresh(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(refresh),
  );
  refresh();
}

export async function deactivate(): Promise<void> {
  const runner = currentRunner;
  currentRunner = undefined;
  await openServices?.shutdown(); openServices = undefined;
  await runner?.shutdown();
}
