// fs directory + file management: mkdirSync (recursive), readdirSync, statSync
// isDirectory, unlink/rename/copyFile, rmSync -r, ENOENT .code on a missing read.
const fs = require("fs");
const R = "/tmp/milojs_fsdirops_test";
fs.rmSync(R, { recursive: true, force: true });
fs.mkdirSync(R + "/a/b/c", { recursive: true });
fs.writeFileSync(R + "/a/f.txt", "hello");
fs.copyFileSync(R + "/a/f.txt", R + "/a/g.txt");
console.log("readdir", fs.readdirSync(R + "/a").sort().join(","));
console.log("isDir", fs.statSync(R + "/a").isDirectory(), fs.statSync(R + "/a/f.txt").isDirectory());
console.log("isFile", fs.statSync(R + "/a/f.txt").isFile());
fs.renameSync(R + "/a/g.txt", R + "/a/renamed.txt");
console.log("afterRename", fs.readdirSync(R + "/a").sort().join(","));
fs.unlinkSync(R + "/a/f.txt");
console.log("afterUnlink", fs.existsSync(R + "/a/f.txt"), fs.readdirSync(R + "/a").sort().join(","));
try { fs.readFileSync(R + "/nope.txt"); } catch (e) { console.log("missing", e.code); }
fs.rmSync(R, { recursive: true });
console.log("cleaned", fs.existsSync(R));
