<template>
  <div class="pg">
    <!-- Every example is one tap away: a row that wraps on desktop and swipes sideways on a
         phone, instead of a select whose native picker hides the list. -->
    <nav class="chips" aria-label="Examples">
      <button
        v-for="e in EXAMPLES" :key="e.id" class="chip"
        :class="{ on: e.id === exampleId, bad: e.error }" :aria-pressed="e.id === exampleId"
        @click="loadExample(e.id)"
      >{{ e.title }}</button>
    </nav>
    <div class="toolbar">
      <span class="edited" v-if="exampleId === ''">edited</span>
      <span class="spacer"></span>
      <span class="hint">{{ mac ? '⌘' : 'Ctrl' }}+Enter to run</span>
      <button class="run-btn" :disabled="running" @click="run">{{ running ? 'Running…' : 'Run' }}</button>
    </div>

    <div class="editor">
      <pre class="gutter" aria-hidden="true" ref="gutEl">{{ gutter }}</pre>
      <pre class="hl" aria-hidden="true" ref="hlEl"><code v-html="highlighted"></code></pre>
      <textarea
        ref="taEl" v-model="code" class="ta" spellcheck="false" autocomplete="off" autocapitalize="off"
        aria-label="Milo source" wrap="off"
        @keydown="onKey" @scroll="syncScroll" @input="exampleId = ''"
      ></textarea>
    </div>

    <div class="out-bar">
      <span>Output</span>
      <span v-if="status" class="status" :class="{ bad: exitCode !== 0 }">{{ status }}</span>
    </div>
    <pre class="out-pane" aria-live="polite"><span v-for="(l, i) in lines" :key="i" :class="l.kind">{{ l.text }}
</span><span v-if="!lines.length" class="muted">Press Run to see output.</span></pre>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { EXAMPLES } from './playgroundExamples'
import grammar from '../../../../editors/vscode/syntaxes/milo.tmLanguage.json'

const base = import.meta.env.BASE_URL
const TIMEOUT_MS = 10000

const exampleId = ref(EXAMPLES[0].id)
const code = ref(EXAMPLES[0].code)
const lines = ref([])
const status = ref('')
const exitCode = ref(0)
const running = ref(false)
const mac = ref(false)
const taEl = ref(null)
const hlEl = ref(null)
const gutEl = ref(null)

function loadExample(id) {
  const e = EXAMPLES.find(x => x.id === id)
  if (e) { exampleId.value = id; code.value = e.code; lines.value = []; status.value = '' }
}

const gutter = computed(() => {
  const n = code.value.split('\n').length
  return Array.from({ length: n }, (_, i) => i + 1).join('\n')
})

// Highlighting reads the generated TextMate grammar (the same one the docs fences use), so a
// keyword added to the language shows up here without a second list.
const KIND = [
  ['comments', 'tok-com'], ['numbers', 'tok-num'], ['constants', 'tok-const'],
  ['keywords', 'tok-kw'], ['types', 'tok-type'],
]
const rules = []
for (const [repo, cls] of KIND) {
  for (const p of grammar.repository[repo].patterns) rules.push({ re: p.match, cls })
}
// Strings: "…" and $"…" with escapes, then char literals (the grammar's begin/end form does not
// fit a single regex).
rules.unshift({ re: '\\$?"(?:\\\\.|[^"\\\\\\n])*"?', cls: 'tok-str' }, { re: "'(?:\\\\.|[^'\\\\\\n])'", cls: 'tok-str' })
const TOKEN = new RegExp(rules.map((r, i) => `(?<t${i}>${r.re})`).join('|'), 'gm')
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

const highlighted = computed(() => {
  const src = code.value
  let out = '', last = 0
  TOKEN.lastIndex = 0
  for (let m; (m = TOKEN.exec(src)); ) {
    if (m[0] === '') { TOKEN.lastIndex++; continue }
    const g = rules.findIndex((_, i) => m.groups[`t${i}`] !== undefined)
    out += esc(src.slice(last, m.index)) + `<span class="${rules[g].cls}">${esc(m[0])}</span>`
    last = m.index + m[0].length
  }
  // The trailing newline keeps the overlay as tall as the textarea's last empty line.
  return out + esc(src.slice(last)) + '\n'
})

function syncScroll() {
  hlEl.value.scrollTop = taEl.value.scrollTop
  hlEl.value.scrollLeft = taEl.value.scrollLeft
  gutEl.value.scrollTop = taEl.value.scrollTop
}

