import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface ResourceContext {
  file: string;
  folder?: string;
}

export interface CliSettings {
  executable: string;
  args: string[];
  cwd: string;
  harnessMode: 'off' | 'warn' | 'strict';
  proxyUrl: string;
  diagnosticsEnabled: boolean;
  delayMs: number;
  checkTimeoutMs: number;
  taskTimeoutMs: number;
  maxOutputBytes: number;
  legacy: boolean;
}

function stringSetting(raw: Record<string, unknown>, name: string, fallback: string): string {
  const value = raw[name] ?? fallback;
  if (typeof value !== 'string' || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`nexa.${name} must be a single-line string.`);
  }
  return value;
}

function limit(raw: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const value = raw[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`nexa.${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

// Legacy command strings use quoting only; shell expansion has never been safe here.
function splitLegacy(value: string): string[] {
  if (existsSync(value)) return [value];
  const parts: string[] = [];
  let current = '';
  let quote = '';
  let started = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote && character === quote) { quote = ''; continue; }
    if (!quote && (character === '"' || character === "'")) { quote = character; started = true; continue; }
    if (!quote && /\s/.test(character)) {
      if (started) { parts.push(current); current = ''; started = false; }
      continue;
    }
    if (character === '\\' && value[index + 1] === quote && quote === '"') {
      current += value[++index];
    } else {
      current += character;
    }
    started = true;
  }
  if (quote) throw new Error('Unclosed quote in nexa.executable. Use executablePath and executableArgs.');
  if (started) parts.push(current);
  return parts;
}

function expand(value: string, resource: ResourceContext): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    if (name === 'workspaceFolder' && resource.folder) return resource.folder;
    if (name === 'fileDirname') return path.dirname(resource.file);
    throw new Error(`Unsupported or unavailable variable \${${name}} in Nexa CLI configuration.`);
  });
}

export function resolveSettings(raw: Record<string, unknown>, resource: ResourceContext): CliSettings {
  const explicit = stringSetting(raw, 'executablePath', '').trim();
  const legacyValue = stringSetting(raw, 'executable', 'nexa').trim();
  const parts = explicit ? [explicit] : splitLegacy(expand(legacyValue, resource));
  const executable = parts.shift();
  if (!executable) throw new Error('Set nexa.executablePath to a CLI executable.');
  const args = raw.executableArgs ?? [];
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('nexa.executableArgs must contain only string arguments.');
  }
  const mode = raw.harnessMode ?? 'warn';
  if (mode !== 'off' && mode !== 'warn' && mode !== 'strict') throw new Error('Invalid nexa.harnessMode.');
  return {
    executable: expand(executable, resource),
    args: [...parts, ...(args as string[])].map(value => expand(value, resource)),
    cwd: resource.folder ?? path.dirname(resource.file),
    harnessMode: mode,
    proxyUrl: stringSetting(raw, 'proxyUrl', ''),
    diagnosticsEnabled: raw['diagnostics.enabled'] !== false,
    delayMs: limit(raw, 'diagnostics.delayMs', 500, 0, 5000),
    checkTimeoutMs: limit(raw, 'checkTimeoutMs', 30000, 1000, 300000),
    taskTimeoutMs: limit(raw, 'taskTimeoutMs', 300000, 1000, 86400000),
    maxOutputBytes: limit(raw, 'maxOutputBytes', 4194304, 1024, 67108864),
    legacy: !explicit && legacyValue !== 'nexa',
  };
}

export function processEnvironment(settings: CliSettings, proxy: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', NO_COLOR: '1' };
  if (proxy && settings.proxyUrl) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[key] = settings.proxyUrl;
  }
  return env;
}
