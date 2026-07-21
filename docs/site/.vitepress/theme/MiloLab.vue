<!--
  MiloLab — the single "learn + play" widget. The 10 lessons and the free-form
  playground are the same surface: every lesson IS an editable playground preloaded
  with a concept, and a final Sandbox tab is a blank slate with an example library.
  CodeMirror editor + the in-browser emit-js compiler (playground/compiler.js).
  Lessons gate the next step on a successful run; Sandbox never gates.
  Native-only lessons (green threads, `milo prove`) replay captured output because
  the browser compiler has no native runtime — flagged in the output header.
-->
<template>
  <div class="lab" ref="rootEl">
    <div class="lab-head">
      <img class="lab-mascot" :src="base + 'mascot.svg'" alt="Milo the lab dog" width="72" height="72" />
      <div class="kicker">Interactive · runs in your browser</div>
      <h2 class="title">Learn Milo by running it</h2>
      <p class="sub">Try Milo in your browser! Milo has multiple backends — it builds native binaries, and also JavaScript to run right here in your browser.</p>
    </div>

    <!-- rail: Sandbox (free play) first, then the 10 lessons -->
    <div class="rail" role="tablist" aria-label="Lessons">
      <button class="pip sb" :class="{ cur: sandbox }" title="Sandbox — free play" @click="openSandbox">Sandbox</button>
      <button
        v-for="(c, i) in concepts" :key="i"
        class="pip" :class="{ cur: i === cur && !sandbox, ok: ran[i], reachable: i <= maxReached }"
        :aria-selected="i === cur && !sandbox"
        :title="(i + 1) + '. ' + c.title"
        @click="go(i)">
        <span v-if="ran[i]" class="tick">✓</span><span v-else>{{ i + 1 }}</span>
      </button>
    </div>

    <!-- No :key here — a re-key would tear down and rebuild .cm-host, orphaning the
         imperatively-mounted CodeMirror view. Content swaps happen via setDoc() instead. -->
    <div class="card">
      <div class="chead">
        <template v-if="!sandbox">
          <span class="step">Step {{ cur + 1 }} of {{ concepts.length }}</span>
          <h3 class="ct" v-html="cur + 1 + '. ' + concepts[cur].title"></h3>
          <p class="cd" v-html="concepts[cur].desc"></p>
        </template>
        <template v-else>
          <span class="step">Sandbox</span>
          <h3 class="ct">Free play</h3>
          <p class="cd">Edit anything and run it. Load a starter below, or start from scratch. <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> runs.</p>
          <div class="examples">
            <button
              v-for="(_, name) in examples" :key="name"
              class="ex-btn" :class="{ active: sbExample === name }"
              @click="loadExample(name)">{{ name }}</button>
          </div>
        </template>
      </div>

      <div class="panels">
        <div class="pane">
          <div class="ph">
            <span class="dot d1"></span><span class="dot d2"></span><span class="dot d3"></span>
            <span class="fname">{{ sandbox ? 'sandbox.milo' : concepts[cur].file }}</span>
            <span class="sp"></span>
            <span v-if="edited" class="edited">edited</span>
            <button v-if="edited" class="btn ghost" @click="reset">reset</button>
            <button class="btn run" :disabled="running" @click="run">
              <span class="tri">{{ running ? '▶' : (!sandbox && ran[cur] ? '↻' : '▶') }}</span>
              {{ running ? 'Running' : (!sandbox && ran[cur] ? 'Run again' : 'Run') }}
            </button>
            <transition name="pop">
              <button v-if="!sandbox && ran[cur] && cur < concepts.length - 1" class="btn next-cta" @click="next">Next →</button>
              <button v-else-if="!sandbox && ran[cur]" class="btn next-cta" @click="openSandbox">Sandbox</button>
            </transition>
          </div>
          <div class="editor"><div ref="cmEl" class="cm-host"></div></div>
        </div>

        <div class="pane">
          <div class="ph">
            <span class="fname dim">output</span>
            <span class="sp"></span>
            <span v-if="!sandbox && concepts[cur].native" class="native">native runtime</span>
            <span v-else-if="!compilerReady" class="native">loading compiler…</span>
          </div>
          <div class="term">
            <div v-if="!outLines.length" class="idle">// edit the code, then press Run</div>
            <template v-else>
              <div class="ttag">{{ outTag }}</div>
              <div v-for="(l, k) in outLines" :key="k" class="oline" :class="{ err: outErr }">
                <span v-if="!outErr && l !== ''" class="arrow">› </span>{{ l === '' ? ' ' : l }}
              </div>
            </template>
          </div>
        </div>
      </div>

      <div v-if="!sandbox" class="take">
        <span class="tk">{{ concepts[cur].err ? 'safety' : (concepts[cur].native ? 'note' : 'takeaway') }}</span>
        <span v-html="concepts[cur].take"></span>
      </div>

      <div class="foot">
        <button v-if="!sandbox" class="nav" :disabled="cur === 0" @click="go(cur - 1)">← Back</button>
        <span v-if="!sandbox" class="prog"><b>{{ ranCount }}</b> / {{ concepts.length }} run</span>
        <span v-if="!sandbox && !ran[cur]" class="foot-hint">Run the program to unlock the next step</span>
        <span v-if="sandbox" class="foot-hint sb-hint">Back to <a @click.prevent="go(0)" href="#">the lessons</a></span>
      </div>
    </div>

    <div v-if="allDone && !sandbox" class="done">
      🎉 You ran every lesson. Keep going in the <a @click.prevent="openSandbox" href="#">Sandbox</a>,
      <a :href="base + 'getting-started/installation'">install Milo</a>, or read the <a :href="base + 'language/'">language guide</a>.
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch, shallowRef } from 'vue'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup } from 'codemirror'

