// Builds the local place table (api/src/data/geonames/) that place resolution reads instead of Open-Meteo's free geocoding API, which
// is licensed for non-commercial use only (2026-10-29). The data is GeoNames (https://www.geonames.org), CC BY 4.0, commercial use
// allowed with attribution (api/src/data/geonames/NOTICE). Open-Meteo's own geocoder is built on the same GeoNames data.
//
//   mkdir <empty dir> && cd <empty dir>
//   curl -fsSLO https://download.geonames.org/export/dump/cities15000.zip && unzip cities15000.zip
//   curl -fsSLO https://download.geonames.org/export/dump/admin1CodesASCII.txt
//   npx tsx src/scripts/buildPlaceTable.ts <that dir> [cities15000]
//
// Keeps only what placeResolve.ts pickPlace reads: name, ASCII name (when it differs), country, admin1 code, lat, lng, population,
// feature code; and the names of the admin1 codes those rows use. No alternate names (Google covers other spellings). Populated places
// only, never a historical, abandoned or destroyed one. Sorted, so a rebuild from the same dump is the same file.
// cities15000 (places over 15,000 people, and capitals): the smallest dump that keeps every #314 trap. cities5000 adds places like
// Springfield, Michigan (5,192), which then wins "Springfield" for a Chicago member on nearness over Springfield, Illinois; cities1000
// is over 3 MB gzipped.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { gzipSync } from "zlib";

const dir = process.argv[2];
const dump = process.argv[3] ?? "cities15000";
if (!dir) {
  console.error("usage: npx tsx src/scripts/buildPlaceTable.ts <dir with the unzipped dump and admin1CodesASCII.txt> [cities15000]");
  process.exit(1);
}
const out = new URL("../data/geonames/", import.meta.url).pathname;
const DROP = new Set(["PPLH", "PPLQ", "PPLW", "PPLCH"]);
const clean = (s: string) => s.replace(/[\t\r\n]/g, " ").trim();

const rows: string[][] = [];
const admin1Used = new Set<string>();
for (const line of readFileSync(join(dir, `${dump}.txt`), "utf8").split("\n")) {
  if (!line) continue;
  // geonameid, name, asciiname, alternatenames, latitude, longitude, feature class, feature code, country code, cc2, admin1 code, ...,
  // population (column 15).
  const f = line.split("\t");
  const [name, ascii, lat, lng, fclass, fcode, cc, a1, pop] = [clean(f[1]), clean(f[2]), f[4], f[5], f[6], f[7], f[8], f[10], f[14]];
  if (fclass !== "P" || !/^PPL/.test(fcode) || DROP.has(fcode) || !name) continue;
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) continue;
  rows.push([name, ascii === name ? "" : ascii, cc, a1, lat, lng, String(Number(pop) || 0), fcode]);
  if (cc && a1) admin1Used.add(`${cc}.${a1}`);
}
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
rows.sort((a, b) => cmp(a[0], b[0]) || cmp(a[2], b[2]) || Number(b[6]) - Number(a[6]) || cmp(a.join("\t"), b.join("\t")));

const admin1: string[] = [];
for (const line of readFileSync(join(dir, "admin1CodesASCII.txt"), "utf8").split("\n")) {
  // code ("US.CA"), name, name ascii, geonameid
  const [code, , asciiName] = line.split("\t");
  if (code && admin1Used.has(code) && asciiName) admin1.push(`${code}\t${clean(asciiName)}`);
}
admin1.sort();

mkdirSync(out, { recursive: true });
const header = "# GeoNames (https://www.geonames.org), CC BY 4.0. Built by api/src/scripts/buildPlaceTable.ts";
writeFileSync(join(out, "cities.tsv.gz"), gzipSync(`${header} from ${dump}\n# name\tascii\tcountry\tadmin1\tlat\tlng\tpopulation\tfeature\n${rows.map((r) => r.join("\t")).join("\n")}\n`, { level: 9 }));
writeFileSync(join(out, "admin1.tsv"), `${header} from admin1CodesASCII.txt\n# code\tname\n${admin1.join("\n")}\n`);
console.log(`${dump}: ${rows.length} places, ${admin1.length} admin1 names -> ${out}`);
