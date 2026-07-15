#!/bin/sh
# Bundle the React UI into dist/ (app.js + app.css + editor.worker.js + assets).
# hades-web serves this directory from disk (--webroot); run this before
# starting the server, no server recompile needed for UI changes.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
bun build src/main.tsx --outdir dist --minify
mv dist/main.js dist/app.js
mv dist/main.css dist/app.css
# Monaco's language service workers — must be same-origin (no CDN).
bun build node_modules/monaco-editor/esm/vs/editor/editor.worker.js --outdir dist --minify
bun build node_modules/monaco-editor/esm/vs/language/json/json.worker.js --outdir dist --minify
cp index.html dist/index.html
# social/link-preview assets (og.png regen: see og-card.html header comment)
cp favicon.svg og.png dist/
ls -la dist/
