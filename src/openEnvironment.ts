import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const maxBytes = 2 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function contents(file: string): Promise<Buffer> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error('Expected a bounded regular file.');
      const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new Error('Environment exceeds its size limit.');
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  } catch { throw new Error('Nexa author environment unavailable. Select a readable environment file of at most 2 MiB.'); }
}

export class AuthorEnvironment {
  private disposal: Promise<void> | undefined;
  private constructor(readonly source: string, readonly snapshot: string, private readonly identity: string) {}

  static async capture(source: string): Promise<AuthorEnvironment> {
    const bytes = await contents(source);
    const directory = await mkdtemp(path.join(tmpdir(), 'nexa-author-environment-'));
    const environment = new AuthorEnvironment(source, path.join(directory, 'environment.json'), digest(bytes));
    try {
      await chmod(directory, 0o700);
      await writeFile(environment.snapshot, bytes, { flag: 'wx', mode: 0o600 });
      return environment;
    } catch (error) { await environment.dispose(); throw error; }
  }

  async matches(): Promise<boolean> { return digest(await contents(this.source)) === this.identity; }
  async assertCurrent(): Promise<void> {
    if (!(await this.matches())) throw new Error('Nexa author environment changed. Resolve again to use its current permissions.');
  }
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      for (const remove of [() => unlink(this.snapshot), () => rmdir(path.dirname(this.snapshot))]) {
        try { await remove(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    })();
    return this.disposal;
  }
}
