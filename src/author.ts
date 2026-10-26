import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CliRequest } from './cli';
import { record } from './openProtocol';

interface Pending {
  id: number; method: string; params: unknown; sent: boolean;
  resolve: (value: unknown) => void; reject: (error: Error) => void;
  timer: NodeJS.Timeout; cleanup: () => void;
}
const required = ['program/check', 'revision/propose', 'goal/resolve', 'author/answer', 'events/read', 'activity/read', 'activity/cancel', 'evidence/explain'];
interface Lifecycle { beforeSend?: () => Promise<void>; closed?: () => void }

export class AuthorClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private bytes = 0;
  private nextId = 0;
  private limit = 1;
  private ready: Promise<void> | undefined;
  private stopped = false;
  private pumping = false;
  private exit: Promise<void> = Promise.resolve();
  private termination: Promise<void> = Promise.resolve();
  get maxInflight(): number { return this.limit; }
  get closed(): boolean { return this.stopped; }

  constructor(private readonly command: CliRequest, private readonly capabilities = required, private readonly lifecycle: Lifecycle = {}) {}

  initialize(): Promise<void> {
    this.ready ??= this.start().then(async () => {
      const value = record(await this.request('initialize', { protocol_version: '3.0', client: 'nexa-vscode/0.3.0' }));
      if (value.protocol_version !== '3.0' || !Number.isInteger(value.max_inflight) || Number(value.max_inflight) < 1 ||
          !Array.isArray(value.methods) || this.capabilities.some(method => !(value.methods as unknown[]).includes(method))) {
        this.fail(new Error('Nexa author protocol/capability mismatch; install Nexa 3.0.'));
        throw new Error('Nexa author protocol/capability mismatch; install Nexa 3.0.');
      }
      this.limit = Math.min(2, Number(value.max_inflight));
      void this.pump();
    });
    return this.ready;
  }

  private async start(): Promise<void> {
    if (this.stopped) throw new Error('Nexa author connection closed.');
    this.child = spawn(this.command.executable, this.command.args, {
      cwd: this.command.cwd, env: this.command.env ?? process.env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exit = new Promise(resolve => this.child!.once('close', () => resolve()));
    this.child.on('error', () => this.fail(new Error('Nexa author could not start; check executable configuration.')));
    this.child.on('close', code => this.fail(new Error(`Nexa author exited (${code ?? 'signal'}).`)));
    this.child.stdin.on('error', () => this.fail(new Error('Nexa author input closed.')));
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // stderr counts against the bound but is never echoed; providers may put secrets there.
    this.child.stderr.on('data', (chunk: Buffer) => this.account(chunk.length));
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped || signal?.aborted) return Promise.reject(new Error('Nexa author request cancelled or connection closed.'));
    if (!this.child) return Promise.reject(new Error('Initialize the Nexa author before requesting work.'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Nexa author request queue is full.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const abort = () => this.fail(new Error('Nexa author request cancelled; refresh state before continuing.'));
      const timer = setTimeout(() => this.fail(new Error('Nexa author request deadline exceeded; refresh state before continuing.')), this.command.timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { id, method, params, sent: false, resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const entry of this.pending.values()) {
        if (this.stopped || [...this.pending.values()].filter(item => item.sent).length >= this.limit) return;
        if (entry.sent) continue;
        const frame = JSON.stringify({ jsonrpc: '2.0', id: entry.id, method: entry.method, params: entry.params }) + '\n';
        if (frame.length > 2 * 1024 * 1024 || Buffer.byteLength(frame) > this.command.maxOutputBytes) throw new Error('Nexa author request frame exceeds the limit.');
        // Validate at dispatch, including work queued before a permission change.
        await this.lifecycle.beforeSend?.();
        if (this.stopped || !this.pending.has(entry.id)) return;
        entry.sent = true;
        this.child!.stdin.write(frame);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error('Nexa author preflight failed.')); }
    finally { this.pumping = false; }
  }

  private account(count: number): boolean {
    this.bytes += count;
    if (this.bytes <= this.command.maxOutputBytes) return true;
    this.fail(new Error('Nexa author output limit exceeded.')); return false;
  }

  private receive(chunk: Buffer): void {
    if (this.stopped || !this.account(chunk.length)) return;
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > 2 * 1024 * 1024) { this.fail(new Error('Nexa author frame limit exceeded.')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0 && !this.stopped) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      try { this.response(record(JSON.parse(line), 'JSON-RPC frame')); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid Nexa JSON frame.')); }
    }
    if (!this.pending.size && !this.buffer) this.bytes = 0;
  }

  private response(row: Record<string, unknown>): void {
    if (row.jsonrpc !== '2.0' || typeof row.id !== 'number' || ('result' in row) === ('error' in row)) throw new Error('Invalid Nexa response frame.');
    const entry = this.pending.get(row.id);
    if (!entry?.sent) throw new Error('Nexa response identity does not match an inflight request.');
    const error = 'error' in row ? record(row.error, 'error') : undefined;
    const data = error?.data ? record(error.data, 'error data') : undefined;
    this.pending.delete(row.id); entry.cleanup();
    if (error) {
      const detail = data ? data.code : error.code;
      entry.reject(new Error(`Nexa author: ${String(detail)}. ${typeof error.message === 'string' ? error.message : ''}`));
    } else entry.resolve(row.result);
    void this.pump();
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error); }
    this.pending.clear();
    this.child?.stdin.end();
    const child = this.child;
    if (!child?.pid) { this.lifecycle.closed?.(); return; }
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid!, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
    };
    kill('SIGTERM');
    // A parent may exit on SIGTERM while its provider descendant keeps running.
    this.termination = new Promise(resolve => setTimeout(() => { kill('SIGKILL'); resolve(); }, 600));
    this.lifecycle.closed?.();
  }

  dispose(): void { this.fail(new Error('Nexa author connection disposed.')); }
  async shutdown(): Promise<void> { this.dispose(); await Promise.all([this.exit, this.termination]); }
}
