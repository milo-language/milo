// Planted-bug check: does a gate fail when the code it guards is broken?
//
//   bun scripts/plant.ts <file> <find.txt> <replace.txt> -- <gate command...>
//
// Replaces the exact text of find.txt (not a regex) with replace.txt in <file>, runs the
// gate, and restores the file's original bytes whatever happens. The text must occur
// exactly once, so a plant can never silently not apply. Exit 0 when the gate failed (the
// plant was caught), 1 when it passed (the gate is blind to this bug), 2 on a bad plant.
// Find and replace come from files so no shell quoting touches them: write them with a
// quoted heredoc (<<'EOF').
import { readFileSync, writeFileSync } from "fs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep !== 3 || argv.length < 5) {
  console.error("usage: bun scripts/plant.ts <file> <find.txt> <replace.txt> -- <gate command...>");
  process.exit(2);
}
const [file, findPath, replacePath] = argv;
const gate = argv.slice(sep + 1);
// A heredoc ends with a newline the text did not mean; one trailing newline is dropped.
const read = (p: string) => readFileSync(p, "utf8").replace(/\n$/, "");
const find = read(findPath), replace = read(replacePath);
const original = readFileSync(file, "utf8");
const count = find === "" ? 0 : original.split(find).length - 1;
if (count !== 1) {
  console.error(`plant: the find text occurs ${count} times in ${file}; it must occur exactly once`);
  process.exit(2);
}
if (find === replace) {
  console.error("plant: find and replace are the same text");
  process.exit(2);
}
let status: number;
try {
  writeFileSync(file, original.replace(find, () => replace));
  const r = Bun.spawnSync(gate, { stdout: "inherit", stderr: "inherit" });
  status = r.exitCode ?? 1;
} finally {
  writeFileSync(file, original);
}
if (readFileSync(file, "utf8") !== original) {
  console.error(`plant: ${file} was not restored`);
  process.exit(2);
}
console.log(status !== 0 ? "plant: caught (gate failed)" : "plant: NOT caught (gate passed)");
process.exit(status !== 0 ? 0 : 1);
