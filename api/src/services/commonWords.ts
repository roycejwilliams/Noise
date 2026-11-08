// Ordinary English words, for telling a sentence's first word apart from a name (services/offerGuard.ts firstWordName). The tables are
// the en_US Hunspell dictionary's (SCOWL size 60): api/src/data/words, see its NOTICE. Read once, on first use; pure lookups after.
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";

const dirs = (): string[] => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // From src (tsx), api's dist, co-test's dist (co-test's image copies api/src), or the process's own directory (as placeResolve.ts).
  return [resolve(here, "../data/words"), resolve(here, "../../src/data/words"), resolve(here, "../../../../../api/src/data/words"), resolve(process.cwd(), "src/data/words"), resolve(process.cwd(), "api/src/data/words"), resolve(process.cwd(), "../api/src/data/words")];
};
type Tables = { common: Set<string>; proper: Set<string> };
let tables: Tables | null | undefined;
function load(): Tables | null {
  if (tables !== undefined) return tables;
  const dir = dirs().find((d) => existsSync(resolve(d, "common.txt.gz")));
  try {
    if (!dir) throw new Error("word table missing (api/src/data/words/common.txt.gz)");
    const read = (f: string) => new Set(gunzipSync(readFileSync(resolve(dir, f))).toString("utf8").split("\n").filter(Boolean));
    tables = { common: read("common.txt.gz"), proper: read("common-and-proper.txt.gz") };
  } catch (err: any) {
    console.error("commonWords: the word table didn't load (first words aren't read as names):", err?.message ?? err);
    tables = null;
  }
  return tables;
}

// The base forms a word may come from ("pitching" from "pitch", "totally" from "total", "running" from "run").
export function baseForms(w: string): string[] {
  const out = [w, w.replace(/ies$/, "y"), w.replace(/es$/, ""), w.replace(/s$/, ""), w.replace(/ily$/, "y"), w.replace(/ly$/, ""), w.replace(/ing$/, ""), w.replace(/ing$/, "e"), w.replace(/ed$/, ""), w.replace(/ed$/, "e"), w.replace(/ied$/, "y"), w.replace(/er$/, ""), w.replace(/est$/, ""), w.replace(/([b-df-hj-np-tv-z])\1(?:ing|ed|er|est)$/, "$1")];
  return [...new Set(out)].filter((x) => x.length >= 2);
}

// The table didn't load: null (callers then treat no first word as a name, as before the check existed).
export function isCommonWord(word: string): boolean | null {
  const t = load();
  if (!t) return null;
  const w = word.toLowerCase();
  return baseForms(w).some((x) => t.common.has(x));
}

// A word the dictionary has both as a common word and as a proper noun ("Grace", "Will", "Mark").
export function isAlsoAName(word: string): boolean {
  return !!load()?.proper.has(word.toLowerCase());
}

// Tests only: forget the loaded tables (null: as if the table were missing).
export function resetCommonWordsForTest(missing = false): void {
  tables = missing ? null : undefined;
}
