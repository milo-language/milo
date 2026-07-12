<template>
  <div class="tour" id="tour" ref="rootEl">
    <div class="tour-head">
      <div class="tour-kicker">Interactive tour · {{ concepts.length }} steps</div>
      <h2 class="tour-title">Learn Milo by running it</h2>
      <p class="tour-sub">Edit each program, run it in your browser, and move to the next. Real compiler, real output.</p>
    </div>

    <!-- progress rail -->
    <div class="rail" role="tablist" aria-label="Tour steps">
      <button
        v-for="(c, i) in concepts" :key="i"
        class="pip" :class="{ cur: i === cur, ok: ran[i], reachable: i <= maxReached }"
        :aria-selected="i === cur"
        :title="(i + 1) + '. ' + c.title"
        @click="go(i)">
        <span v-if="ran[i]" class="tick">✓</span><span v-else>{{ i + 1 }}</span>
      </button>
    </div>

    <div class="card" :key="cur">
      <div class="chead">
        <span class="step">Step {{ cur + 1 }} of {{ concepts.length }}</span>
        <h3 class="ct" v-html="cur + 1 + '. ' + concepts[cur].title"></h3>
        <p class="cd" v-html="concepts[cur].desc"></p>
      </div>

      <div class="panels">
        <div class="pane">
          <div class="ph">
            <span class="dot d1"></span><span class="dot d2"></span><span class="dot d3"></span>
            <span class="fname">{{ concepts[cur].file }}</span>
            <span class="sp"></span>
            <span v-if="edited" class="edited">edited</span>
            <button v-if="edited" class="btn ghost" @click="reset">reset</button>
            <button class="btn run" :disabled="running" @click="run">
              <span class="tri">{{ running ? '▶' : (ran[cur] ? '↻' : '▶') }}</span>
              {{ running ? 'Running' : (ran[cur] ? 'Run again' : 'Run') }}
            </button>
          </div>
          <div class="editor" ref="edEl">
            <pre aria-hidden="true"><code v-html="highlighted"></code></pre>
            <textarea
              ref="taEl" v-model="src" @input="onInput" @keydown.tab.prevent="onTab"
              spellcheck="false" autocapitalize="off" autocomplete="off"
              :aria-label="concepts[cur].title + ' source'"></textarea>
          </div>
        </div>

        <div class="pane">
          <div class="ph">
            <span class="fname dim">output</span>
            <span class="sp"></span>
            <span v-if="concepts[cur].native" class="native">native runtime</span>
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

      <div class="take">
        <span class="tk">{{ concepts[cur].err ? 'safety' : (concepts[cur].native ? 'note' : 'takeaway') }}</span>
        <span v-html="concepts[cur].take"></span>
      </div>

      <div class="foot">
        <button class="nav" :disabled="cur === 0" @click="go(cur - 1)">← Back</button>
        <span class="prog"><b>{{ ranCount }}</b> / {{ concepts.length }} run</span>
        <button v-if="cur < concepts.length - 1" class="nav next" :class="{ ready: ran[cur] }" :disabled="!ran[cur]" @click="next">
          {{ ran[cur] ? 'Next →' : 'Run to continue' }}
        </button>
        <button v-else class="nav next" :class="{ ready: ran[cur] }" :disabled="!ran[cur]" @click="finish">Finish ✓</button>
      </div>
    </div>

    <div v-if="allDone" class="done">
      🎉 You ran every step. Next: <a :href="base + 'getting-started/installation'">install Milo</a>,
      open the full <a :href="base + 'playground'">playground</a>, or read the <a :href="base + 'language/'">language guide</a>.
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'

const base = import.meta.env.BASE_URL

