import * as vscode from 'vscode';
import type { NexaDiagnostics } from './diagnostics';
import type { NexaSymbols } from './symbols';
import type { NexaTasks } from './tasks';
import { errorText, savedDocument, settingsFor } from './workspace';

export function registerCommands(context: vscode.ExtensionContext, tasks: NexaTasks, diagnostics: NexaDiagnostics, symbols: NexaSymbols): void {
  const register = (name: string, action: (uri?: vscode.Uri) => Promise<unknown>) => {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (uri?: vscode.Uri) => {
      try { return await action(uri instanceof vscode.Uri ? uri : undefined); }
      catch (error) { void vscode.window.showErrorMessage(`Nexa: ${errorText(error)}`); return undefined; }
    }));
  };
  const prepare = async (uri?: vscode.Uri) => {
    const document = await savedDocument(uri);
    if (settingsFor(document.uri).legacy && !context.globalState.get('legacyCliNotice')) {
      void vscode.window.showInformationMessage('Nexa: Legacy executable configuration is supported. Move the executable to nexa.executablePath and arguments to nexa.executableArgs.');
      await context.globalState.update('legacyCliNotice', true);
    }
    return document;
  };
  register('nexa.build', async uri => tasks.start('build', (await prepare(uri)).uri));
  register('nexa.run', async uri => tasks.start('run', (await prepare(uri)).uri));
  register('nexa.stop', () => tasks.stop());
  for (const [command, kind] of [['nexa.validate', 'validate'], ['nexa.harnessCheck', 'harness']] as const) {
    register(command, async uri => {
      const document = await prepare(uri);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Nexa: ${kind}`, cancellable: true },
        async (_progress, token) => diagnostics.check(document, false, [kind], token));
      await vscode.commands.executeCommand('workbench.actions.view.problems');
    });
  }
  register('nexa.inspect', async uri => {
    const document = await prepare(uri);
    const inspection = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Nexa: Inspect', cancellable: true },
      async (_progress, token) => symbols.inspect(document, token));
    if (!inspection) return;
    const result = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(inspection.raw, null, 2) });
    await vscode.window.showTextDocument(result, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  });
}