const props = defineProps({
  // 'lesson' (default) opens on step 1; 'sandbox' opens the free-play tab.
  startMode: { type: String, default: 'lesson' },
})

const base = import.meta.env.BASE_URL

// ---- lessons: verified programs + captured native output (fallback) ----
const concepts = [
  { title: 'Immutable by default (let vs var)', file: 'values.milo',
    desc: 'A <code>let</code> binding is immutable; a <code>var</code> is mutable. You opt <em>in</em> to change.',
    take: 'Immutable by default — you always know what can change out from under you.',
    out: ['hello from Milo, count = 3'],
    code: `fn main(): i32 {
    let name = "Milo"        // immutable
    var count = 0            // mutable
    count = count + 3
    print($"hello from {name}, count = {count}")
    return 0
}` },
  { title: 'Structs and borrows', file: 'geometry.milo',
    desc: 'Group data in a <code>struct</code>; functions borrow it with <code>&</code> — read access without taking ownership.',
    take: 'A <code>&Point</code> is a second-class reference: usable as an argument, never stored or returned.',
    out: ['distance = 5'],
    code: `from "std/math" import { sqrt }

struct Point { x: f64, y: f64 }

fn dist(a: &Point, b: &Point): f64 {
    let dx = a.x - b.x
    let dy = a.y - b.y
    return sqrt(dx * dx + dy * dy)
}

fn main(): i32 {
    let origin = Point { x: 0.0, y: 0.0 }
    let p = Point { x: 3.0, y: 4.0 }
    print($"distance = {dist(origin, p)}")
    return 0
}` },
  { title: 'Enums and exhaustive match', file: 'shapes.milo',
    desc: 'Enums are sum types that carry data. <code>match</code> must handle every variant — miss one and it won’t compile.',
    take: 'Forget a case and the checker stops you, so new variants surface everywhere they matter.',
    out: ['circle: 12.5664', 'rect:   12'],
    code: `enum Shape {
    Circle(f64),
    Rect(f64, f64),
}

fn area(s: &Shape): f64 {
    match s {
        Shape.Circle(r) => { return 3.14159 * r * r }
        Shape.Rect(w, h) => { return w * h }
    }
}

fn main(): i32 {
    print($"circle: {area(Shape.Circle(2.0))}")
    print($"rect:   {area(Shape.Rect(3.0, 4.0))}")
    return 0
}` },
  { title: 'Contracts — checked or proven', file: 'clamp.milo',
    desc: 'Annotate a function with <code>requires</code> (what the caller must guarantee) and <code>ensures</code> (what it promises back), written in ordinary Milo. With no solver installed, each becomes a checked runtime assertion. With <code>z3</code>, <code>milo prove</code> discharges them at compile time and deletes the check.',
    take: 'Gradual verification: proven conditions cost nothing at runtime, the rest fall back to runtime checks — you are never forced to hand-write a proof the way Lean or Dafny demand. When <code>prove</code> can’t discharge a condition it hands you the failing input, not a proof obligation. It proves the properties <em>you state</em> — not that the whole program is bug-free. Memory safety (no use-after-free, no data races) is separate, and always on whether or not you write a single contract.',
    out: ['$ milo prove clamp.milo', '  ✓ [postcondition] clamp: proven', '', '$ milo run clamp.milo', '10'],
    code: `fn clamp(value: i64, lo: i64, hi: i64): i64
requires lo <= hi
ensures result >= lo && result <= hi
{
    if value < lo { return lo }
    if value > hi { return hi }
    return value
}

fn main(): i32 {
    print(clamp(42, 0, 10))
    return 0
}` },
  { title: 'Errors are values, not exceptions', file: 'errors.milo',
    desc: 'Fallible functions return <code>Result</code>. The <code>?</code> operator unwraps success and returns the error early.',
    take: 'Every failure is in the type signature; <code>?</code> keeps the happy path readable.',
    out: ['next year: 43', 'error: empty input'],
    code: `fn parseAge(s: string): Result<i32> {
    if s == "" { return Result.Err("empty input") }
    return Result.Ok(42)
}

fn nextYear(s: string): Result<i32> {
    let age = parseAge(s)?      // unwraps Ok, or returns Err
    return Result.Ok(age + 1)
}

fn main(): i32 {
    match nextYear("hi") {
        Result.Ok(v)  => { print($"next year: {v}") }
        Result.Err(e) => { print($"error: {e}") }
    }
    match nextYear("") {
        Result.Ok(v)  => { print($"next year: {v}") }
        Result.Err(e) => { print($"error: {e}") }
    }
    return 0
}` },
  { title: 'Parse JSON into typed values', file: 'json.milo',
    desc: '<code>jsonParse</code> returns a <code>Result</code>; <code>!</code> unwraps it or aborts. <code>.get()</code> returns an <code>Option</code> per key, and typed accessors like <code>asStr</code> / <code>asI64</code> pull each value out — an <code>Option</code> you must handle.',
    take: 'JSON lives in the standard library, written in Milo. Values come out <em>typed</em> — <code>asI64</code>, <code>asStr</code>, <code>asBool</code> — no stringly-typed blobs, no unchecked casts.',
    out: ['name: milo', 'stars: 42'],
    code: `from "std/json" import { jsonParse }

fn main(): i32 {
    // The kind of document an HTTP body would carry — here as a literal.
    let src = "{\\"name\\": \\"milo\\", \\"stars\\": 42, \\"safe\\": true}"

    let doc = jsonParse(src)!                     // Result — ! unwraps or aborts
    if let Option.Some(v) = doc.get("name") {
        if let Option.Some(s) = v.asStr() { print($"name: {s}") }
    }
    if let Option.Some(v) = doc.get("stars") {
        if let Option.Some(n) = v.asI64() { print($"stars: {n}") }
    }
    return 0
}` },
  { title: 'Closures and iterators', file: 'closures.milo',
    desc: 'Pass a lambda to <code>.map</code>. Closures capture their environment and compose over collections.',
    take: 'Functions are values — closures, <code>.map</code>, <code>.filter</code>, <code>for..in</code> all work as you’d hope.',
    out: ['2', '4', '6'],
    code: `fn main(): i32 {
    var nums: Vec<i32> = Vec.new()
    nums.push(1)
    nums.push(2)
    nums.push(3)
    let doubled = nums.map((n: i32): i32 => n * 2)
    for x in doubled {
        print(x)
    }
    return 0
}` },
  { title: 'Generics, monomorphized', file: 'generics.milo',
    desc: 'Write once over a type parameter; the compiler stamps out a specialized copy per concrete type — no boxing.',
    take: 'Inference fills in the type params; monomorphization keeps it as fast as hand-written code.',
    out: ['milo 42'],
    code: `struct Pair<A, B> { first: A, second: B }

fn swap<A, B>(p: Pair<A, B>): Pair<B, A> {
    return Pair { first: p.second, second: p.first }
}

fn main(): i32 {
    let p = swap(Pair { first: 42, second: "milo" })
    print($"{p.first} {p.second}")
    return 0
}` },
  { title: 'Interfaces and dynamic dispatch', file: 'traits.milo',
    desc: 'An <code>interface</code> defines behavior; any struct can <code>impl</code> it. A <code>&Greeter</code> is a trait object.',
    take: 'One call site, many concrete types — dispatched through a fat pointer of data plus a method table.',
    out: ['Woof', 'Meow'],
    code: `interface Greeter {
    fn greet(self: &Self): string
}

struct Dog {}
impl Dog { fn greet(self: &Self): string { return "Woof" } }

struct Cat {}
impl Cat { fn greet(self: &Self): string { return "Meow" } }

fn announce(g: &Greeter) {
    print(g.greet())
}

fn main(): i32 {
    announce(Dog {})
    announce(Cat {})
    return 0
}` },
  { title: 'Collections', file: 'scores.milo',
    desc: 'A growable <code>Vec</code> and a <code>HashMap</code> come built in. Lookups return an <code>Option</code>.',
    take: 'A missing key is <code>Option.None</code>, not a crash — you handle it at the <code>match</code>.',
    out: ['alice scored 92', 'players: 2'],
    code: `fn main(): i32 {
    var scores: HashMap<string, i32> = HashMap.new()
    scores.insert("alice", 92)
    scores.insert("bob", 87)

    match scores.get("alice") {
        Option.Some(s) => { print($"alice scored {s}") }
        Option.None    => { print("no score") }
    }
    print($"players: {scores.len}")
    return 0
}` },
  { title: 'Ownership and moves', file: 'ownership.milo', err: true,
    desc: 'A heap value like <code>string</code> has one owner. <code>let b = a</code> <em>moves</em> it, so using <code>a</code> after is a compile error. Run it as-is — then change line 3 to <code>a.clone()</code> and run again.',
    take: 'Small types (<code>i32</code>, <code>f64</code>) copy automatically. For heap values you pick: <code>.clone()</code> for a real copy, or <code>&a</code> to borrow and just read it. Copies are never silent, and there’s no GC cleaning up behind you.',
    out: ['error: use of moved variable \'a\'', '  ──> ownership.milo:4:11', '  │', '4 │     print(a)             // error: a was moved away', '  │           ^', '  hint: ownership of \'a\' was transferred earlier and it can no longer be used here. To keep it alive, clone it at the point of transfer: \'a.clone()\'.'],
    code: `fn main(): i32 {
    let a = "owned string"
    let b = a            // moves a -> b   (try: let b = a.clone())
    print(a)             // error: a was moved away
    print(b)
    return 0
}` },
  { title: 'Putting it together', file: 'sales.milo',
    desc: 'A small program using the pieces from earlier lessons at once: <code>struct</code>s in a <code>Vec</code>, a computed field, an <code>if</code> used as an expression, and <code>.filter</code> with a closure.',
    take: 'Nothing new here — structs, a Vec, an if-expression, and a closure compose into a real program. That’s the whole surface for everyday code.',
    out: ['widget: 3 x 250 = 750  <- big', 'gadget: 1 x 999 = 999  <- big', 'gizmo: 5 x 120 = 600', 'total = 2349 cents across 3 sales, 2 in bulk'],
    code: `struct Sale { item: string, qty: i32, price: i32 }

fn main(): i32 {
    let sales: Vec<Sale> = [
        Sale { item: "widget", qty: 3, price: 250 },
        Sale { item: "gadget", qty: 1, price: 999 },
        Sale { item: "gizmo",  qty: 5, price: 120 },
    ]
    var total: i32 = 0
    for s in sales {
        let line = s.qty * s.price
        total = total + line
        let flag = if line > 700 { "  <- big" } else { "" }
        print($"{s.item}: {s.qty} x {s.price} = {line}{flag}")
    }
    let bulk = sales.filter((s) => s.qty >= 3)   // closure predicate
    print($"total = {total} cents across {sales.len} sales, {bulk.len} in bulk")
    return 0
}` },
]

