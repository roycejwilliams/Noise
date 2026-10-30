// Which prompt text is WORDING (Royce, 2026-10-29: a wording-only prompt change must not need a full re-record to merge). The golden
// replay masks it out of a request to build the request's skeleton (evals/lib/goldenSkeleton.mjs), so a call whose only change is the
// wording of an instruction still finds its recording, as "prompt moved".
//
// Wording is the text of the string and template literals (40+ characters) in the files below, read from the source as it is now. Each
// literal is its own placeholder, named by its file, the declaration it sits in and its place there (e.g. "conversationReply.ts:system#3"),
// so editing the words inside a literal moves it, while adding, dropping or swapping a literal changes the skeleton (a miss).
//
// Only instruction prompts belong here. A file that builds facts, tool schemas or member-facing lines does not (facts are behavior: a
// changed fact needs a re-record), and fact and conversation lines are never masked whatever file built them. Changing this list
// changes the registry's signature: run `npm run evals:golden:stamp` on the code BEFORE the wording change, then make the change.
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_CHUNK, registrySignature } from "../lib/goldenSkeleton.mjs";

export const WORDING_FILES = [
  "src/agent/conversationReply.ts", // the reply prompt: its paragraphs, the length line, the gesture lines
  "src/services/coCore.ts", // how Cue listens, what's true, other members, safety
  "src/services/coVoice.ts", // Cue's voice, the iMessage channel line
  "src/services/textRhythm.ts", // message rhythm, coaching
  "src/services/moves.ts", // the moves guide
  "src/services/connectDots.ts", // the moment read, the sharing and feedback guides
  "src/services/readTurn.ts", // the turn read and its instructions
  "src/agent/loop.ts", // the find-or-do guide
] as const;

export type Chunk = { id: string; text: string };
const api = new URL("../../", import.meta.url).pathname;

// The name a literal is filed under: its nearest named declaration (a variable, function, method or property).
function ownerOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.name && ts.isIdentifier(n.name)) return n.name.text;
  }
  return "(top)";
}

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

// Every wording chunk, longest first (a literal that contains another is masked whole), then by id, so masking is the same every run.
export function wordingRegistry(files: readonly string[] = WORDING_FILES): { signature: string; files: string[]; chunks: Chunk[] } {
  const chunks = files.flatMap((f) => chunksOf(f));
  chunks.sort((a, b) => b.text.length - a.text.length || a.id.localeCompare(b.id));
  return { signature: registrySignature([...files]), files: [...files], chunks };
}
