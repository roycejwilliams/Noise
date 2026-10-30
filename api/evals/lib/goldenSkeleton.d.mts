// Types for goldenSkeleton.mjs (the golden replay's wording-masked key).
export const SKELETON_VERSION: number;
export const MIN_CHUNK: number;
export type WordingChunk = { id: string; text: string };
export type Skeleton = { hash: string; wording: Record<string, string>; guard: Record<string, string>; format: string[] };
export type Move = { id: string; from: string | null; to: string; before?: string | null };
export type Stamp = Skeleton & { v: string };
export function looksLikeFormat(text: string): boolean;
export function registrySignature(allowlist: readonly string[]): string;
export function maskText(s: string, chunks: readonly WordingChunk[], found: Set<string>): string;
export function skeletonOf(key: { path: string; grader: boolean; beta: string | null; body: unknown }, chunks: readonly WordingChunk[]): Skeleton;
export function movedBetween(stamp: Partial<Skeleton>, now: Skeleton): { moved: Move[]; blocked: string[] };
export function guardTerms(text: string): string;
export function wordingBefore(recordedKey: { path: string; grader: boolean; beta: string | null; body: unknown }, nowKey: { path: string; grader: boolean; beta: string | null; body: unknown }, chunks: readonly WordingChunk[], ids: readonly string[]): Record<string, string>;