// ---- sandbox example library ----
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
  'Structs': `struct Point { x: f64, y: f64 }

fn manhattan(a: &Point, b: &Point): f64 {
    var dx = a.x - b.x
    var dy = a.y - b.y
    if dx < 0.0 { dx = 0.0 - dx }
    if dy < 0.0 { dy = 0.0 - dy }
    return dx + dy
}

fn main(): i32 {
    let p1 = Point { x: 1.0, y: 2.0 }
    let p2 = Point { x: 4.0, y: 6.0 }
    print($"distance = {manhattan(p1, p2)}")
    return 0
}`,
  'Enums': `enum Shape {
    Circle(f64),
    Rect(f64, f64),
}

fn area(s: &Shape): f64 {
    match s {
        Shape.Circle(r) => { return 3.14159 * r * r }
        Shape.Rect(w, h) => { return w * h }
    }
}

fn main(): i32 {
    let shapes: Vec<Shape> = [Shape.Circle(5.0), Shape.Rect(3.0, 4.0)]
    for s in shapes { print($"area = {area(s)}") }
    return 0
}`,
  'Closures': `fn main(): i32 {
    var nums: Vec<i32> = [1, 2, 3, 4, 5]
    let doubled = nums.map((x: i32): i32 => x * 2)
    let evens = nums.filter((x: i32): bool => x % 2 == 0)
    for d in doubled { print(d) }
    for e in evens { print(e) }
    return 0
}`,
  'Generics': `struct Pair<A, B> { first: A, second: B }

fn swap<A, B>(p: Pair<A, B>): Pair<B, A> {
    return Pair { first: p.second, second: p.first }
}

fn main(): i32 {
    let p = swap(Pair { first: 42, second: "hello" })
    print($"{p.first} {p.second}")
    return 0
}`,
  'Vec': `fn main(): i32 {
    var items: Vec<string> = ["apple", "banana", "cherry"]
    print($"count: {items.len()}")
    for item in items { print($"- {item}") }
    items.push("date")
    print($"after push: {items.len()}")
    return 0
}`,
  'Errors': `fn parseAge(s: string): Result<i32> {
    if s == "" { return Result.Err("empty input") }
    return Result.Ok(42)
}

fn nextYear(s: string): Result<i32> {
    let age = parseAge(s)?      // unwraps Ok, or returns Err early
    return Result.Ok(age + 1)
}

fn main(): i32 {
    match nextYear("bob") {
        Result.Ok(v) => { print($"next year: {v}") }
        Result.Err(e) => { print($"error: {e}") }
    }
    match nextYear("") {
        Result.Ok(v) => { print($"next year: {v}") }
        Result.Err(e) => { print($"error: {e}") }
    }
    return 0
}`,
  'Contracts': `// requires = caller's obligation, ensures = the function's promise.
// With no solver, each becomes a checked runtime assertion;
// 'milo prove' (with z3) discharges them at compile time for free.
fn clamp(value: i64, lo: i64, hi: i64): i64
requires lo <= hi
ensures result >= lo && result <= hi
{
    if value < lo { return lo }
    if value > hi { return hi }
    return value
}

fn main(): i32 {
    print(clamp(42, 0, 10))
    print(clamp(-5, 0, 10))
    return 0
}`,
}

