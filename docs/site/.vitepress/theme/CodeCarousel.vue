<template>
  <div
    class="cc"
    @mouseenter="pause"
    @mouseleave="resume"
    @focusin="pause"
    @focusout="resume"
  >
    <div class="cc-tabs" role="tablist">
      <button
        v-for="(t, i) in titles"
        :key="t"
        class="cc-tab"
        :class="{ active: i === current }"
        role="tab"
        :aria-selected="i === current"
        type="button"
        @click="select(i)"
      >
        <span class="cc-tab-title">{{ t }}</span>
        <span v-if="subtitles[i]" class="cc-tab-sub">{{ subtitles[i] }}</span>
      </button>
    </div>

    <!-- Slides are markdown fences from index.md, so Shiki highlights them at build
         time. The component only toggles which one is visible — it never renders code
         itself, which would mean shipping a highlighter to the browser. -->
    <div class="cc-stage" ref="stage">
      <slot />
    </div>

    <p class="cc-caption">{{ captions[current] }}</p>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  titles: { type: Array, required: true },
  subtitles: { type: Array, default: () => [] },
  captions: { type: Array, default: () => [] },
  interval: { type: Number, default: 7000 },
})

const current = ref(0)
const stage = ref(null)
let slides = []
let timer = null
let paused = false
// Someone who clicks a tab has chosen — don't yank it away from them.
let userPicked = false

function show(i) {
  slides.forEach((el, n) => el.classList.toggle('cc-active', n === i))
  current.value = i
}

function select(i) {
  userPicked = true
  show(i)
}

function advance() {
  if (paused || userPicked || slides.length === 0) return
  show((current.value + 1) % slides.length)
}

function pause() { paused = true }
function resume() { paused = false }

onMounted(() => {
  if (!stage.value) return
  slides = Array.from(stage.value.children)
  slides.forEach((el) => el.classList.add('cc-slide'))
  show(0)
  // Auto-advance is decoration. Honour the OS setting rather than animating at someone
  // who has asked things to hold still.
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (!still && slides.length > 1) timer = setInterval(advance, props.interval)
})

onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.cc {
  margin: 24px 0 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}

.cc-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  overflow-x: auto;
}

.cc-tab {
  flex: 1 1 0;
  min-width: 140px;
  padding: 10px 16px;
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s;
}
.cc-tab:hover { background: var(--vp-c-bg-soft); }
.cc-tab.active {
  border-bottom-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
}

.cc-tab-title {
  display: block;
  font-weight: 600;
  font-size: 14px;
  color: var(--vp-c-text-1);
}
.cc-tab.active .cc-tab-title { color: var(--vp-c-brand-1); }

.cc-tab-sub {
  display: block;
  font-size: 12px;
  color: var(--vp-c-text-2);
  margin-top: 2px;
}

/* The stage is as tall as its tallest slide: slides stack in the same grid cell, so
   switching never reflows the page under the reader's cursor. */
.cc-stage { display: grid; }
/* :deep() is REQUIRED here, not stylistic. Slides come from a <slot>, so index.md renders
   them and they carry no scope attribute of ours. Plain `.cc-stage > *` compiles to
   `.cc-stage[data-v-x] > *` (attribute on the stage — matches), but `.cc-stage > .cc-active`
   compiles to `.cc-stage > .cc-active[data-v-x]` (attribute on the slide — never matches).
   The hide rule applied, the show rule silently didn't, and every slide stayed invisible. */
.cc-stage :deep(.cc-slide) {
  grid-area: 1 / 1;
  opacity: 0;
  visibility: hidden;
  transform: translateY(4px);
  transition: opacity 0.35s ease, transform 0.35s ease, visibility 0.35s;
  min-width: 0;
}
.cc-stage :deep(.cc-slide.cc-active) {
  opacity: 1;
  visibility: visible;
  transform: none;
}

/* VitePress gives code blocks their own margin/radius; inside the frame that reads as
   a box in a box. */
.cc-stage :deep(div[class*='language-']) {
  margin: 0;
  border-radius: 0;
}

.cc-caption {
  margin: 0;
  padding: 12px 16px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
  border-top: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}

@media (prefers-reduced-motion: reduce) {
  .cc-stage :deep(.cc-slide) { transition: none; }
}
</style>
