// Which prompt text is WORDING (Royce, 2026-10-29: a wording-only prompt change must not need a full re-record to merge). The golden
// replay masks it out of a request to build the request's skeleton (evals/lib/goldenSkeleton.mjs), so a call whose only change is the
// wording of one of these still finds its recording, as "prompt moved", and only with a moved-ledger entry (moved-ledger.json).
//
// An ALLOWLIST (independent review of #318: with every literal in eight files maskable, deleting the 988 line, sharing members' details,
// "fill in something plausible" and "never call this tool" all passed as moved). Only the declarations named here are wording: tone
// and style text, nothing else. Mixed literals were split in the source so their rules live in their own declarations (CO_VOICE,
// COACHING, SHARING_GUIDE, FEEDBACK_GUIDE: the assembled text is byte for byte what it was). Everything not listed is behavior, and
// any change to it misses: safety, member safety and privacy, grounding and never-invent, consent, facts, gates, the call-offer and
// other checker prompts whose answers code reads, LOOP_GUIDE (its lines are tool use), and every tool description and schema.
//
// Each literal of an allowlisted declaration is its own placeholder ("textRhythm.ts:MESSAGE_RHYTHM#0"). Changing this list changes the
// registry's signature: run `npm run evals:golden:stamp` on the code BEFORE the wording change, then make the change.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_CHUNK, registrySignature } from "../lib/goldenSkeleton.mjs";

export const WORDING_ALLOWLIST = [
  { file: "src/services/textRhythm.ts", decl: "MESSAGE_RHYTHM" }, // message pacing: paragraphs as beats
  { file: "src/services/textRhythm.ts", decl: "COACHING_STYLE" }, // lines not lectures, ask first (not the follow-up task or the safety line)
  { file: "src/services/coVoice.ts", decl: "VOICE_TONE" }, // "composed and warm ... say less than you could"
  { file: "src/services/coVoice.ts", decl: "VOICE_STYLE" }, // punctuation and capitals
  { file: "src/services/connectDots.ts", decl: "SHARE_TONE" }, // how a share is answered (not its scope or the never-fill-in rule)
  { file: "src/services/connectDots.ts", decl: "SHARE_TONE_2" },
  { file: "src/services/connectDots.ts", decl: "FEEDBACK_TONE" }, // how feedback is shown (not its scope or the honest-account rule)
] as const;
// The files the allowlist reads (kept for the docs and the tests).
export const WORDING_FILES = [...new Set(WORDING_ALLOWLIST.map((a) => a.file))];

export type Chunk = { id: string; text: string };
const api = new URL("../../", import.meta.url).pathname;

// The name a literal is filed under: its nearest named declaration (a variable, function, method or property).
function ownerOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.name && ts.isIdentifier(n.name)) return n.name.text;
  }
  return "(top)";
}

// Every 40+ character literal of a file, filed under its declaration (the allowlist picks from these).
export function chunksOf(file: string, source = readFileSync(join(api, file), "utf8")): Chunk[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const base = file.split("/").pop()!;
  const seen = new Map<string, number>();
  const out: Chunk[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // An import path or a property name is never prompt text.
      const text = (node as ts.LiteralLikeNode).text;
      if (text.length >= MIN_CHUNK && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        const owner = ownerOf(node);
        const i = seen.get(owner) ?? 0;
        seen.set(owner, i + 1);
        out.push({ id: `${base}:${owner}#${i}`, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// The allowlisted chunks, longest first (a literal that contains another is masked whole), then by id, so masking is the same every
// run. An allowlist entry that names no literal is an error: the source moved and the list must follow it.
export function wordingRegistry(allow: readonly { file: string; decl: string }[] = WORDING_ALLOWLIST): { signature: string; allowlist: string[]; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  for (const a of allow) {
    const base = a.file.split("/").pop()!;
    const mine = chunksOf(a.file).filter((c) => c.id.startsWith(`${base}:${a.decl}#`));
    if (!mine.length) throw new Error(`wording allowlist: ${a.file} has no literal in ${a.decl}`);
    chunks.push(...mine);
  }
  chunks.sort((a, b) => b.text.length - a.text.length || a.id.localeCompare(b.id));
  const allowlist = allow.map((a) => `${a.file.split("/").pop()}:${a.decl}`);
  return { signature: registrySignature(allowlist), allowlist, chunks };
}