// ---- syntax highlighting for CodeMirror ----
const miloLang = StreamLanguage.define({
  token(stream) {
    if (stream.match(/\/\/.*/)) return 'comment'
    if (stream.match(/\$?"([^"\\]|\\.)*"/)) return 'string'
    if (stream.match(/\d+\.\d*/) || stream.match(/\d+/)) return 'number'
    if (stream.match(/\b(fn|let|var|if|else|while|for|in|return|match|struct|enum|interface|impl|import|from|move|break|continue|unsafe|trait|pub|mut|as|is|requires|ensures)\b/))
      return 'keyword'
    if (stream.match(/\b(true|false|self|Self)\b/)) return 'atom'
    if (stream.match(/\b(i8|i16|i32|i64|u8|u16|u32|u64|f32|f64|bool|string|void|Vec|HashMap|Option|Result|Box|Channel|Task|Promise)\b/))
      return 'typeName'
    if (stream.match(/=>/) || stream.match(/[+\-*/%=!<>&|^~?]+/)) return 'operator'
    if (stream.match(/[a-zA-Z_]\w*/)) return 'variableName'
    stream.next()
    return null
  },
})

// ---- state ----
// srcs holds per-lesson editor buffers plus a trailing slot (index = concepts.length)
// for the sandbox, so switching tabs preserves every buffer's edits.
const SB = concepts.length
const cur = ref(0)
const sandbox = ref(false)
const maxReached = ref(0)
// Sandbox opens on a minimal skeleton, not a full program — a blank slate to type into.
const sandboxStarter = `fn main(): i32 {
    print("Hello from Milo!")
    return 0
}`
const srcs = ref([...concepts.map(c => c.code), sandboxStarter])
const sbExample = ref('')
const ran = ref(concepts.map(() => false))
const running = ref(false)
const outLines = ref([])
const outErr = ref(false)
const outTag = ref('')
const compilerReady = ref(false)
let playground = null

