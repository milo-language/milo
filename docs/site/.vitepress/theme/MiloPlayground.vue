<template>
  <div class="playground">
    <div class="toolbar">
      <span class="title">Playground</span>
      <span class="divider"></span>
      <div class="examples">
        <button
          v-for="(_, name) in examples"
          :key="name"
          :class="['example-btn', { active: selected === name }]"
          @click="selected = name; loadExample()"
        >{{ name }}</button>
      </div>
      <span class="spacer"></span>
      <button class="run-btn" @click="run">▶ Run</button>
      <span class="status" :class="statusClass">{{ statusText }}</span>
    </div>
    <div class="panels">
      <div class="panel editor-panel">
        <div class="panel-label">Source</div>
        <div ref="editorEl" class="cm-host"></div>
      </div>
      <div class="panel">
        <div class="panel-label">Output</div>
        <pre class="output" :class="outputClass">{{ output }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, shallowRef } from 'vue'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup } from 'codemirror'

const miloLang = StreamLanguage.define({
  token(stream) {
    if (stream.match(/\/\/.*/)) return 'comment'
    if (stream.match(/"([^"\\]|\\.)*"/)) return 'string'
    if (stream.match(/\d+\.\d*/)) return 'number'
    if (stream.match(/\d+/)) return 'number'
    if (stream.match(/\b(fn|let|var|if|else|while|for|in|return|match|struct|enum|import|from|break|continue|unsafe|impl|trait|pub|mut|as|is)\b/))
      return 'keyword'
    if (stream.match(/\b(true|false)\b/)) return 'atom'
    if (stream.match(/\b(i32|i64|u8|u16|u32|u64|f32|f64|bool|string|void|Vec|HashMap|Option|Result|Box|Self)\b/))
      return 'typeName'
    if (stream.match(/=>/)) return 'operator'
    if (stream.match(/[+\-*/%=!<>&|^~?]+/)) return 'operator'
    if (stream.match(/[a-zA-Z_]\w*/)) return 'variableName'
    stream.next()
    return null
  },
})

const examples = {
  'FizzBuzz': `fn main(): i32 {
    var i: i32 = 1
    while i <= 20 {
        if i % 15 == 0 {
            print("FizzBuzz")
        } else if i % 3 == 0 {
            print("Fizz")
        } else if i % 5 == 0 {
            print("Buzz")
        } else {
            print(i)
        }
        i = i + 1
    }
    return 0
}`,
  'Structs': `struct Point {
    x: f64,
    y: f64,
}

fn manhattan(a: Point, b: Point): f64 {
    var dx = a.x - b.x
    var dy = a.y - b.y
    if dx < 0.0 { dx = 0.0 - dx }
    if dy < 0.0 { dy = 0.0 - dy }
    return dx + dy
}

fn main(): i32 {
    let p1 = Point { x: 1.0, y: 2.0 }
    let p2 = Point { x: 4.0, y: 6.0 }
    print("p1: (", p1.x, ", ", p1.y, ")")
    print("p2: (", p2.x, ", ", p2.y, ")")
    print("manhattan distance: ", manhattan(p1, p2))
    return 0
}`,
  'Enums': `enum Shape {
    Circle(f64),
    Rect(f64, f64),
}

fn area(s: Shape): f64 {
    match s {
        Shape.Circle(r) => {
            return 3.14159 * r * r
        }
        Shape.Rect(w, h) => {
            return w * h
        }
    }
}

fn main(): i32 {
    print("circle area: ", area(Shape.Circle(5.0)))
    print("rect area: ", area(Shape.Rect(3.0, 4.0)))
    return 0
}`,
  'Closures': `fn main(): i32 {
    var nums: Vec<i32> = Vec.new()
    nums.push(1)
    nums.push(2)
    nums.push(3)
    nums.push(4)
    nums.push(5)

    let doubled = nums.map((x: i32): i32 => x * 2)
    let evens = nums.filter((x: i32): bool => x % 2 == 0)

    print("doubled:")
    for d in doubled {
        print("  ", d)
    }
    print("evens:")
    for e in evens {
        print("  ", e)
    }
    return 0
}`,
  'Generics': `struct Pair<A, B> {
    first: A,
    second: B,
}

fn swap<A, B>(p: Pair<A, B>): Pair<B, A> {
    return Pair { first: p.second, second: p.first }
}

fn main(): i32 {
    let p = Pair { first: 42, second: "hello" }
    print("before: ", p.first, " ", p.second)
    let s = swap(p)
    print("after: ", s.first, " ", s.second)
    return 0
}`,
  'Vec': `fn main(): i32 {
    var items: Vec<string> = ["apple", "banana", "cherry"]

    print("count: ", items.len())

    for item in items {
        print("- ", item)
    }

    items.push("date")
    print("after push: ", items.len())
    return 0
}`,
}

