import { record, replaceIntent, sameProgram, sourceDigest, textField, type Activity, type Goal, type Program, type Revision, type Snapshot } from './openProtocol';

export interface PendingSync {
  file: string; source: string; sourceDigest: string; version: number; expectedRevision: string;
  requestId: string; goal: string; answer: string; revision?: string;
  sourceGoal?: Goal;
}
interface Storage { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }
interface AnswerInput { file: string; source: string; version: number; draft: Revision; sourceProgram?: Program; activity: Pick<Activity, 'revision' | 'request_id' | 'goal'>; answer: string }

export function requireNoExternalAnswer(snapshot: Pick<Snapshot, 'draft' | 'events'>, sourceProgram: unknown): void {
  if (!snapshot.draft || sameProgram(snapshot.draft.program, sourceProgram)) return;
  if (snapshot.events.some(item => item.event.kind === 'author_answered' && item.event.object_id === snapshot.draft?.digest)) {
    throw new Error('The current draft contains a clarification from another author client. Complete its source synchronization before replacing the draft.');
  }
}

export class DraftSync {
  constructor(private readonly storage: Storage) {}
  pending(key: string): PendingSync | undefined { return this.storage.get<PendingSync>(key); }
  requireSynchronized(key: string): void {
    if (this.pending(key)) throw new Error('Clarification source synchronization is pending. Use Nexa: Synchronize Clarification Source before build, run, resolve or revise.');
  }
  async answer(key: string, input: AnswerInput, send: () => Promise<unknown>): Promise<PendingSync> {
    this.requireSynchronized(key);
    if (input.activity.revision !== input.draft.digest || !input.activity.request_id || !input.answer.trim()) throw new Error('Clarification requires the exact current draft, request ID and a nonempty answer.');
    if (input.sourceProgram && !sameProgram(input.sourceProgram, input.draft.program)) throw new Error('Native source IR differs from the current draft.');
    const sourceGoal = input.sourceProgram?.goals.find(goal => goal.name === input.activity.goal);
    const pending: PendingSync = { file: input.file, source: input.source, sourceDigest: sourceDigest(input.source), version: input.version,
      expectedRevision: input.draft.digest, requestId: input.activity.request_id, goal: input.activity.goal, answer: input.answer, ...(sourceGoal ? { sourceGoal } : {}) };
    // Durable intent precedes the RPC: an interrupted response must still block stale-file execution.
    await this.storage.update(key, pending);
    const result = record(await send());
    pending.revision = textField(result, 'revision');
    await this.storage.update(key, pending);
    return pending;
  }
  async bindRevision(key: string, revision: string): Promise<PendingSync> {
    const pending = this.pending(key);
    if (!pending) throw new Error('No pending source synchronization.');
    const updated = { ...pending, revision };
    await this.storage.update(key, updated);
    return updated;
  }
  assertSource(pending: PendingSync, source: string, version?: number): void {
    if (sourceDigest(source) !== pending.sourceDigest) throw new Error('Source changed; pending clarification is preserved. Reconcile the source before synchronizing.');
    if (version !== undefined && version !== pending.version) throw new Error('The document changed after the clarification request. Review synchronization again.');
  }
  sourceFor(pending: PendingSync, before: Revision, after: Revision): string {
    if (before.digest !== pending.expectedRevision || after.digest !== pending.revision || after.parent !== before.digest || before.program_id !== after.program_id) {
      throw new Error('Clarification revision identity changed.');
    }
    const goal = before.program.goals.find(goal => goal.name === pending.goal);
    const answered = after.program.goals.find(goal => goal.name === pending.goal);
    if (!goal || !answered || answered.intent !== goal.intent + '\nAuthor clarification: ' + pending.answer) throw new Error('Clarification intent differs from the exact answer.');
    const expected = { ...before.program, goals: before.program.goals.map(item => item.name === goal.name ? { ...item, intent: answered.intent } : item) };
    if (!sameProgram(expected, after.program)) throw new Error('Clarification contains unrelated program changes.');
    return replaceIntent(pending.source, pending.sourceGoal ?? goal, answered.intent);
  }
  async clear(key: string): Promise<void> { await this.storage.update(key, undefined); }
}