const rootEl = ref(null)
const cmEl = ref(null)
const view = shallowRef(null)
let applying = false  // guard: suppress the update-listener while we set the doc programmatically

const slot = computed(() => (sandbox.value ? SB : cur.value))
const edited = computed(() => !sandbox.value && srcs.value[cur.value] !== concepts[cur.value].code)
const ranCount = computed(() => ran.value.filter(Boolean).length)
const allDone = computed(() => ran.value.every(Boolean))

function setDoc(text) {
  if (!view.value) return
  applying = true
  view.value.dispatch({ changes: { from: 0, to: view.value.state.doc.length, insert: text } })
  applying = false
}

function reset() {
  srcs.value[cur.value] = concepts[cur.value].code
  setDoc(concepts[cur.value].code)
}

function loadExample(name) {
  sbExample.value = name
  srcs.value[SB] = examples[name]
  setDoc(examples[name])
  run()
}

function showOutput(lines, isErr, tag) {
  outErr.value = isErr
  outTag.value = tag
  outLines.value = lines.slice()
}

function run() {
  const native = !sandbox.value && concepts[cur.value].native
  const errLesson = !sandbox.value && concepts[cur.value].err
  const file = sandbox.value ? 'sandbox.milo' : concepts[cur.value].file
  running.value = true
  const finishRun = () => { running.value = false; if (!sandbox.value) ran.value[cur.value] = true }

  if (compilerReady.value && playground && !native) {
    const src = view.value ? view.value.state.doc.toString() : srcs.value[slot.value]
    let r
    try { r = playground.compileAndRun(src) }
    catch (ex) { r = { ok: false, error: String((ex && ex.message) || ex) } }
    if (r.ok) {
      const o = (r.output == null) ? '' : r.output
      const lines = o === '' ? ['(no output)'] : o.replace(/\n$/, '').split('\n')
      showOutput(lines, false, file + ' · compiled to JS · exit 0')
    } else {
      const errLines = String(r.error || 'error').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '').split('\n')
      showOutput(errLines, true, file + ' · rejected by the checker')
    }
    finishRun()
    return
  }
  // native-only lesson, or compiler not yet loaded: replay captured output
  const c = sandbox.value ? null : concepts[cur.value]
  if (c) showOutput(c.out, !!c.err, file + (c.native ? ' · native binary · exit 0' : (c.err ? ' · compile' : ' · exit 0')))
  else showOutput(['loading compiler…'], false, file)
  finishRun()
}