function onKey(e) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); return }
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault()
    const ta = e.target, s = ta.selectionStart
    code.value = code.value.slice(0, s) + '    ' + code.value.slice(ta.selectionEnd)
    exampleId.value = ''
    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 4 })
  }
}

// The interpreter runs in a worker: a `while true {}` freezes the worker, not the page, and
// the timeout below kills and replaces it.
let worker = null
function spawn() {
  const url = new URL(base + 'playground/milo-playground.js', location.href).href
  const src = `import { run } from ${JSON.stringify(url)};
self.onmessage = (e) => { try { self.postMessage({ ok: run(e.data) }) } catch (err) { self.postMessage({ crash: String((err && err.stack) || err) }) } };
self.postMessage({ ready: true });`
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' })
  worker = w
  return new Promise((resolve, reject) => {
    w.onmessage = e => (e.data.ready ? resolve(w) : null)
    w.onerror = e => reject(new Error(e.message || 'could not load the playground bundle'))
  })
}

function exec(source) {
  return new Promise(async (resolve, reject) => {
    let w
    try { w = worker && !worker.dead ? worker : await spawn() } catch (err) { worker = null; reject(err); return }
    const timer = setTimeout(() => {
      w.terminate(); w.dead = true; worker = null
      reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s (infinite loop?)`))
    }, TIMEOUT_MS)
    w.onerror = e => { clearTimeout(timer); w.dead = true; worker = null; reject(new Error(e.message || 'worker error')) }
    w.onmessage = e => {
      clearTimeout(timer)
      if (e.data.crash) reject(new Error(e.data.crash)); else resolve(e.data.ok)
    }
    w.postMessage(source)
  })
}

function diagLines(d, src) {
  const kind = d.severity === 'error' ? 'err' : d.severity === 'warning' ? 'warn' : 'note'
  const out = [{ kind, text: `${d.severity}: ${d.message}` }]
  if (d.line) {
    out.push({ kind: 'loc', text: `  --> ${d.file ?? 'main.milo'}:${d.line}:${d.col ?? 1}` })
    const text = !d.file ? src.split('\n')[d.line - 1] : undefined
    if (text !== undefined) {
      out.push({ kind: 'loc', text: `  ${String(d.line).padStart(3)} | ${text}` })
      out.push({ kind, text: `      | ${' '.repeat(Math.max(0, (d.col ?? 1) - 1))}^` })
    }
  }
  if (d.hint) out.push({ kind: 'note', text: `  hint: ${d.hint}` })
  return out
}

async function run() {
  if (running.value) return
  running.value = true
  status.value = ''
  const src = code.value
  const t0 = performance.now()
  try {
    const r = await exec(src)
    const out = []
    for (const d of r.diagnostics) out.push(...diagLines(d, src))
    for (const l of r.stdout.replace(/\n$/, '').split('\n')) if (r.stdout) out.push({ kind: 'out', text: l })
    // `unsupported:` and stall messages come from the interpreter verbatim.
    for (const l of r.stderr.replace(/\n$/, '').split('\n')) if (r.stderr) out.push({ kind: 'err', text: l })
    lines.value = out
    exitCode.value = r.exitCode
    status.value = `exit ${r.exitCode} · ${Math.round(performance.now() - t0)} ms`
  } catch (err) {
    lines.value = [{ kind: 'err', text: String(err.message || err) }]
    exitCode.value = 1
    status.value = 'failed'
  } finally {
    running.value = false
  }
}

onMounted(() => {
  mac.value = /Mac|iPhone|iPad/.test(navigator.platform)
  // Fetch the bundle while the visitor reads, so the first Run is not a download.
  spawn().catch(() => { worker = null })
})
onBeforeUnmount(() => { worker?.terminate(); worker = null })
</script>

<style scoped>
.pg { margin-top: 16px; }
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.chip {
  padding: 5px 11px; border: 1px solid var(--vp-c-divider); border-radius: 999px;
  background: var(--vp-c-bg-soft); color: var(--vp-c-text-2); font-size: 13px; white-space: nowrap;
}
.chip:hover { color: var(--vp-c-text-1); border-color: var(--vp-c-brand-2); }
.chip.on { color: var(--vp-c-white); background: var(--vp-c-brand-2); border-color: var(--vp-c-brand-2); }
.chip.bad:not(.on) { border-style: dashed; }
.edited { font-size: 12px; color: var(--vp-c-text-3); }
/* Phones: every example visible at once (a sideways scroll hid most of them), and the
   playground runs edge to edge instead of inside the page's side padding. */
@media (max-width: 640px) {
  .pg { margin: 0 -24px; }
  .chips { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 0 12px; }
  .chip { white-space: normal; text-align: left; border-radius: 8px; padding: 7px 10px; line-height: 1.3; }
  .toolbar { padding: 0 12px; }
  .pg .editor, .pg .out-bar, .vp-doc .pg .out-pane { border-radius: 0; border-left: 0; border-right: 0; }
  .hint { display: none; }
}
.spacer { flex: 1; }
.hint { font-size: 12px; color: var(--vp-c-text-3); }
.run-btn {
  padding: 6px 18px; border-radius: 6px; font-weight: 600; font-size: 14px;
  background: var(--vp-button-brand-bg); color: var(--vp-button-brand-text); cursor: pointer;
}
.run-btn:hover:not(:disabled) { background: var(--vp-button-brand-hover-bg); }
.run-btn:disabled { opacity: .6; cursor: default; }

/* Textarea over a highlighted <pre> of the same text: identical font metrics keep them aligned. */
.editor {
  position: relative; height: 380px; border-radius: 8px; overflow: hidden;
  background: var(--vp-code-block-bg); border: 1px solid var(--vp-c-divider);
}
/* The gutter is GUTTER wide; the text layers start after it, with the same font metrics so
   line N of the gutter sits next to line N of the code. */
.editor { --gutter: 44px; }
.gutter, .hl, .ta {
  position: absolute; top: 0; bottom: 0; margin: 0; padding: 14px 16px; border: 0; box-sizing: border-box;
  font-family: var(--vp-font-family-mono); font-size: 13.5px; line-height: 1.6; tab-size: 4;
  white-space: pre; height: 100%;
}
.hl, .ta { left: var(--gutter); right: 0; width: calc(100% - var(--gutter)); overflow: auto; padding-left: 10px; }
.gutter {
  left: 0; width: var(--gutter); padding: 14px 8px 14px 0; text-align: right; overflow: hidden;
  color: var(--vp-c-text-3); background: var(--vp-c-bg-alt); border-right: 1px solid var(--vp-c-divider);
  user-select: none; pointer-events: none;
}
.hl { pointer-events: none; color: var(--vp-c-text-1); background: transparent; }
.hl code { font: inherit; background: none; padding: 0; color: inherit; }
.ta {
  resize: none; background: transparent; color: transparent; caret-color: var(--vp-c-text-1); outline: none;
}
.ta::selection { background: var(--vp-c-brand-soft); }
.ta:focus-visible { box-shadow: inset 0 0 0 2px var(--vp-c-brand-1); }
.hl :deep(.tok-kw) { color: var(--vp-c-brand-1); font-weight: 600; }
.hl :deep(.tok-type) { color: var(--vp-c-indigo-1, #6366f1); }
.hl :deep(.tok-str) { color: var(--vp-c-green-1, #16a34a); }
.hl :deep(.tok-num), .hl :deep(.tok-const) { color: var(--vp-c-yellow-1, #ca8a04); }
.hl :deep(.tok-com) { color: var(--vp-c-text-3); font-style: italic; }

.out-bar {
  display: flex; justify-content: space-between; margin-top: 14px; padding: 8px 16px;
  font-size: 12px; color: var(--vp-c-text-3); border: 1px solid var(--vp-c-divider);
  border-bottom: 0; border-radius: 8px 8px 0 0; background: var(--vp-code-block-bg);
}
.status.bad { color: var(--vp-c-danger-1); }
.vp-doc .out-pane {
  margin: 0; padding: 14px 16px; min-height: 90px; max-height: 320px; overflow: auto;
  border: 1px solid var(--vp-c-divider); border-radius: 0 0 8px 8px; background: var(--vp-code-block-bg);
  font-family: var(--vp-font-family-mono); font-size: var(--vp-code-font-size); line-height: var(--vp-code-line-height);
  color: var(--vp-c-text-1); white-space: pre-wrap; overflow-wrap: anywhere;
}
.out-pane .err { color: var(--vp-c-danger-1); }
.out-pane .warn { color: var(--vp-c-warning-1); }
.out-pane .note, .out-pane .loc, .out-pane .muted { color: var(--vp-c-text-3); }
</style>
