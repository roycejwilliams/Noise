// Types for goldenSkeleton.mjs (the golden replay's wording-masked key).
export const SKELETON_VERSION: number;
export const MIN_CHUNK: number;
export type WordingChunk = { id: string; text: string };
export type Skeleton = { hash: string; wording: Record<string, string>; format: string[]; tools: string | null };
export type Stamp = Skeleton & { v: string };
export function looksLikeFormat(text: string): boolean;
export function registrySignature(files: readonly string[]): string;
export function maskText(s: string, chunks: readonly WordingChunk[], found: Set<string>): string;
export function skeletonOf(key: { path: string; grader: boolean; beta: string | null; body: unknown }, chunks: readonly WordingChunk[]): Skeleton;
export function movedBetween(stamp: Partial<Skeleton>, now: Skeleton): { moved: string[]; blocked: string[] };
