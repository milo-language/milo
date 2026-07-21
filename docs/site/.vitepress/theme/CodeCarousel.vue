<template>
  <div class="cc">
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

    <p v-if="captions[current]" class="cc-caption">{{ captions[current] }}</p>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

defineProps({
  titles: { type: Array, required: true },
  subtitles: { type: Array, default: () => [] },
  captions: { type: Array, default: () => [] },
})

const current = ref(0)
const stage = ref(null)
let slides = []

function show(i) {
  slides.forEach((el, n) => el.classList.toggle('cc-active', n === i))
  current.value = i
  fit(i)
}

// The stage height follows the active slide, so a 4-line hello-world isn't
// displayed inside a 17-line-tall box.
function fit(i) {
  const el = slides[i]
  if (el && stage.value) stage.value.style.height = el.offsetHeight + 'px'
}

// Tabs only change on click — no auto-advance.
function select(i) { show(i) }

onMounted(() => {
  if (!stage.value) return
  slides = Array.from(stage.value.children)
  slides.forEach((el) => el.classList.add('cc-slide'))
  show(0)
  // Re-measure once layout settles (web fonts) and on viewport changes.
  requestAnimationFrame(() => fit(current.value))
  window.addEventListener('resize', onResize)
})

function onResize() { fit(current.value) }

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
})
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

/* Slides stack in the same grid cell; JS pins the stage height to the ACTIVE slide
   (see fit()) so short examples aren't framed by the tallest one. align-items: start
   keeps each slide at its natural height so offsetHeight measures honestly. Before
   JS runs there is no explicit height, so the no-JS fallback is tallest-slide. */
.cc-stage {
  display: grid;
  align-items: start;
  overflow: hidden;
  transition: height 0.3s ease;
}
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

/* small mobile: let the tab row wrap onto multiple lines instead of scrolling */
@media (max-width: 640px) {
  .cc-tabs { flex-wrap: wrap; overflow-x: visible; }
  .cc-tab { flex: 1 1 auto; min-width: 0; padding: 8px 12px; text-align: center; }
  .cc-tab-title { font-size: 13px; }
}

@media (prefers-reduced-motion: reduce) {
  .cc-stage { transition: none; }
  .cc-stage :deep(.cc-slide) { transition: none; }
}
</style>