function go(i) {
  if (i < 0 || i >= concepts.length) return
  sandbox.value = false
  cur.value = i
  maxReached.value = Math.max(maxReached.value, i)
  outLines.value = []
  setDoc(srcs.value[i])
  scrollToTop()
}
function next() { go(cur.value + 1) }
function openSandbox() {
  sandbox.value = true
  outLines.value = []
  setDoc(srcs.value[SB])
  scrollToTop()
}
function scrollToTop() {
  nextTick(() => { if (rootEl.value) rootEl.value.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) })
}

onMounted(() => {
  if (typeof window === 'undefined') return

  view.value = new EditorView({
    state: EditorState.create({
      doc: srcs.value[props.startMode === 'sandbox' ? SB : 0],
      extensions: [
        basicSetup,
        miloLang,
        oneDark,
        keymap.of([{ key: 'Mod-Enter', run: () => { run(); return true } }]),
        EditorView.updateListener.of(u => {
          if (u.docChanged && !applying) srcs.value[slot.value] = u.state.doc.toString()
        }),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'transparent' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--vp-font-family-mono)', fontSize: '12.75px', lineHeight: '1.6' },
          '.cm-content': { padding: '10px 0' },
          '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
          '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
          '.cm-activeLineGutter': { backgroundColor: 'transparent' },
        }),
      ],
    }),
    parent: cmEl.value,
  })

  if (props.startMode === 'sandbox') sandbox.value = true

  const attach = () => { playground = window.MiloPlayground; compilerReady.value = !!playground }
  if (window.MiloPlayground) { attach(); return }
  const s = document.createElement('script')
  s.type = 'module'
  s.textContent = `import "${base}playground/compiler.js"; window.__miloReady = true; window.dispatchEvent(new Event('milo-ready'));`
  s.onerror = () => {}
  document.head.appendChild(s)
  if (window.__miloReady) attach()
  else window.addEventListener('milo-ready', attach, { once: true })
})
</script>