// ---- content: verified programs + captured native output (fallback) ----
const concepts = [
  { title: 'Values that can’t surprise you', file: 'values.milo',
    desc: 'A <code>let</code> binding is immutable; a <code>var</code> is mutable. You opt <em>in</em> to change.',
    take: 'Immutable by default — you always know what can change out from under you.',
    out: ['hello from Milo, count = 3'],
    code: `fn main(): i32 {
    let name = "Milo"        // immutable
    var count = 0            // mutable
    count = count + 3
    print("hello from ", name, ", count = ", count)
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
    print("distance = ", dist(origin, p))
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
    print("circle: ", area(Shape.Circle(2.0)))
    print("rect:   ", area(Shape.Rect(3.0, 4.0)))
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
        Result.Ok(v)  => { print("next year: ", v) }
        Result.Err(e) => { print("error: ", e) }
    }
    match nextYear("") {
        Result.Ok(v)  => { print("next year: ", v) }
        Result.Err(e) => { print("error: ", e) }
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
    print(p.first, " ", p.second)
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
        Option.Some(s) => { print("alice scored ", s) }
        Option.None    => { print("no score") }
    }
    print("players: ", scores.len)
    return 0
}` },
  { title: 'Ownership — the compiler says no', file: 'ownership.milo', err: true,
    desc: 'Each value has one owner. Assigning <code>a</code> to <code>b</code> <em>moves</em> it; using <code>a</code> after is a compile error. Run it — the checker rejects it.',
    take: 'No garbage collector, no dangling pointers: the move checker rejects the program before it runs.',
    out: ['error: use of moved variable \'a\'', '  --> ownership.milo:4:11', '', '  this value was moved on line 3 and can’t be used again'],
    code: `fn main(): i32 {
    let a = "owned string"
    let b = a            // ownership moves: a -> b
    print(a)             // a is gone — try deleting this line
    return 0
}` },
  { title: 'Concurrency with backpressure', file: 'backpressure.milo', native: true,
    desc: 'A green task hands data over a <em>bounded</em> <code>Channel</code>. Capacity 2 means <code>send</code> blocks when full, so a fast producer can’t outrun a slow consumer.',
    take: 'After <code>sent 2</code> the buffer is full, so the producer pauses until a <code>recv</code> frees a slot — free backpressure. (Green threads need the native runtime, so this replays the real output.)',
    out: ['sent 1', 'sent 2', '      recv 1', 'sent 3', '      recv 2', 'sent 4', '      recv 3', 'sent 5', '      recv 4', '      recv 5'],
    code: `from "std/runtime" import { Promise }
from "std/sync" import { Channel }
from "std/time" import { sleepMs }

fn main(): i32 {
    let ch = Channel<i64>.new(2)!            // capacity 2

    let producer = Promise<i64>.blocking(move(): i64 => {
        var i: i64 = 1
        while i <= 5 {
            ch.send(i)!                      // blocks once 2 are buffered
            print("sent ", i)
            i = i + 1
        }
        return 0
    })

    var got: i64 = 0
    while got < 5 {
        sleepMs(20)                          // slow consumer
        let v = ch.recv()!
        print("      recv ", v)
        got = got + 1
    }
    producer.await()!
    ch.destroy()
    return 0
}` },
]

// ---- syntax highlighter ----
const KW = new Set(['fn','let','var','struct','enum','impl','interface','match','return','if','else','while','for','in','from','import','move','true','false','break','continue','self','Self','as','unsafe'])
const TY = new Set(['i8','i16','i32','i64','u8','u16','u32','u64','f32','f64','bool','string','void','Vec','HashMap','Option','Result','Channel','Task','Promise'])
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function highlight(src) {
  let out = ''
  const re = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(\b\d+\.?\d*\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_])/g
  let m
  while ((m = re.exec(src)) !== null) {
    if (m[1]) out += '<span class="c-com">' + esc(m[1]) + '</span>'
    else if (m[2] || m[3]) out += '<span class="c-str">' + esc(m[2] || m[3]) + '</span>'
    else if (m[4]) out += '<span class="c-num">' + esc(m[4]) + '</span>'
    else if (m[5]) {
      const w = m[5], after = src[re.lastIndex]
      if (KW.has(w)) out += '<span class="c-kw">' + w + '</span>'
      else if (TY.has(w)) out += '<span class="c-ty">' + w + '</span>'
      else if (after === '(') out += '<span class="c-fn">' + w + '</span>'
      else if (/^[A-Z]/.test(w)) out += '<span class="c-ty">' + w + '</span>'
      else out += w
    }
    else if (m[6]) out += m[6]
    else out += '<span class="c-pu">' + esc(m[7]) + '</span>'
  }
  return out
}

