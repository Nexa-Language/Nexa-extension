type Work = (signal: AbortSignal, current: () => boolean) => Promise<unknown>;
interface Entry {
  controller: AbortController;
  work: Work;
  resolve: () => void;
  reject: (error: unknown) => void;
  ready: boolean;
  running: boolean;
  timer?: NodeJS.Timeout;
}

export class CheckScheduler {
  private readonly entries = new Map<string, Entry>();
  private running = 0;
  private disposed = false;

  constructor(private readonly concurrency = 2) {}

  schedule(key: string, delay: number, work: Work): Promise<void> {
    this.cancel(key);
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const entry: Entry = { controller: new AbortController(), work, resolve, reject, ready: false, running: false };
      this.entries.set(key, entry);
      entry.timer = setTimeout(() => { entry.ready = true; this.pump(); }, delay);
    });
  }

  cancel(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    entry.controller.abort();
    if (!entry.running) entry.resolve();
  }

  private pump(): void {
    for (const [key, entry] of this.entries) {
      if (this.running >= this.concurrency || this.disposed) return;
      if (!entry.ready || entry.running) continue;
      entry.running = true;
      this.running++;
      const current = () => !entry.controller.signal.aborted && this.entries.get(key) === entry && !this.disposed;
      void entry.work(entry.controller.signal, current).then(entry.resolve, entry.reject).finally(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        this.running--;
        this.pump();
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const key of this.entries.keys()) this.cancel(key);
  }
}
