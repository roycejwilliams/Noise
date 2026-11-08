// Rebuilds api/src/data/words from the en_US Hunspell dictionary (dictionary-en@4.0.0's index.dic; see api/src/data/words/NOTICE).
//   npm pack dictionary-en@4.0.0 && tar xzf dictionary-en-4.0.0.tgz
//   npx tsx src/scripts/buildWordTable.ts package/index.dic
import { readFileSync, writeFileSync } from "fs";
import { gzipSync } from "zlib";
const dic = readFileSync(process.argv[2] ?? "package/index.dic", "utf8").split("\n").slice(1).map((l) => l.split("/")[0].trim()).filter(Boolean);
const common = [...new Set(dic.filter((w) => /^[a-z]+$/.test(w)))].sort();
const set = new Set(common);
const both = [...new Set(dic.filter((w) => /^[A-Z][a-z]+$/.test(w)).map((w) => w.toLowerCase()).filter((w) => set.has(w)))].sort();
const out = new URL("../data/words/", import.meta.url);
writeFileSync(new URL("common.txt.gz", out), gzipSync(common.join("\n") + "\n", { level: 9 }));
writeFileSync(new URL("common-and-proper.txt.gz", out), gzipSync(both.join("\n") + "\n", { level: 9 }));
console.log(`common: ${common.length} words, common-and-proper: ${both.length}`);
