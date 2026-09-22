<!--
  MiloLab: the tour's lesson pager, one lesson at a time with its code over its
  captured output. Lessons live in tourLessons.ts (tests/tour.test.ts runs each one
  through the compiler); tour.data.ts highlights them at build time. Nothing runs in
  the browser until the compiler builds for wasm64.
-->
<template>
  <div class="lab" ref="rootEl">
    <nav class="picker" aria-label="Lessons">
      <button class="step" :disabled="cur === 0" aria-label="Previous lesson" @click="go(cur - 1)">←<span class="word"> Prev</span></button>
      <label class="pick">
        <span class="pick-text"><span class="count">Lesson {{ cur + 1 }} of {{ data.length }}:</span> {{ l.title }}</span>
        <svg class="caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
        <!-- A real select laid transparently over the label: native keyboard and
             mobile pickers, while the visible text stays one quiet line. -->
        <select :value="cur" aria-label="Jump to lesson" @change="go(Number($event.target.value))">
          <option v-for="(x, i) in data" :key="i" :value="i">{{ i + 1 }}. {{ x.title }}</option>
        </select>
      </label>
      <button class="step" :disabled="cur === data.length - 1" aria-label="Next lesson" @click="go(cur + 1)"><span class="word">Next </span>→</button>
    </nav>

    <article class="lesson">
      <h2 class="title">{{ l.title }}</h2>
      <p class="desc" v-html="l.descHtml"></p>
      <div class="run">
        <div class="bar">{{ l.file }}</div>
        <div class="code" v-html="l.codeHtml"></div>
        <div class="bar">$ {{ l.cmd }}</div>
        <pre class="out"><span v-for="(line, k) in l.out.split('\n')" :key="k" :class="{ err: ERR.test(line) }">{{ line }}
</span></pre>
      </div>
      <p class="take"><span class="take-label">Takeaway</span> <span v-html="l.takeHtml"></span></p>
    </article>

    <nav class="pager" aria-label="Lesson pager">
      <a v-if="cur > 0" class="card" href="#" @click.prevent="go(cur - 1, true)">
        <span class="card-dir">Previous</span><span class="card-title">{{ data[cur - 1].title }}</span>
      </a>
      <span v-else></span>
      <a v-if="cur < data.length - 1" class="card next" href="#" @click.prevent="go(cur + 1, true)">
        <span class="card-dir">Next</span><span class="card-title">{{ data[cur + 1].title }}</span>
      </a>
      <a v-else class="card next" :href="base + 'getting-started/installation'">
        <span class="card-dir">Next step</span><span class="card-title">Install Milo</span>
      </a>
    </nav>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { data } from './tour.data'

const base = import.meta.env.BASE_URL
const ERR = /^(runtime )?error\b/
const cur = ref(0)
const l = computed(() => data[cur.value])
const rootEl = ref(null)

// The lesson number rides in the URL hash (#3) so a lesson can be linked.
function go(i, fromBottom = false) {
  if (i < 0 || i >= data.length) return
  cur.value = i
  history.replaceState(history.state, '', '#' + (i + 1))
  if (fromBottom && rootEl.value) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    rootEl.value.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  }
}

onMounted(() => {
  const n = Number(location.hash.slice(1))
  if (Number.isInteger(n) && n >= 1 && n <= data.length) cur.value = n - 1
})
</script>

<style scoped>
.lab { margin-top: 24px; scroll-margin-top: calc(var(--vp-nav-height) + 16px); }

.picker {
  display: flex; align-items: stretch; gap: 4px;
  border: 1px solid var(--vp-c-divider); border-radius: 10px; background: var(--vp-c-bg-soft);
  padding: 4px;
}
.step {
  flex-shrink: 0; padding: 6px 12px; border-radius: 7px;
  font-size: 14px; font-weight: 500; color: var(--vp-c-text-2); cursor: pointer;
}
.step:not(:disabled):hover { color: var(--vp-c-brand-1); background: var(--vp-c-default-soft); }
.step:disabled { opacity: .35; cursor: default; }
.pick {
  position: relative; flex: 1; min-width: 0;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 6px 8px; border-radius: 7px; font-size: 15px; font-weight: 600; color: var(--vp-c-text-1);
}
.pick:hover, .pick:focus-within { background: var(--vp-c-default-soft); }
.pick:focus-within { outline: 2px solid var(--vp-c-brand-1); outline-offset: -2px; }
.pick-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { color: var(--vp-c-text-2); font-weight: 500; }
.caret { flex-shrink: 0; width: 12px; height: 12px; color: var(--vp-c-text-3); }
.pick select { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; font-size: 16px; }

.lesson { margin-top: 28px; }
.vp-doc .lesson .title { margin: 0 0 8px; padding: 0; border: 0; font-size: 24px; line-height: 1.3; }
.vp-doc .lesson .desc { margin: 0 0 20px; color: var(--vp-c-text-2); }

/* Filename bar, code, command bar and output read as one block. */
.run { border-radius: 8px; overflow: hidden; background: var(--vp-code-block-bg); }
.bar {
  padding: 8px 24px; font-family: var(--vp-font-family-mono); font-size: 12px;
  color: var(--vp-c-text-3); border-bottom: 1px solid var(--vp-c-divider);
}
.code + .bar { border-top: 1px solid var(--vp-c-divider); }
.vp-doc .run .code :deep(div[class*='language-']) { margin: 0; border-radius: 0; }
/* The filename bar already names the file, so the language badge is noise. */
.vp-doc .run .code :deep(span.lang) { display: none; }
/* Lessons keep lines short enough for the desktop column; on a phone, wrap instead
   of hiding the end of a line behind a sideways scroll nobody notices. */
.vp-doc .run .code :deep(pre) { overflow-x: hidden; }
.vp-doc .run .code :deep(pre code) { width: auto; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.vp-doc .run .out {
  margin: 0; padding: 16px 24px; overflow-x: auto; background: transparent;
  font-family: var(--vp-font-family-mono); font-size: var(--vp-code-font-size); line-height: var(--vp-code-line-height);
  color: var(--vp-c-text-1); white-space: pre-wrap; overflow-wrap: anywhere;
}
.out .err { color: var(--vp-c-danger-1); }

.vp-doc .lesson .take { margin: 20px 0 0; font-size: 14px; line-height: 1.6; color: var(--vp-c-text-2); }
.take-label {
  margin-right: 6px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
  color: var(--vp-c-text-3);
}

.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--vp-c-divider); }
.vp-doc .pager .card {
  display: flex; flex-direction: column; gap: 2px; padding: 11px 16px;
  border: 1px solid var(--vp-c-divider); border-radius: 8px; text-decoration: none; transition: border-color .2s;
}
.vp-doc .pager .card:hover { border-color: var(--vp-c-brand-1); }
.pager .next { text-align: right; }
.card-dir { font-size: 12px; font-weight: 500; color: var(--vp-c-text-2); }
.card-title { font-size: 14px; font-weight: 500; color: var(--vp-c-brand-1); }

@media (max-width: 639px) {
  .word { display: none; }
  .pick { font-size: 14px; }
  /* Full-bleed like every other code block on the site at this width. */
  .run { margin: 0 -24px; border-radius: 0; }
  /* One px smaller buys a few columns before a line has to wrap. */
  .vp-doc .run .code :deep(code), .vp-doc .run .out { font-size: 13px; }
}
</style>
