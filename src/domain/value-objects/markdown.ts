/**
 * Shared markdown / text parsing helpers.
 *
 * Single source of truth for the small helpers that were previously
 * re-implemented across the domain value objects.
 */

import { REGEX_MD_HEADING_NUMBERING } from '../regexes';

export const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
export const HEADING_NUMBER_PREFIX = /^\d+[.)]\s*/;
export const MAX_EXCERPT_LENGTH = 160;

export interface Heading {
  readonly level: number;
  readonly title: string;
}

export interface HeadingLine {
  readonly level: number;
  readonly text: string;
}

export function detectHeading(
  line: string,
  normalizeTitle?: (raw: string) => string
): Heading | null {
  const match = HEADING_PATTERN.exec(line.trim());
  if (!match) return null;
  const raw = match[2];
  const title = normalizeTitle
    ? normalizeTitle(raw)
    : raw.replace(/#+\s*$/, '').trim();
  return { level: match[1].length, title };
}

export function parseHeading(line: string): HeadingLine | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
  if (!match) return null;
  return {
    level: match[1].length,
    text: match[2].replace(REGEX_MD_HEADING_NUMBERING, '').trim()
  };
}

export function isFence(line: string): boolean {
  return line.trim().startsWith('```');
}

export function isCommentLine(line: string, prefixes: readonly string[] = ['#']): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || prefixes.some((prefix) => trimmed.startsWith(prefix));
}

export function truncate(
  text: string,
  options?: { max?: number; trim?: boolean }
): string {
  const max = options?.max ?? MAX_EXCERPT_LENGTH;
  const trim = options?.trim ?? true;
  if (!trim) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}