import { realpath } from 'node:fs/promises';
import * as path from 'node:path';

export interface SourceDocument {
  uri: { scheme: string; fsPath: string };
  isUntitled: boolean;
  isDirty: boolean;
  save(): Thenable<boolean> | Promise<boolean>;
}

export function isSourceFile(file: string): boolean {
  return ['.nx', '.nxlib'].includes(path.extname(file).toLowerCase());
}

export function requireTrust(trusted: boolean): void {
  if (!trusted) throw new Error('Trust this workspace before running Nexa CLI commands.');
}

export async function prepareDocument(document: SourceDocument, trusted: () => boolean): Promise<void> {
  requireTrust(trusted());
  if (document.isUntitled || document.uri.scheme !== 'file') {
    throw new Error('Nexa commands require a saved file on the extension host filesystem.');
  }
  if (!isSourceFile(document.uri.fsPath)) throw new Error('Open a .nx or .nxlib source file first.');
  if (document.isDirty && !(await document.save())) throw new Error('Nexa stopped because the file could not be saved.');
  requireTrust(trusted());
}

export async function canCheckAutomatically(file: string, folder: string | undefined, trusted: boolean): Promise<boolean> {
  if (!trusted || !folder || !isSourceFile(file)) return false;
  try {
    const [realFile, realFolder] = await Promise.all([realpath(file), realpath(folder)]);
    const relative = path.relative(realFolder, realFile);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