// ---- state ----
const cur = ref(0)
const maxReached = ref(0)
const srcs = ref(concepts.map(c => c.code))
const ran = ref(concepts.map(() => false))
const running = ref(false)
const outLines = ref([])
const outErr = ref(false)
const outTag = ref('')
const compilerReady = ref(false)
let playground = null

const rootEl = ref(null)
const taEl = ref(null)
const edEl = ref(null)

const src = computed({
  get: () => srcs.value[cur.value],
  set: v => { srcs.value[cur.value] = v },
})
const highlighted = computed(() => highlight(srcs.value[cur.value]))
const edited = computed(() => srcs.value[cur.value] !== concepts[cur.value].code)
const ranCount = computed(() => ran.value.filter(Boolean).length)
const allDone = computed(() => ran.value.every(Boolean))

function sizeTextarea() {
  const ta = taEl.value
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 'px'
}
function onInput() { nextTick(sizeTextarea) }
function onTab(e) {
  const ta = taEl.value
  const s = ta.selectionStart, en = ta.selectionEnd
  src.value = src.value.slice(0, s) + '    ' + src.value.slice(en)
  nextTick(() => { ta.selectionStart = ta.selectionEnd = s + 4; sizeTextarea() })
}
function reset() { src.value = concepts[cur.value].code; nextTick(sizeTextarea) }

function showOutput(lines, isErr, tag) {
  outErr.value = isErr
  outTag.value = tag
  outLines.value = []
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  let k = 0
  const step = () => {
    if (k >= lines.length) return
    outLines.value = [...outLines.value, lines[k]]
    k++
    if (k < lines.length && !reduce) setTimeout(step, 200)
    else if (!reduce) {}
  }
  if (reduce) outLines.value = lines.slice()
  else step()
}

function run() {
  const c = concepts[cur.value]
  running.value = true
  const finishRun = () => { running.value = false; ran.value[cur.value] = true }

  if (compilerReady.value && playground && !c.native) {
    let r
    try { r = playground.compileAndRun(src.value) }
    catch (ex) { r = { ok: false, error: String((ex && ex.message) || ex) } }
    if (r.ok) {
      const o = (r.output == null) ? '' : r.output
      const lines = o === '' ? ['(no output)'] : o.replace(/\n$/, '').split('\n')
      showOutput(lines, false, c.file + ' · compiled to JS · exit 0')
    } else {
      const errLines = String(r.error || 'error').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '').split('\n')
      showOutput(errLines, true, c.file + ' · rejected by the checker')
    }
    finishRun()
    return
  }
  // native-only, or compiler not yet loaded: replay captured output
  showOutput(c.out, !!c.err, c.file + (c.native ? ' · native binary · exit 0' : (c.err ? ' · compile' : ' · exit 0')))
  finishRun()
}

function go(i) {
  if (i < 0 || i >= concepts.length) return
  cur.value = i
  maxReached.value = Math.max(maxReached.value, i)
  outLines.value = []
  nextTick(sizeTextarea)
}
function next() { go(cur.value + 1); scrollToTop() }
function finish() { ran.value[cur.value] = true; scrollToTop() }
function scrollToTop() {
  nextTick(() => { if (rootEl.value) rootEl.value.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) })
}

watch(cur, () => nextTick(sizeTextarea))

onMounted(() => {
  nextTick(sizeTextarea)
  if (typeof window === 'undefined') return
  if (window.MiloPlayground) { playground = window.MiloPlayground; compilerReady.value = true; return }
  const s = document.createElement('script')
  s.type = 'module'
  s.textContent = `import "${base}playground/compiler.js"; window.__miloReady = true; window.dispatchEvent(new Event('milo-ready'));`
  s.onerror = () => {}
  document.head.appendChild(s)
  const ready = () => { playground = window.MiloPlayground; compilerReady.value = !!playground }
  if (window.__miloReady) ready()
  else window.addEventListener('milo-ready', ready, { once: true })
})
</script>

