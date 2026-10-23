import * as vscode from 'vscode';
import { resolveSettings, type CliSettings, type ResourceContext } from './config';
import { prepareDocument } from './resources';

const settingNames = [
  'executablePath', 'executableArgs', 'executable', 'harnessMode', 'proxyUrl',
  'diagnostics.enabled', 'diagnostics.delayMs', 'checkTimeoutMs', 'taskTimeoutMs', 'maxOutputBytes',
] as const;

export function resourceContext(uri: vscode.Uri): ResourceContext {
  const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  return { file: uri.fsPath, ...(folder ? { folder } : {}) };
}

export function settingsFor(uri: vscode.Uri): CliSettings {
  const config = vscode.workspace.getConfiguration('nexa', uri);
  const raw: Record<string, unknown> = {};
  for (const name of settingNames) raw[name] = config.get(name);
  return resolveSettings(raw, resourceContext(uri));
}

export async function savedDocument(uri?: vscode.Uri): Promise<vscode.TextDocument> {
  const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!document) throw new Error('Open a .nx or .nxlib source file first.');
  await prepareDocument(document, () => vscode.workspace.isTrusted);
  if (hasDirtySources(document)) throw new Error('Save the other Nexa source files in this workspace folder before running a command.');
  return document;
}

export function relatedDocuments(document: vscode.TextDocument): vscode.TextDocument[] {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString();
  if (!folder) return [document];
  return vscode.workspace.textDocuments.filter(other => vscode.workspace.getWorkspaceFolder(other.uri)?.uri.toString() === folder);
}

export function hasDirtySources(document: vscode.TextDocument): boolean {
  return relatedDocuments(document).some(other => other.isDirty && /\.(nx|nxlib)$/i.test(other.uri.fsPath));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
