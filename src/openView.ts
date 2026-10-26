import * as vscode from 'vscode';
import type { CheckReport, JsonObject, Snapshot } from './openProtocol';

export interface OpenViewState { uri: vscode.Uri; report?: CheckReport; snapshot?: Snapshot; pending?: boolean; message?: string; result?: unknown }
interface Row { label: string; description?: string; children?: Row[]; value?: unknown }

export class OpenView implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly states = new Map<string, OpenViewState>();
  set(state: OpenViewState): void { this.states.set(state.uri.toString(), state); this.changed.fire(undefined); }
  delete(uri: vscode.Uri): void { this.states.delete(uri.toString()); this.changed.fire(undefined); }
  clear(): void { this.states.clear(); this.changed.fire(undefined); }
  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, row.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    if (row.description) item.description = row.description;
    if (row.value !== undefined) item.command = { command: 'nexa.open.details', title: 'View Details', arguments: [row.value] };
    return item;
  }
  getChildren(row?: Row): Row[] {
    if (row) return row.children ?? [];
    if (!this.states.size) return [{ label: 'Open a 3.0 program, then Check or Refresh Status' }];
    return [...this.states.values()].map(state => ({ label: vscode.workspace.asRelativePath(state.uri, true), description: state.message ?? '', children: this.rows(state) }));
  }
  private rows(state: OpenViewState): Row[] {
    const snapshot = state.snapshot;
    const program = state.report?.program ?? snapshot?.draft?.program;
    const rows: Row[] = [
      { label: 'Draft revision', description: snapshot?.draft?.digest ?? 'Not proposed', value: snapshot?.draft },
      { label: 'Runtime revision', description: String(snapshot?.runtime?.revision ?? 'Inactive'), value: snapshot?.runtime },
      { label: state.pending ? 'Clarification: source synchronization pending' : 'Source synchronization: no pending answer' },
      { label: 'Goals', children: program?.goals.map(goal => ({ label: goal.name, description: `${goal.stage ?? 'build'} · ${goal.implementation ? 'explicit' : 'open'}`, value: goal })) ?? [] },
      { label: 'Open obligations', children: state.report?.obligations.map(label => ({ label })) ?? [] },
    ];
    for (const [label, activities] of [['Author activities', snapshot?.author_activities], ['Runtime activities', snapshot?.runtime_activities]] as const) {
      rows.push({ label, children: activities?.map(activity => ({ label: `${activity.goal}: ${activity.state}`, description: activity.activity_id,
        value: activity, children: [{ label: 'Pinned revision', description: activity.revision },
          ...(activity.request_id ? [{ label: 'Clarification', description: activity.request_id, value: activity.result }] : []),
          ...((activity.result?.evidence as JsonObject[] | undefined) ?? []).map(evidence => ({ label: `Evidence: ${String(evidence.kind)}`, description: evidence.passed ? 'passed' : 'failed', value: evidence })),
        ] })) ?? [] });
    }
    if (state.result !== undefined) rows.push({ label: 'Last explicit operation / evidence validity', value: state.result });
    return rows;
  }
  dispose(): void { this.changed.dispose(); this.states.clear(); }
}

export class OpenDiffs implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private next = 0;
  provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? ''; }
  async show(name: string, before: string, after: string): Promise<void> {
    const id = ++this.next;
    const original = vscode.Uri.from({ scheme: 'nexa-review', path: `/${id}/before/${name}` });
    const proposed = vscode.Uri.from({ scheme: 'nexa-review', path: `/${id}/after/${name}` });
    this.contents.set(original.toString(), before); this.contents.set(proposed.toString(), after);
    await vscode.commands.executeCommand('vscode.diff', original, proposed, `Nexa: ${name}`, { preview: true });
  }
}