<style scoped>
.tour {
  --edge: var(--vp-c-divider);
  --brand: var(--vp-c-brand-1);
  --con-bg: #0d1320; --con-surf: #121a29; --con-edge: #24314a; --con-text: #cdd6e6;
  --c-kw: #6cb6ff; --c-ty: #56d4c6; --c-str: #86d992; --c-num: #f2b866; --c-fn: #d8b4fe; --c-com: #6a7b96; --c-pu: #8593ab;
  margin: 40px 0 8px; font-family: var(--vp-font-family-base);
}
.tour-head { text-align: center; margin-bottom: 22px; }
.tour-kicker { font-family: var(--vp-font-family-mono); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--brand); }
.tour-title { font-size: 1.9rem; font-weight: 750; letter-spacing: -.02em; margin: 8px 0 6px; border: 0; padding: 0; }
.tour-sub { color: var(--vp-c-text-2); margin: 0; }

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

.card { border: 1px solid var(--edge); border-radius: 16px; overflow: hidden; background: var(--vp-c-bg); }
.chead { padding: 22px 22px 4px; }
.step { font-family: var(--vp-font-family-mono); font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--brand); }
.ct { font-size: 1.4rem; font-weight: 700; letter-spacing: -.015em; margin: 6px 0 4px; border: 0; padding: 0; }
.cd { color: var(--vp-c-text-2); margin: 0; max-width: 64ch; }
.cd :deep(code), .take :deep(code) { font-family: var(--vp-font-family-mono); font-size: .84em; background: color-mix(in srgb, var(--brand) 12%, transparent); color: var(--brand); padding: 1px 5px; border-radius: 4px; }

.panels { display: grid; grid-template-columns: 1.12fr .88fr; gap: 0; margin: 18px 22px 0; border: 1px solid var(--con-edge); border-radius: 12px; overflow: hidden; background: var(--con-bg); }
@media (max-width: 720px) { .panels { grid-template-columns: 1fr; } }
.pane { min-width: 0; }
.pane:first-child { border-right: 1px solid var(--con-edge); }
@media (max-width: 720px) { .pane:first-child { border-right: 0; border-bottom: 1px solid var(--con-edge); } }
.ph { display: flex; align-items: center; gap: 7px; height: 40px; padding: 0 13px; background: var(--con-surf); border-bottom: 1px solid var(--con-edge); }
.dot { width: 10px; height: 10px; border-radius: 50%; }
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

.editor { position: relative; }
.editor pre, .editor textarea {
  margin: 0; padding: 16px; border: 0; font-family: var(--vp-font-family-mono);
  font-size: 12.75px; line-height: 1.6; tab-size: 4; white-space: pre; letter-spacing: 0;
}
.editor pre { position: absolute; inset: 0; overflow: hidden; pointer-events: none; color: var(--con-text); }
.editor pre code { font-family: inherit; background: none; padding: 0; }
.editor textarea {
  position: relative; display: block; width: 100%; min-height: 120px; background: transparent;
  color: transparent; caret-color: var(--brand); resize: none; overflow: auto; outline: none;
  -webkit-text-fill-color: transparent;
}
.editor textarea::selection { background: color-mix(in srgb, var(--brand) 30%, transparent); -webkit-text-fill-color: transparent; }
.c-kw { color: var(--c-kw); } .c-ty { color: var(--c-ty); } .c-str { color: var(--c-str); }
.c-num { color: var(--c-num); } .c-fn { color: var(--c-fn); } .c-com { color: var(--c-com); font-style: italic; } .c-pu { color: var(--c-pu); }

.term { padding: 14px 16px; font-family: var(--vp-font-family-mono); font-size: 12.5px; line-height: 1.7; min-height: 120px; color: var(--con-text); }
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
.nav.next { margin-left: auto; }
.nav.next.ready { background: var(--brand); color: #fff; border-color: var(--brand); animation: pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .nav.next.ready { animation: none; } }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--brand) 40%, transparent); } 50% { box-shadow: 0 0 0 6px transparent; } }
.prog { color: var(--vp-c-text-2); font-size: 13px; }
.prog b { color: var(--vp-c-text-1); }

.done { margin-top: 18px; text-align: center; padding: 16px; border: 1px solid var(--edge); border-radius: 12px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); }
.done a { color: var(--brand); font-weight: 600; }
</style>