<style scoped>
.lab {
  --edge: var(--vp-c-divider);
  --brand: var(--vp-c-brand-1);
  /* Warm charcoal panels tuned to the site's warm dark palette (page bg is
     ~#16130f, brand is amber). The old values were a cool navy (#0d1320) that
     clashed — blue panels on a warm amber site read as a different theme. */
  --con-bg: #17130e; --con-surf: #201a13; --con-edge: #37301f; --con-text: #e3dccb;
  --c-com: #8a7f6a;
  margin: 40px 0 8px; font-family: var(--vp-font-family-base);
}
.lab-head { text-align: center; margin-bottom: 22px; }
.lab-mascot { display: block; margin: 0 auto 6px; width: 72px; height: 72px; }
.kicker { font-family: var(--vp-font-family-mono); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--brand); }
.title { font-size: 1.9rem; font-weight: 750; letter-spacing: -.02em; margin: 8px 0 6px; border: 0; padding: 0; }
.sub { color: var(--vp-c-text-2); margin: 0; }

.rail { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 0 0 20px; }
.pip {
  width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--edge);
  background: var(--vp-c-bg-soft); color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono); font-size: 13px; font-weight: 600; cursor: pointer;
  display: grid; place-items: center; transition: all .15s;
}
.pip:hover { border-color: var(--brand); color: var(--vp-c-text-1); }
.pip.cur { border-color: var(--brand); color: var(--brand); box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 22%, transparent); }
.pip.ok { color: #fff; background: var(--brand); border-color: var(--brand); }
.pip.ok.cur { box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 30%, transparent); }
.pip .tick { font-size: 15px; }
/* Sandbox is a text pill, not a number pip: auto width, sits first with a small
   gap before the numbered lessons. */
.pip.sb { width: auto; padding: 0 13px; margin-right: 6px; border-style: dashed; font-size: 12.5px; letter-spacing: .01em; }

.card { border: 1px solid var(--edge); border-radius: 16px; overflow: hidden; background: var(--vp-c-bg); }
.chead { padding: 22px 22px 4px; }
.step { font-family: var(--vp-font-family-mono); font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--brand); }
.ct { font-size: 1.4rem; font-weight: 700; letter-spacing: -.015em; margin: 6px 0 4px; border: 0; padding: 0; }
.cd { color: var(--vp-c-text-2); margin: 0; max-width: 64ch; }
.cd :deep(code), .take :deep(code) { font-family: var(--vp-font-family-mono); font-size: .84em; background: color-mix(in srgb, var(--brand) 12%, transparent); color: var(--brand); padding: 1px 5px; border-radius: 4px; }
.cd kbd { font-family: var(--vp-font-family-mono); font-size: .8em; border: 1px solid var(--edge); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }

.examples { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
.ex-btn {
  font-family: var(--vp-font-family-mono); font-size: 12px; padding: 4px 10px;
  border: 1px solid var(--edge); border-radius: 6px; background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2); cursor: pointer; transition: all .15s;
}
.ex-btn:hover { border-color: var(--brand); color: var(--brand); }
.ex-btn.active { border-color: var(--brand); background: color-mix(in srgb, var(--brand) 14%, transparent); color: var(--brand); }

