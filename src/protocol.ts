import * as path from 'node:path';
import type { ResourceContext } from './config';

export type CheckKind = 'validate' | 'harness';
export interface Position { line: number; character: number }
export interface SourceSpan { file: string; start: Position; end: Position }
export interface Problem {
  file: string;
  position?: Position;
  message: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  source: CheckKind;
}
export interface StructureEntry { name: string; kind: string; span?: SourceSpan }
export interface Inspection { entries: StructureEntry[]; raw: Record<string, unknown> }

export function toUtf16Position(point: Position, lines: string[]): Position | undefined {
  const line = lines[point.line];
  if (line === undefined || point.character > [...line].length) return undefined;
  return { line: point.line, character: [...line].slice(0, point.character).join('').length };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Nexa ${label}: expected an object.`);
  return value as Record<string, unknown>;
}

function position(line: unknown, column: unknown): Position | undefined {
  if (!Number.isInteger(line) || !Number.isInteger(column) || Number(line) < 1 || Number(column) < 1) return undefined;
  return { line: Number(line) - 1, character: Number(column) - 1 };
}

function resolveFile(file: unknown, context: ResourceContext): string {
  if (typeof file !== 'string' || !file) return context.file;
  if (path.win32.isAbsolute(file) || path.isAbsolute(file)) return file;
  return path.resolve(context.folder ?? path.dirname(context.file), file);
}

function problem(value: unknown, severity: Problem['severity'], kind: CheckKind, context: ResourceContext): Problem {
  const row = object(value, 'diagnostic');
  if (typeof row.message !== 'string' || !row.message) throw new Error('Invalid Nexa diagnostic: missing message.');
  let file = resolveFile(row.file, context);
  let point = position(row.line, row.column);
  if (kind === 'harness' && typeof row.location === 'string') {
    const match = /^(.*):(\d+):(\d+)$/.exec(row.location);
    if (match) { file = resolveFile(match[1], context); point = position(Number(match[2]), Number(match[3])); }
  }
  const hint = row.fix_hint ?? row.suggestion;
  const message = row.message + (typeof hint === 'string' && hint ? `\n${hint}` : '');
  const code = row.error_type ?? row.rule_id;
  return { file, ...(point ? { position: point } : {}), message, severity, code: typeof code === 'string' ? code : kind, source: kind };
}

export function parseDiagnostics(json: string, kind: CheckKind, context: ResourceContext): Problem[] {
  const data = object(JSON.parse(json), 'diagnostics');
  if (typeof data.valid !== 'boolean' || !Array.isArray(data.errors) || !Array.isArray(data.warnings)) {
    throw new Error('Invalid Nexa diagnostics schema: expected valid, errors and warnings.');
  }
  const result = [
    ...data.errors.map(value => problem(value, 'error', kind, context)),
    ...data.warnings.map(value => problem(value, 'warning', kind, context)),
  ];
  if (data.info !== undefined) {
    if (!Array.isArray(data.info)) throw new Error('Invalid Nexa diagnostics: info must be an array.');
    result.push(...data.info.map(value => problem(value, 'info', kind, context)));
  }
  if (!data.valid && !result.some(item => item.severity === 'error')) {
    throw new Error('Nexa reported invalid source without an error diagnostic.');
  }
  return result;
}

function sourceSpan(value: unknown, context: ResourceContext): SourceSpan | undefined {
  if (value === undefined) return undefined;
  const source = object(value, 'source span');
  const start = position(source.line, source.column);
  const end = position(source.end_line, source.end_column);
  if (typeof source.file !== 'string' || !start || !end || end.line < start.line || (end.line === start.line && end.character < start.character)) {
    throw new Error('Invalid Nexa source span.');
  }
  return { file: resolveFile(source.file, context), start, end };
}

export function parseInspection(json: string, context: ResourceContext): Inspection {
  const raw = object(JSON.parse(json), 'inspection');
  if (typeof raw.error === 'string') throw new Error(raw.error);
  const entries: StructureEntry[] = [];
  for (const kind of ['agents', 'tools', 'protocols', 'flows', 'tests', 'types']) {
    if (!Array.isArray(raw[kind])) throw new Error(`Invalid Nexa inspection: ${kind} must be an array.`);
    for (const value of raw[kind]) {
      const item = object(value, 'structure entry');
      if (typeof item.name !== 'string') throw new Error('Invalid Nexa structure entry: missing name.');
      const span = sourceSpan(item.source, context);
      entries.push({ name: item.name, kind, ...(span ? { span } : {}) });
    }
  }
  return { entries, raw };
}
