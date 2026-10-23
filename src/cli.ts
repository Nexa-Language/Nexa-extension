import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export interface CliRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
}
export interface RunOptions {
  signal?: AbortSignal;
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void;
}
export type ResultKind = 'exited' | 'signal' | 'cancelled' | 'timeout' | 'outputLimit' | 'spawnError';
export interface CliResult {
  kind: ResultKind;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

class ProcessJob {
  private child: ChildProcess | undefined;
  private readonly decoder = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private readonly output = { stdout: '', stderr: '' };
  private bytes = 0;
  private reason: ResultKind | undefined;
  private error: string | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private escalation: NodeJS.Timeout | undefined;
  private closed = false;
  private terminated = false;
  private settled = false;
  private code: number | null = null;
  private signal: NodeJS.Signals | null = null;
  private resolve!: (result: CliResult) => void;
  readonly promise: Promise<CliResult>;
  private readonly abort = () => this.stop('cancelled');

  constructor(private readonly request: CliRequest, private readonly options: RunOptions) {
    this.promise = new Promise(resolve => { this.resolve = resolve; });
  }

  start(): void {
    if (this.options.signal?.aborted) { this.reason = 'cancelled'; this.finish(); return; }
    try {
      this.child = spawn(this.request.executable, this.request.args, {
        cwd: this.request.cwd, env: this.request.env ?? process.env,
        shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.reason = 'spawnError'; this.error = String(error); this.finish(); return;
    }
    this.options.signal?.addEventListener('abort', this.abort, { once: true });
    this.deadline = setTimeout(() => this.stop('timeout'), this.request.timeoutMs);
    this.child.stdout?.on('data', (chunk: Buffer) => this.data(chunk, 'stdout'));
    this.child.stderr?.on('data', (chunk: Buffer) => this.data(chunk, 'stderr'));
    this.child.on('error', error => { this.error = error.message; this.reason ??= 'spawnError'; });
    this.child.on('close', (code, signal) => {
      this.closed = true; this.code = code; this.signal = signal;
      if (!this.escalation || this.terminated) this.finish();
    });
    if (this.options.signal?.aborted) this.abort();
  }

  private data(chunk: Buffer, stream: 'stdout' | 'stderr'): void {
    const available = Math.max(0, this.request.maxOutputBytes - this.bytes);
    const accepted = chunk.subarray(0, available);
    this.bytes += accepted.byteLength;
    const text = this.decoder[stream].write(accepted);
    this.output[stream] += text;
    if (text) this.options.onOutput?.(text, stream);
    if (chunk.byteLength > available) this.stop('outputLimit');
  }

  stop(reason: ResultKind): void {
    if (this.settled || this.reason) return;
    this.reason = reason;
    this.kill('SIGTERM');
    // Keep the process group alive until escalation, even if its parent exits first.
    this.escalation = setTimeout(() => {
      this.kill('SIGKILL');
      this.terminated = true;
      if (this.closed) this.finish();
    }, 600);
  }

  private kill(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.on('error', () => { this.child?.kill(signal); });
      return;
    }
    try { process.kill(-pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.error = `Process termination failed: ${(error as Error).message}`;
    }
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.deadline);
    clearTimeout(this.escalation);
    this.options.signal?.removeEventListener('abort', this.abort);
    for (const stream of ['stdout', 'stderr'] as const) {
      const tail = this.reason === 'outputLimit' ? '' : this.decoder[stream].end();
      this.output[stream] += tail;
      if (tail) this.options.onOutput?.(tail, stream);
    }
    this.resolve({
      kind: this.reason ?? (this.signal ? 'signal' : 'exited'), code: this.code, signal: this.signal,
      ...this.output, ...(this.error ? { error: this.error } : {}),
    });
  }
}

export class CliRunner {
  private readonly active = new Set<ProcessJob>();
  private disposed = false;

  run(request: CliRequest, options: RunOptions = {}): Promise<CliResult> {
    if (this.disposed) return Promise.resolve({ kind: 'cancelled', code: null, signal: null, stdout: '', stderr: '' });
    const job = new ProcessJob(request, options);
    this.active.add(job);
    job.start();
    return job.promise.finally(() => this.active.delete(job));
  }

  stopAll(): void { for (const job of this.active) job.stop('cancelled'); }
  dispose(): void { this.disposed = true; this.stopAll(); }
  async shutdown(): Promise<void> {
    this.dispose();
    await Promise.all([...this.active].map(job => job.promise));
  }
}

export function taskExitCode(result: CliResult): number {
  if (result.kind === 'exited') return result.code ?? 1;
  if (result.kind === 'signal' && result.signal) return 128 + (constants.signals[result.signal] ?? 1);
  return result.kind === 'cancelled' ? 130 : 1;
}

export function describeResult(result: CliResult): string {
  if (result.kind === 'exited') return `Exited with code ${result.code ?? 'unknown'}.`;
  if (result.kind === 'signal') return `Terminated by ${result.signal}.`;
  if (result.kind === 'cancelled') return 'Stopped.';
  if (result.kind === 'timeout') return 'Stopped after the configured timeout.';
  if (result.kind === 'outputLimit') return 'Stopped after the configured output limit.';
  return `CLI could not start. Check nexa.executablePath and nexa.executableArgs. ${result.error ?? ''}`;
}
