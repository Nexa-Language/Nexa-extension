import * as path from 'node:path';
import type { CliSettings } from './config';
import type { JsonObject } from './openProtocol';

export const openSettingNames = ['environment', 'state', 'programId', 'pythonPath', 'pythonArgs', 'dockerContext', 'capsule', 'maxModelCalls', 'maxTokens', 'timeoutSeconds'] as const;
export interface OpenSettings {
  environment: string; state: string; programId: string; pythonPath: string; pythonArgs: string[]; dockerContext: string; capsule: string;
  maxModelCalls: number; maxTokens: number; timeoutSeconds: number;
}
export function resolveOpenSettings(raw: JsonObject, cli: CliSettings, file: string): OpenSettings {
  const text = (name: string, fallback = '') => {
    const value = raw[name] ?? fallback;
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error(`nexa.open.${name} must be a single-line string.`);
    return value.replace(/\$\{workspaceFolder\}/g, cli.cwd);
  };
  const location = (name: string, fallback = '') => { const value = text(name, fallback); return value ? path.resolve(cli.cwd, value) : ''; };
  const number = (name: string, fallback: number, min: number, max: number) => {
    const value = raw[name] ?? fallback;
    if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid nexa.open.${name}.`);
    return Number(value);
  };
  const pythonArgs = raw.pythonArgs ?? [];
  if (!Array.isArray(pythonArgs) || pythonArgs.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid nexa.open.pythonArgs.');
  return {
    environment: location('environment'), state: location('state', '.nexa/open-programs.sqlite3'),
    programId: text('programId') || path.basename(file, path.extname(file)), pythonPath: text('pythonPath'),
    pythonArgs: (pythonArgs as string[]).map(value => value.replace(/\$\{workspaceFolder\}/g, cli.cwd)), dockerContext: text('dockerContext'), capsule: text('capsule'),
    maxModelCalls: number('maxModelCalls', 4, 0, 100), maxTokens: number('maxTokens', 20000, 1, 10000000), timeoutSeconds: number('timeoutSeconds', 120, 1, 3600),
  };
}
export function environmentArgs(settings: OpenSettings): string[] {
  if (!settings.environment) throw new Error('Set nexa.open.environment in this workspace folder before building, resolving or running.');
  return ['--environment', settings.environment, '--state', settings.state];
}
export function executionArgs(settings: OpenSettings): string[] {
  return [...environmentArgs(settings), '--max-model-calls', String(settings.maxModelCalls), '--max-tokens', String(settings.maxTokens),
    '--timeout', String(settings.timeoutSeconds), '--json', ...(settings.dockerContext ? ['--docker-context', settings.dockerContext] : [])];
}