.panels { display: grid; grid-template-columns: 1.12fr .88fr; gap: 0; margin: 18px 22px 0; border: 1px solid var(--con-edge); border-radius: 12px; overflow: hidden; background: var(--con-bg); }
@media (max-width: 720px) { .panels { grid-template-columns: 1fr; } }
.pane { min-width: 0; display: flex; flex-direction: column; }
.pane:first-child { border-right: 1px solid var(--con-edge); }
@media (max-width: 720px) { .pane:first-child { border-right: 0; border-bottom: 1px solid var(--con-edge); } }
.ph { display: flex; align-items: center; gap: 7px; height: 40px; padding: 0 13px; background: var(--con-surf); border-bottom: 1px solid var(--con-edge); flex-shrink: 0; }
/* The filename yields space first (truncates); the action buttons never clip. */
.fname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph .btn, .ph .edited, .ph .native { flex-shrink: 0; white-space: nowrap; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.d1 { background: #f2606a; } .d2 { background: #f0b866; } .d3 { background: #7bd88f; }
.fname { font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--con-text); margin-left: 3px; }
.fname.dim { color: var(--c-com); margin-left: 0; }
.sp { flex: 1; }
.edited { font-family: var(--vp-font-family-mono); font-size: 11px; color: var(--brand); }
.native { font-family: var(--vp-font-family-mono); font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--c-com); border: 1px solid var(--con-edge); border-radius: 999px; padding: 3px 8px; }
.btn { font-family: var(--vp-font-family-mono); font-size: 12px; font-weight: 600; border: 0; border-radius: 6px; padding: 5px 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.btn.run { background: var(--brand); color: #fff; }
.btn.run:hover { filter: brightness(1.08); }
.btn.run:disabled { opacity: .55; cursor: default; }
.btn.ghost { background: transparent; color: var(--c-com); border: 1px solid var(--con-edge); }
.btn.ghost:hover { color: var(--con-text); }
.tri { font-size: 10px; }

.btn.next-cta {
  background: color-mix(in srgb, var(--brand) 16%, transparent);
  color: var(--brand); border: 1px solid var(--brand); font-weight: 700;
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--brand) 45%, transparent);
  animation: cta 1.8s ease-in-out infinite;
}
.btn.next-cta:hover { background: var(--brand); color: #fff; }
@media (prefers-reduced-motion: reduce) { .btn.next-cta { animation: none; } }
@keyframes cta {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--brand) 45%, transparent); }
  50% { box-shadow: 0 0 0 6px transparent; }
}
.pop-enter-active { transition: transform .28s cubic-bezier(.2,1.3,.5,1), opacity .28s ease; }
.pop-leave-active { transition: opacity .12s ease; }
.pop-enter-from { transform: scale(.6) translateX(-6px); opacity: 0; }
.pop-leave-to { opacity: 0; }

.editor { min-height: 240px; max-height: 460px; overflow: hidden; }
/* oneDark re-applies its cool #282c34 to .cm-editor; scoped :deep wins on
   specificity and repaints the code surface warm to match the panels. */
.editor :deep(.cm-editor) { background: var(--con-bg); }
.cm-host { height: 100%; min-height: 240px; }

.term { padding: 14px 16px; font-family: var(--vp-font-family-mono); font-size: 12.5px; line-height: 1.7; min-height: 240px; max-height: 460px; overflow: auto; color: var(--con-text); }
.idle { color: var(--c-com); }
.ttag { font-family: var(--vp-font-family-mono); font-size: 10px; letter-spacing: .09em; text-transform: uppercase; color: var(--c-com); margin-bottom: 9px; }
.oline { color: #7bd88f; white-space: pre-wrap; word-break: break-word; }
.oline.err { color: #f2828a; }
.arrow { color: var(--c-com); }

.take { display: flex; gap: 10px; align-items: flex-start; padding: 16px 22px 0; color: var(--vp-c-text-2); font-size: .93rem; }
.take .tk { font-family: var(--vp-font-family-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--brand); padding-top: 3px; white-space: nowrap; }

.foot { display: flex; align-items: center; gap: 14px; padding: 18px 22px 22px; }
.nav { font-family: var(--vp-font-family-base); font-size: 13.5px; font-weight: 600; border: 1px solid var(--edge); background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); border-radius: 8px; padding: 8px 16px; cursor: pointer; }
.nav:disabled { opacity: .45; cursor: default; }
.nav:not(:disabled):hover { border-color: var(--brand); }
.prog { color: var(--vp-c-text-2); font-size: 13px; }
.prog b { color: var(--vp-c-text-1); }
.foot-hint { margin-left: auto; color: var(--vp-c-text-3); font-size: 13px; }
.foot-hint a { color: var(--brand); font-weight: 600; cursor: pointer; }

.done { margin-top: 18px; text-align: center; padding: 16px; border: 1px solid var(--edge); border-radius: 12px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); }
.done a { color: var(--brand); font-weight: 600; cursor: pointer; }
</style>
