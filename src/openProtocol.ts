import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ResourceContext } from './config';
import type { Inspection, Problem, SourceSpan } from './protocol';

export type JsonObject = Record<string, unknown>;
export interface NativeSpan { path: string; line: number; column: number; end_line: number; end_column: number }
export interface Goal extends JsonObject { name: string; intent: string; span: NativeSpan; stage: string }
export interface Program extends JsonObject { name: string; language_version: '3.0'; goals: Goal[]; handlers: JsonObject[] }
export interface CheckReport { program: Program | null; diagnostics: JsonObject[]; obligations: string[]; source_digest: string }
export interface Revision { digest: string; program_id: string; parent: string | null; program: Program }
export interface Activity extends JsonObject { activity_id: string; program_id: string; revision: string; goal: string; state: string; request_id?: string; result: JsonObject | null }
export interface Snapshot { draft: Revision | null; runtime: JsonObject | null; author_activities: Activity[]; runtime_activities: Activity[]; events: {cursor: number; event: {kind: string; object_id: string; detail: string}}[] }

export function record(value: unknown, label = 'response'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Nexa ${label}.`);
  return value as JsonObject;
}
export function textField(value: JsonObject, key: string): string {
  if (typeof value[key] !== 'string') throw new Error(`Invalid Nexa ${key}.`);
  return value[key];
}

export function languageVersion(source: string): '2.4' | '3.0' {
  if (/^\uFEFF/.test(source) || /^\s*\/\*[\s\S]*?\*\/\s*language\b/.test(source)) throw new Error('Unsupported prefix before the language declaration; use whitespace or // comments.');
  const leading = source.replace(/^\s*(?:\/\/[^\n]*\n\s*)*/, '');
  if (!/^language\b/.test(leading)) return '2.4';
  const match = /^language\s+"([^"\r\n]+)"/.exec(leading);
  if (!match) throw new Error('Invalid Nexa language declaration. Expected language "3.0" or "2.4".');
  if (match[1] !== '2.4' && match[1] !== '3.0') throw new Error(`Unsupported Nexa language version: ${match[1]}.`);
  return match[1];
}

export function parseCheckReport(value: unknown): CheckReport {
  const row = record(value, 'CheckReport');
  if (!Array.isArray(row.diagnostics) || !Array.isArray(row.obligations) || !('program' in row)) throw new Error('Invalid Nexa CheckReport.');
  if (row.program !== null) {
    const program = record(row.program, 'ProgramIR');
    if (program.language_version !== '3.0' || !Array.isArray(program.goals) || !Array.isArray(program.handlers)) throw new Error('Invalid Nexa ProgramIR.');
  }
  for (const value of row.diagnostics) {
    const diagnostic = record(value, 'diagnostic');
    if (typeof diagnostic.message !== 'string' || !['error', 'warning'].includes(String(diagnostic.severity))) throw new Error('Invalid Nexa diagnostic.');
  }
  return row as unknown as CheckReport;
}

function nativeSpan(value: unknown, context: ResourceContext, diagnostic = false): SourceSpan {
  const row = record(value, 'span');
  const numbers = ['line', 'column', 'end_line', 'end_column'].map(key => row[key]);
  if (numbers.some(n => !Number.isInteger(n) || Number(n) < 1)) throw new Error('Invalid Nexa span coordinates.');
  const file = typeof row.path === 'string' && row.path !== '<source>' ? path.resolve(context.folder ?? path.dirname(context.file), row.path) : context.file;
  const start = { line: Number(row.line) - 1, character: Number(row.column) - 1 };
  // The native frontend's point diagnostics retain SourceSpan's default end (1, 1).
  const end = diagnostic && row.end_line === 1 && row.end_column === 1 ? { ...start } : { line: Number(row.end_line) - 1, character: Number(row.end_column) - 1 };
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) throw new Error('Invalid Nexa span order.');
  return { file, start, end };
}

export function openProblems(report: CheckReport, context: ResourceContext): Problem[] {
  return report.diagnostics.map(row => {
    const span = nativeSpan(row.span, context, true);
    return { file: span.file, position: span.start, end: span.end, message: textField(row, 'message'),
      severity: row.severity === 'warning' ? 'warning' : 'error', code: textField(row, 'code'), source: 'check' };
  });
}

export function openInspection(report: CheckReport, context: ResourceContext): Inspection {
  const entries = report.program ? [
    ...report.program.goals.map(goal => ({ name: goal.name, kind: 'goals', span: nativeSpan(goal.span, context) })),
    ...report.program.handlers.map(handler => ({ name: textField(handler, 'event'), kind: 'handlers', span: nativeSpan(handler.span, context) })),
  ] : [];
  return { entries, raw: report as unknown as JsonObject };
}

function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'span').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, semantic(item)]));
}
export function sameProgram(left: unknown, right: unknown): boolean { return JSON.stringify(semantic(left)) === JSON.stringify(semantic(right)); }
export function sourceDigest(source: string): string { return createHash('sha256').update(source).digest('hex'); }

function offset(source: string, line: number, column: number): number {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length || column < 1 || column > [...lines[line - 1]!].length + 1) throw new Error('Source span no longer matches the document.');
  return lines.slice(0, line - 1).reduce((count, text) => count + text.length + 1, 0) + [...lines[line - 1]!].slice(0, column - 1).join('').length;
}

// Only locate the intent token. Native program/check validates the complete edited IR.
export function replaceIntent(source: string, goal: Pick<Goal, 'intent' | 'span'>, intent: string): string {
  const start = offset(source, goal.span.line, goal.span.column);
  const end = offset(source, goal.span.end_line, goal.span.end_column);
  const slice = source.slice(start, end);
  const tokens = [...slice.matchAll(/\/\/[^\n]*|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_]*|[^\s]/g)].filter(match => !match[0].startsWith('//'));
  const found: RegExpMatchArray[] = [];
  for (let index = 0; index < tokens.length - 1; index++) if (tokens[index]![0] === 'intent' && tokens[index + 1]![0].startsWith('"')) found.push(tokens[index + 1]!);
  if (found.length !== 1) throw new Error('Expected exactly one intent token in the selected goal.');
  const token = found[0]!;
  if (JSON.parse(token[0]) !== goal.intent) throw new Error('Source intent changed; pending clarification requires reconciliation.');
  const at = start + token.index!;
  return source.slice(0, at) + JSON.stringify(intent) + source.slice(at + token[0].length);
}
