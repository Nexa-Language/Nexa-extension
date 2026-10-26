import * as path from 'node:path';
import * as vscode from 'vscode';
import { AuthorClient } from './author';
import { processEnvironment, type CliSettings } from './config';
import { environmentArgs, openSettingNames, resolveOpenSettings, type OpenSettings } from './openConfig';
import { AuthorEnvironment } from './openEnvironment';
import { parseCheckReport, type CheckReport } from './openProtocol';
import { requireTrust } from './resources';
import { settingsFor } from './workspace';

export function openSettingsFor(uri: vscode.Uri): OpenSettings {
  const config = vscode.workspace.getConfiguration('nexa.open', uri);
  return resolveOpenSettings(Object.fromEntries(openSettingNames.map(name => [name, config.get(name)])), settingsFor(uri), uri.fsPath);
}

interface Connection { client: AuthorClient; environment?: AuthorEnvironment }

export class OpenServices implements vscode.Disposable {
  private readonly clients = new Map<string, Promise<Connection>>();
  private readonly opening = new Set<Promise<Connection>>();
  private generation = 0;
  private readonly closing = new Set<Promise<void>>();
  constructor(private readonly extensionPath: string) {}

  async client(uri: vscode.Uri, mode: 'check' | 'author' | 'bridge'): Promise<AuthorClient> {
    requireTrust(vscode.workspace.isTrusted);
    const cli = settingsFor(uri);
    const settings = openSettingsFor(uri);
    if (!vscode.workspace.getWorkspaceFolder(uri)) throw new Error('Open Programs requires a trusted workspace folder.');
    if (mode === 'bridge' && !settings.pythonPath) throw new Error('Set nexa.open.pythonPath and optional pythonArgs to a Python environment with Nexa 3.0.0. No interpreter is inferred or installed.');
    const key = JSON.stringify([cli, settings, mode]);
    const generation = this.generation;
    const fresh = () => {
      if (generation !== this.generation || !vscode.workspace.isTrusted) throw new Error('Nexa workspace configuration or trust changed.');
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      let pending = this.clients.get(key);
      if (!pending) {
        const evict = () => { if (this.clients.get(key) === pending) this.clients.delete(key); };
        pending = this.create(cli, settings, mode, fresh, evict).catch(error => { evict(); throw error; });
        this.clients.set(key, pending);
        this.opening.add(pending);
        // Cache invalidation must not detach an unfinished capture from shutdown.
        const created = pending;
        void created.then(() => this.opening.delete(created), () => this.opening.delete(created));
      }
      const entry = await pending;
      try {
        fresh();
        if (entry.client.closed || (entry.environment && !(await entry.environment.matches()))) { entry.client.dispose(); continue; }
        await entry.client.initialize();
        await entry.environment?.assertCurrent(); fresh();
        return entry.client;
      } catch (error) { entry.client.dispose(); throw error; }
    }
    throw new Error('Nexa author environment changed during initialization. Resolve again.');
  }

  private async create(cli: CliSettings, settings: OpenSettings, mode: 'check' | 'author' | 'bridge', fresh: () => void,
    evict: () => void): Promise<Connection> {
    const environment = mode === 'author' ? await AuthorEnvironment.capture(environmentArgs(settings)[1]!) : undefined;
    try { fresh(); } catch (error) { await environment?.dispose(); throw error; }
    const args = mode === 'bridge' ? [...settings.pythonArgs, path.join(this.extensionPath, 'bridge', 'query.py'), '--state', settings.state] :
      [...cli.args, 'author', '--state', settings.state, ...(environment ? ['--environment', environment.snapshot] : []),
        ...(mode === 'author' && settings.dockerContext ? ['--docker-context', settings.dockerContext] : [])];
    const client = new AuthorClient({ executable: mode === 'bridge' ? settings.pythonPath : cli.executable, args, cwd: cli.cwd,
      env: processEnvironment(cli, false), timeoutMs: cli.checkTimeoutMs, maxOutputBytes: cli.maxOutputBytes },
    mode === 'bridge' ? ['snapshot', 'revision', 'proposal'] : undefined, {
      beforeSend: async () => { await environment?.assertCurrent(); fresh(); },
      closed: () => {
        evict();
        const closing = client.shutdown().then(() => environment?.dispose());
        this.closing.add(closing);
        // Retain failed cleanup promises so shutdown reports the failure.
        void closing.then(() => this.closing.delete(closing), () => undefined);
      },
    });
    return { client, ...(environment ? { environment } : {}) };
  }

  async check(document: vscode.TextDocument, signal?: AbortSignal): Promise<CheckReport> {
    const client = await this.client(document.uri, 'check');
    return parseCheckReport(await client.request('program/check', { source: document.getText(), path: document.uri.fsPath }, signal));
  }

  reset(): void {
    this.generation++;
    for (const entry of this.clients.values()) void entry.then(({ client }) => client.dispose(), () => undefined);
    this.clients.clear();
  }
  dispose(): void { this.reset(); }
  async shutdown(): Promise<void> {
    this.reset();
    while (this.opening.size) await Promise.allSettled(this.opening);
    await Promise.all(this.closing);
  }
}