const selected = ref('FizzBuzz')
const output = ref('')
const statusText = ref('')
const statusClass = ref('')
const outputClass = ref('')
const editorEl = ref(null)
const view = shallowRef(null)
let playground = null

function loadExample() {
  if (view.value) {
    view.value.dispatch({
      changes: { from: 0, to: view.value.state.doc.length, insert: examples[selected.value] }
    })
  }
  run()
}

function run() {
  if (!playground) {
    output.value = 'Loading compiler...'
    return
  }
  const src = view.value ? view.value.state.doc.toString() : ''
  const t0 = performance.now()
  const result = playground.compileAndRun(src)
  const ms = (performance.now() - t0).toFixed(1)

  if (!result.ok) {
    output.value = result.error
    outputClass.value = 'error'
    statusText.value = `failed (${ms}ms)`
    statusClass.value = 'err'
  } else {
    output.value = result.output || '(no output)'
    outputClass.value = ''
    statusText.value = `ok (${ms}ms)`
    statusClass.value = 'ok'
  }
}

onMounted(async () => {
  const runKeymap = keymap.of([{
    key: 'Mod-Enter',
    run: () => { run(); return true },
  }])

  view.value = new EditorView({
    state: EditorState.create({
      doc: examples['FizzBuzz'],
      extensions: [
        basicSetup,
        miloLang,
        oneDark,
        runKeymap,
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'var(--vp-c-bg)' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--vp-font-family-mono)', fontSize: '0.8rem' },
          '.cm-content': { padding: '0.5rem 0' },
          '.cm-gutters': { backgroundColor: 'var(--vp-c-bg)', borderRight: '1px solid var(--vp-c-border)' },
          '.cm-activeLineGutter': { backgroundColor: 'var(--vp-c-bg-soft)' },
          '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
        }),
      ],
    }),
    parent: editorEl.value,
  })

  const script = document.createElement('script')
  script.type = 'module'
  script.textContent = `
    import "${import.meta.env.BASE_URL}playground/compiler.js";
    window.__miloReady = true;
    window.dispatchEvent(new Event('milo-ready'));
  `
  document.head.appendChild(script)

  if (window.__miloReady) {
    playground = window.MiloPlayground
    run()
  } else {
    window.addEventListener('milo-ready', () => {
      playground = window.MiloPlayground
      run()
    })
  }
})
</script>

<style scoped>
.playground {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--vp-nav-height, 64px) - 1px);
  border-top: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg-soft);
  margin: 0 calc(-1 * var(--vp-offset, 0px));
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg);
  flex-shrink: 0;
}
.title {
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--vp-c-text-1);
  white-space: nowrap;
}
.divider {
  width: 1px;
  height: 1.2rem;
  background: var(--vp-c-border);
}
.spacer { flex: 1; }
.examples {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.example-btn {
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 4px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s;
}
.example-btn:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.example-btn.active {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}
.run-btn {
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  padding: 0.35rem 1rem;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 4px;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
  cursor: pointer;
  font-weight: 600;
}
.run-btn:hover { opacity: 0.9; }
.status { font-size: 0.75rem; }
.status.ok { color: var(--vp-c-green-1); }
.status.err { color: var(--vp-c-red-1); }
.panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  flex: 1;
  min-height: 0;
}
@media (max-width: 768px) {
  .panels { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
}
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--vp-c-border);
}
.panel:last-child { border-right: none; }
.panel-label {
  font-size: 0.7rem;
  padding: 0.3rem 0.75rem;
  color: var(--vp-c-text-3);
  border-bottom: 1px solid var(--vp-c-border);
  background: var(--vp-c-bg);
  flex-shrink: 0;
}
.cm-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.output {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0.75rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow: auto;
  color: var(--vp-c-text-1);
}
.output.error { color: var(--vp-c-red-1); }
</style>
