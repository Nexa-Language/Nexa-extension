import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CliRunner, describeResult, type CliResult } from './cli';
import { processEnvironment } from './config';
import type { NexaDiagnostics } from './diagnostics';
import { environmentArgs, executionArgs } from './openConfig';
import { DraftSync, requireNoExternalAnswer, type PendingSync } from './openDraft';
import { languageVersion, parseCheckReport, record, sameProgram, textField, type Activity, type CheckReport, type JsonObject, type Revision, type Snapshot } from './openProtocol';
import { OpenServices, openSettingsFor } from './openServices';
import { OpenDiffs, OpenView } from './openView';
import { requireTrust } from './resources';
import { errorText, savedDocument, settingsFor } from './workspace';

export class OpenWorkbench implements vscode.Disposable {
  readonly view = new OpenView();
  readonly diffs = new OpenDiffs();
  private readonly drafts: DraftSync;
  private readonly reports = new Map<string, CheckReport>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly busy = new Set<string>();
  private epoch = 0;
  private diagnostics: NexaDiagnostics | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly services: OpenServices,
    private readonly runner: CliRunner, private readonly output: vscode.OutputChannel) {
    this.drafts = new DraftSync(context.workspaceState);
  }

  register(diagnostics: NexaDiagnostics): void {
    this.diagnostics = diagnostics;
    this.context.subscriptions.push(vscode.window.registerTreeDataProvider('nexa.openPrograms', this.view),
      vscode.workspace.registerTextDocumentContentProvider('nexa-review', this.diffs),
      vscode.commands.registerCommand('nexa.open.details', (value: unknown) => this.details(value)));
    const actions: Record<string, (document: vscode.TextDocument) => Promise<unknown>> = {
      check: document => this.check(document), status: document => this.refresh(document),
      buildLocked: document => this.execute('locked', document), resolve: document => this.resolve(document),
      revise: document => this.execute('revise', document), maintain: document => this.execute('maintain', document),
      cancel: document => this.cancel(document), answer: document => this.answer(document), syncSource: document => this.sync(document),
      proposal: document => this.proposal(document, false), apply: document => this.proposal(document, true),
      recover: document => this.recover(document), resumeApply: document => this.proposal(document, true, true),
      capsuleImport: document => this.capsule(document, false), capsuleExport: document => this.capsule(document, true),
    };
    for (const [name, action] of Object.entries(actions)) this.context.subscriptions.push(vscode.commands.registerCommand(`nexa.open.${name}`, async (uri?: vscode.Uri) => {
      let lockedKey: string | undefined;
      try {
        const document = await this.commandDocument(uri);
        if (languageVersion(document.getText()) !== '3.0') throw new Error('This command requires a language "3.0" program.');
        if (!['check', 'status', 'cancel', 'buildLocked', 'revise', 'maintain'].includes(name)) {
          lockedKey = this.key(document.uri);
          if (this.busy.has(lockedKey)) { lockedKey = undefined; throw new Error('An Open Programs operation is already running for this source.'); }
          this.busy.add(lockedKey);
        }
        return await action(document);
      } catch (error) { this.output.appendLine(errorText(error)); void vscode.window.showErrorMessage(`Nexa: ${errorText(error)}`); return undefined; }
      finally { if (lockedKey) this.busy.delete(lockedKey); }
    }));
  }

  private async commandDocument(uri?: vscode.Uri): Promise<vscode.TextDocument> {
    if (uri instanceof vscode.Uri) return savedDocument(uri);
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === 'nexa') return savedDocument(active.uri);
    const choices = vscode.workspace.textDocuments.filter(document => document.languageId === 'nexa' && !document.isClosed);
    const selected = await vscode.window.showQuickPick(choices.map(document => ({ label: vscode.workspace.asRelativePath(document.uri, true), document })), { title: 'Choose the Open Program source' });
    if (!selected) throw new Error('Select a saved Open Program source.');
    return savedDocument(selected.document.uri);
  }

  private key(uri: vscode.Uri): string {
    const settings = openSettingsFor(uri);
    return `nexa.open.pending:${JSON.stringify([settings.state, settings.programId, uri.toString()])}`;
  }
  private guard(document: vscode.TextDocument): () => void {
    requireTrust(vscode.workspace.isTrusted);
    const epoch = this.epoch; const version = document.version;
    const config = JSON.stringify([settingsFor(document.uri), openSettingsFor(document.uri)]);
    return () => {
      requireTrust(vscode.workspace.isTrusted);
      if (epoch !== this.epoch || document.isClosed || document.isDirty || document.version !== version ||
        config !== JSON.stringify([settingsFor(document.uri), openSettingsFor(document.uri)])) throw new Error('Source or workspace configuration changed; refresh the operation.');
    };
  }
  private publish(document: vscode.TextDocument, result?: unknown, message?: string): void {
    const report = this.reports.get(document.uri.toString()); const snapshot = this.snapshots.get(document.uri.toString());
    this.view.set({ uri: document.uri, ...(report ? { report } : {}), ...(snapshot ? { snapshot } : {}),
      pending: Boolean(this.drafts.pending(this.key(document.uri))), ...(result === undefined ? {} : { result }), ...(message ? { message } : {}) });
  }
  async check(document: vscode.TextDocument): Promise<CheckReport> {
    const fresh = this.guard(document);
    const report = await this.services.check(document);
    fresh(); await this.diagnostics?.acceptOpenReport(document, report); fresh();
    this.reports.set(document.uri.toString(), report); this.publish(document);
    return report;
  }
  async refresh(document: vscode.TextDocument): Promise<Snapshot> {
    const fresh = this.guard(document); const settings = openSettingsFor(document.uri);
    const bridge = await this.services.client(document.uri, 'bridge');
    const snapshot = await bridge.request('snapshot', { program_id: settings.programId }) as Snapshot;
    fresh(); this.snapshots.set(document.uri.toString(), snapshot); this.publish(document);
    return snapshot;
  }
  private async revision(document: vscode.TextDocument, digest: string): Promise<Revision> {
    const bridge = await this.services.client(document.uri, 'bridge');
    return await bridge.request('revision', { program_id: openSettingsFor(document.uri).programId, object_id: digest }) as Revision;
  }
  private async ensureDraft(document: vscode.TextDocument): Promise<Revision> {
    this.drafts.requireSynchronized(this.key(document.uri));
    const fresh = this.guard(document); const report = await this.check(document);
    if (!report.program || report.diagnostics.some(row => row.severity === 'error')) throw new Error('Fix source diagnostics before proposing a revision.');
    // A check session creates the native state store before the read-only bridge opens it.
    const snapshot = await this.refresh(document);
    requireNoExternalAnswer(snapshot, report.program);
    if (snapshot.draft && sameProgram(snapshot.draft.program, report.program)) return snapshot.draft;
    const client = await this.services.client(document.uri, 'check'); fresh();
    const result = record(await client.request('revision/propose', { program_id: openSettingsFor(document.uri).programId,
      expected_revision: snapshot.draft?.digest ?? null, source: document.getText(), path: document.uri.fsPath }));
    fresh(); const draft = await this.revision(document, textField(result, 'revision')); fresh();
    await this.refresh(document); return draft;
  }

  private async invoke(document: vscode.TextDocument, args: string[], signal?: AbortSignal, write?: (text: string) => void): Promise<JsonObject> {
    const fresh = this.guard(document); const cli = settingsFor(document.uri);
    const result = await this.runner.run({ executable: cli.executable, args: [...cli.args, ...args], cwd: cli.cwd,
      env: processEnvironment(cli, true), timeoutMs: cli.taskTimeoutMs, maxOutputBytes: cli.maxOutputBytes }, signal ? { signal } : {});
    fresh();
    if (result.kind !== 'exited') throw new Error(`${describeResult(result)} Runtime cancellation requires selecting its activity ID in Cancel Activity.`);
    const value = this.cliValue(result);
    write?.(`${JSON.stringify(value, null, 2)}\n`);
    this.publish(document, value, result.code ? 'Operation blocked or failed' : 'Operation completed');
    if (result.code !== 0) { await this.details(value); throw new Error(`Nexa operation failed: ${String(value.error ?? value.status ?? 'see operation details')}.`); }
    return value;
  }
  private cliValue(result: CliResult): JsonObject {
    try { return record(JSON.parse(result.stdout || result.stderr)); }
    catch { throw new Error('Nexa returned an invalid JSON response. Verify the configured CLI is Nexa 3.0.0.'); }
  }

  async execute(action: 'build' | 'locked' | 'run' | 'revise' | 'maintain', document: vscode.TextDocument,
    signal?: AbortSignal, write?: (text: string) => void): Promise<number> {
    const key = this.key(document.uri); this.drafts.requireSynchronized(key);
    if (this.busy.has(key)) throw new Error('An Open Programs operation is already running for this source.');
    this.busy.add(key);
    try {
      const fresh = this.guard(document); const settings = openSettingsFor(document.uri);
      const draft = await this.ensureDraft(document); fresh();
      let args: string[];
      if (action === 'build' || action === 'locked') args = ['build', document.uri.fsPath, ...executionArgs(settings), ...(action === 'locked' ? ['--locked'] : [])];
      else {
        args = [...(action === 'revise' ? ['open', 'revise'] : ['run']), document.uri.fsPath, ...executionArgs(settings), '--program-id', settings.programId, '--expected-revision', draft.digest];
        if (settings.capsule && action !== 'revise') args.push('--capsule', settings.capsule);
        if (action === 'run') {
          const goal = await this.goal(document, draft.program.goals); if (!goal) return 130;
          args.push('--goal', goal);
          const input = await vscode.window.showOpenDialog({ title: 'Optional JSON goal inputs (cancel for {})', canSelectMany: false, filters: { JSON: ['json'] } });
          if (input?.[0]) args.push('--input', input[0].fsPath);
        }
        if (action === 'maintain') { const extra = await this.maintenanceArgs(); if (!extra) return 130; args.push(...extra); }
      }
      fresh();
      if (!write) void vscode.window.showInformationMessage(`Nexa ${action}: ${settings.environment}; ${settings.maxModelCalls} model calls, ${settings.maxTokens} tokens, ${settings.timeoutSeconds}s. OCI required.`);
      write?.(`Environment: ${settings.environment}\nState: ${settings.state}\nProgram: ${settings.programId}\nBudget: ${settings.maxModelCalls} model calls, ${settings.maxTokens} tokens, ${settings.timeoutSeconds}s. OCI required.\n`);
      const result = await this.invoke(document, args, signal, write);
      if (typeof result.proposal_id === 'string') await this.context.workspaceState.update(`${key}:proposal`, result.proposal_id);
      await this.refresh(document); this.publish(document, result);
      return 0;
    } finally { this.busy.delete(key); }
  }
  private async maintenanceArgs(): Promise<string[] | undefined> {
    const repository = await vscode.window.showOpenDialog({ title: 'Repository to maintain', canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
    if (!repository?.[0]) return;
    const paths = await vscode.window.showInputBox({ title: 'Selected repository paths', prompt: 'Comma-separated relative paths; runtime enforces this exact scope' });
    if (!paths?.trim()) return;
    const request = await vscode.window.showInputBox({ title: 'Change request', ignoreFocusOut: true });
    if (!request?.trim()) return;
    const event = await vscode.window.showInputBox({ title: 'Maintenance event', value: 'change_request' }); if (!event) return;
    return ['--repository', repository[0].fsPath, ...paths.split(',').flatMap(value => ['--include', value.trim()]), '--request', request, '--event', event];
  }
  private async goal(document: vscode.TextDocument, goals: {name: string}[]): Promise<string | undefined> {
    return vscode.window.showQuickPick(goals.map(goal => goal.name), { title: `Goal in ${path.basename(document.uri.fsPath)}` });
  }
  private async resolve(document: vscode.TextDocument): Promise<void> {
    const fresh = this.guard(document); const draft = await this.ensureDraft(document);
    const goal = await this.goal(document, draft.program.goals); if (!goal) return;
    const input = await vscode.window.showInputBox({ title: 'Named goal inputs (JSON object)', value: '{}' }); if (input === undefined) return;
    record(JSON.parse(input), 'goal inputs');
    const settings = openSettingsFor(document.uri);
    void vscode.window.showInformationMessage(`Nexa resolve: ${settings.environment}; ${settings.maxModelCalls} model calls, ${settings.maxTokens} tokens, ${settings.timeoutSeconds}s. OCI required for candidates.`);
    const author = await this.services.client(document.uri, 'author'); fresh();
    const result = await author.request('goal/resolve', { program_id: settings.programId, expected_revision: draft.digest, goal, input_json: input,
      budget: { max_model_calls: settings.maxModelCalls, max_tokens: settings.maxTokens, timeout_seconds: settings.timeoutSeconds } });
    fresh(); await this.refresh(document); this.publish(document, result, 'Author activity started; Refresh Status to read progress');
  }
  private async chooseActivity(document: vscode.TextDocument, kind?: 'author' | 'runtime'): Promise<{kind: 'author' | 'runtime'; activity: Activity} | undefined> {
    const snapshot = await this.refresh(document);
    const choices = [ ...(kind === 'runtime' ? [] : snapshot.author_activities.map(activity => ({ kind: 'author' as const, activity }))),
      ...(kind === 'author' ? [] : snapshot.runtime_activities.map(activity => ({ kind: 'runtime' as const, activity }))) ];
    const selected = await vscode.window.showQuickPick(choices.map(choice => ({ choice, label: `${choice.kind}: ${choice.activity.goal} · ${choice.activity.state}`,
      description: choice.activity.activity_id, detail: `Pinned revision ${choice.activity.revision}` })), { title: 'Select the exact activity ID' });
    return selected?.choice;
  }
  private async cancel(document: vscode.TextDocument): Promise<void> {
    const fresh = this.guard(document); const selected = await this.chooseActivity(document); if (!selected) return;
    fresh(); const settings = openSettingsFor(document.uri);
    const result = selected.kind === 'runtime' ? await this.invoke(document, ['open', 'cancel', selected.activity.activity_id, ...environmentArgs(settings)]) :
      await (await this.services.client(document.uri, 'check')).request('activity/cancel', { object_id: selected.activity.activity_id });
    fresh(); await this.refresh(document); this.publish(document, result, 'Cancellation recorded; displayed state is the durable runtime result');
  }

  private async answer(document: vscode.TextDocument): Promise<void> {
    const key = this.key(document.uri); this.drafts.requireSynchronized(key);
    const fresh = this.guard(document); const selected = await this.chooseActivity(document, 'author'); if (!selected) return;
    if (!selected.activity.request_id) throw new Error('Select an author activity with a clarification request.');
    const answer = await vscode.window.showInputBox({ title: 'Answer clarification', prompt: String(selected.activity.result?.clarification ?? ''), ignoreFocusOut: true });
    if (!answer?.trim()) return;
    const report = await this.check(document); const snapshot = await this.refresh(document); fresh();
    if (!snapshot.draft || !sameProgram(report.program, snapshot.draft.program)) throw new Error('Source and current draft differ; reconcile before answering.');
    const author = await this.services.client(document.uri, 'check'); fresh();
    await this.drafts.answer(key, { file: document.uri.fsPath, source: document.getText(), version: document.version, draft: snapshot.draft,
      ...(report.program ? { sourceProgram: report.program } : {}), activity: selected.activity, answer },
      () => author.request('author/answer', { program_id: openSettingsFor(document.uri).programId, expected_revision: snapshot.draft!.digest, request_id: selected.activity.request_id, answer }));
    fresh(); await this.refresh(document); await this.sync(document);
  }
  private async pendingRevision(document: vscode.TextDocument, key: string, pending: PendingSync): Promise<PendingSync> {
    if (pending.revision) return pending;
    const snapshot = await this.refresh(document);
    const event = snapshot.events.find(item => item.event.kind === 'author_answered' && item.event.detail === pending.requestId);
    if (event) return this.drafts.bindRevision(key, event.event.object_id);
    // An interrupted RPC may not have executed. Retry only with the original CAS and exact request ID.
    const client = await this.services.client(document.uri, 'check');
    const result = record(await client.request('author/answer', { program_id: openSettingsFor(document.uri).programId,
      expected_revision: pending.expectedRevision, request_id: pending.requestId, answer: pending.answer }));
    return this.drafts.bindRevision(key, textField(result, 'revision'));
  }
  private async sync(document: vscode.TextDocument): Promise<void> {
    const key = this.key(document.uri); const initial = this.drafts.pending(key);
    if (!initial) throw new Error('No pending clarification source synchronization.');
    const fresh = this.guard(document); const pending = await this.pendingRevision(document, key, initial);
    const before = await this.revision(document, pending.expectedRevision); const after = await this.revision(document, pending.revision!);
    const proposed = this.drafts.sourceFor(pending, before, after);
    const author = await this.services.client(document.uri, 'check');
    const checked = parseCheckReport(await author.request('program/check', { source: proposed, path: document.uri.fsPath }));
    if (!sameProgram(checked.program, after.program)) throw new Error('Native IR validation failed for the proposed intent edit.');
    fresh();
    if (document.getText() !== proposed) this.drafts.assertSource(pending, document.getText());
    if ((await readFile(document.uri.fsPath, 'utf8')) !== document.getText()) throw new Error('Source changed on disk; pending clarification is preserved.');
    await this.diffs.show(path.basename(document.uri.fsPath), document.getText(), proposed);
    const selected = await vscode.window.showWarningMessage('Apply this intent-only clarification to the source and synchronize the current draft?', { modal: true }, 'Synchronize Source');
    if (selected !== 'Synchronize Source') { this.publish(document); return; }
    fresh(); const current = await this.refresh(document);
    if (current.draft && current.draft.parent === pending.revision && sameProgram(current.draft.program, checked.program) && document.getText() === proposed) {
      await this.drafts.clear(key); await this.refresh(document); return;
    }
    if (current.draft?.digest !== pending.revision) throw new Error('Draft revision changed; pending source synchronization is preserved.');
    if ((await readFile(document.uri.fsPath, 'utf8')) !== document.getText()) throw new Error('Source changed on disk; synchronization stopped.');
    const editor = await vscode.window.showTextDocument(document); fresh();
    if (document.getText() !== proposed) {
      const applied = await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), proposed));
      if (!applied || !(await document.save())) throw new Error('Source edit or save failed; pending synchronization is preserved.');
    }
    const synchronized = this.guard(document);
    if (document.getText() !== proposed || (await readFile(document.uri.fsPath, 'utf8')) !== proposed) throw new Error('Source changed during synchronization.');
    const result = record(await author.request('revision/propose', { program_id: openSettingsFor(document.uri).programId, expected_revision: pending.revision, source: proposed, path: document.uri.fsPath }));
    textField(result, 'revision');
    synchronized(); await this.drafts.clear(key); await this.refresh(document); await this.check(document);
  }

  private async proposalId(document: vscode.TextDocument): Promise<string | undefined> {
    return vscode.window.showInputBox({ title: 'Exact patch proposal digest', value: this.context.workspaceState.get<string>(`${this.key(document.uri)}:proposal`) ?? '' });
  }
  private async proposal(document: vscode.TextDocument, apply: boolean, resume = false): Promise<void> {
    const fresh = this.guard(document); const id = await this.proposalId(document); if (!id) return;
    const settings = openSettingsFor(document.uri); const bridge = await this.services.client(document.uri, 'bridge');
    const proposal = record(await bridge.request('proposal', { object_id: id, program_id: settings.programId }));
    const baseline = record(proposal.baseline); const files = baseline.files as JsonObject[]; const changes = proposal.changes as JsonObject[];
    for (const change of changes) {
      const before = files.find(file => file.path === change.path);
      await this.diffs.show(String(change.path), String(before?.content ?? ''), String(change.content ?? ''));
    }
    const evidence = await this.invoke(document, ['open', 'evidence', id, ...environmentArgs(settings)]); fresh();
    await this.details({ proposal_id: id, diff: proposal.diff, evidence });
    if (!apply) return;
    const approved = await vscode.window.showWarningMessage(`Authorize exact proposal ${id} for ${changes.length} path(s) in ${String(baseline.root)}?\nThis issues a 10-minute grant and applies the reviewed patch.`, { modal: true }, resume ? 'Resume Exact Patch' : 'Authorize and Apply');
    if (approved !== (resume ? 'Resume Exact Patch' : 'Authorize and Apply')) return;
    fresh(); this.assertCleanPatch(baseline, changes);
    const actor = await vscode.window.showInputBox({ title: 'Approval actor', value: 'local-operator', prompt: 'Recorded in the exact proposal grant' }); if (!actor?.trim()) return;
    fresh(); this.assertCleanPatch(baseline, changes);
    const grant = await this.invoke(document, ['open', 'approve', id, '--actor', actor, '--expires-in', '600', '--state', settings.state]);
    fresh(); this.assertCleanPatch(baseline, changes);
    const result = await this.invoke(document, ['open', 'apply', id, '--grant', textField(grant, 'grant_id'), ...environmentArgs(settings), ...(resume ? ['--resume'] : [])]);
    await this.refresh(document); this.publish(document, { grant, result });
  }
  private assertCleanPatch(baseline: JsonObject, changes: JsonObject[]): void {
    const paths = changes.map(change => path.resolve(String(baseline.root), String(change.path)));
    if (vscode.workspace.textDocuments.some(document => document.isDirty && paths.includes(document.uri.fsPath))) throw new Error('Save or reconcile unsaved target files before approving this patch.');
  }
  private async recover(document: vscode.TextDocument): Promise<void> {
    const fresh = this.guard(document); const settings = openSettingsFor(document.uri);
    const choice = await vscode.window.showQuickPick(['Resume program state', 'Recover patch journal'], { title: 'Recover persistent Open Programs state' }); if (!choice) return;
    const id = choice === 'Recover patch journal' ? await this.proposalId(document) : settings.programId; if (!id) return;
    fresh(); const result = await this.invoke(document, choice === 'Recover patch journal' ? ['open', 'recover', id, '--state', settings.state] : ['open', 'resume', id, ...environmentArgs(settings)]);
    await this.refresh(document); this.publish(document, result); await this.details(result);
  }
  private async capsule(document: vscode.TextDocument, exporting: boolean): Promise<void> {
    const fresh = this.guard(document); const settings = openSettingsFor(document.uri);
    let args: string[];
    if (exporting) {
      const selected = await this.chooseActivity(document, 'runtime'); if (!selected) return;
      const target = await vscode.window.showSaveDialog({ title: 'Export activity capsule', filters: { JSON: ['json'] } }); if (!target) return;
      const source = await vscode.window.showInputBox({ title: 'Capsule origin source' }); if (!source) return;
      const creator = await vscode.window.showInputBox({ title: 'Capsule creator' }); if (!creator) return;
      const license = await vscode.window.showInputBox({ title: 'Capsule license' }); if (!license) return;
      args = ['open', 'capsule', 'export', target.fsPath, '--activity', selected.activity.activity_id, '--source', source, '--creator', creator, '--license', license];
    } else {
      const files = await vscode.window.showOpenDialog({ title: 'Import capsule', canSelectMany: false, filters: { JSON: ['json'] } }); if (!files?.[0]) return;
      args = ['open', 'capsule', 'import', files[0].fsPath];
    }
    fresh(); const result = await this.invoke(document, [...args, '--state', settings.state]); await this.details(result);
  }
  private async details(value: unknown): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(value, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }
  invalidate(): void { this.epoch++; this.reports.clear(); this.snapshots.clear(); this.view.clear(); }
  invalidateDocument(document: vscode.TextDocument): void {
    this.reports.delete(document.uri.toString()); this.snapshots.delete(document.uri.toString()); this.view.delete(document.uri);
  }
  dispose(): void { this.invalidate(); this.view.dispose(); }
}
