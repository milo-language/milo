<template>
  <div class="bench-chart">
    <div class="bench-legend">
      <span class="legend-item"><span class="legend-dot" style="background: #4a7fff"></span>Milo</span>
      <span class="legend-item"><span class="legend-dot" style="background: #8b949e"></span>C</span>
      <span class="legend-item"><span class="legend-dot" style="background: #36bcb8"></span>Go</span>
    </div>
    <div v-for="b in benchmarks" :key="b.name" class="bench-group">
      <div class="bench-label">{{ b.name }}</div>
      <div class="bench-bars">
        <div class="bench-row">
          <div class="bar bar-milo" :style="{ width: pct(b, b.milo) + '%' }">
            <span class="bar-value">{{ b.milo }}ms</span>
          </div>
        </div>
        <div class="bench-row">
          <div class="bar bar-c" :style="{ width: pct(b, b.c) + '%' }">
            <span class="bar-value">{{ b.c }}ms{{ b.cNote || '' }}</span>
          </div>
        </div>
        <div class="bench-row">
          <div class="bar bar-go" :style="{ width: pct(b, b.go) + '%' }">
            <span class="bar-value">{{ b.go }}ms</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const benchmarks = [
  { name: 'matmul 512×512', c: 12.8, milo: 12.0, go: 13.2 },
  { name: 'binarytrees depth 18', c: 3.9, milo: 3.0, go: 10.5 },
  { name: 'quicksort 2M f64', c: 35.7, milo: 34.7, go: 34.7 },
  { name: 'startup empty main', c: 1.2, milo: 1.2, go: 1.5 },
  { name: 'stringops 100k concat', c: 3.1, milo: 3.2, go: 6.5 },
  { name: 'fib(42)', c: 18.4, milo: 20.8, go: 21.6 },
  { name: 'sieve to 10M', c: 2.1, milo: 2.5, go: 3.4 },
  { name: 'maplookup 100k', c: 3.3, milo: 4.4, go: 5.0 },
  { name: 'grep -c 5MB', c: 2.1, milo: 5.5, go: 4.0 },
  { name: 'json parse+walk 1MB', c: 1.6, milo: 7.1, go: 9.7, cNote: '*' },
]

function pct(b, val) {
  const max = Math.max(b.c, b.milo, b.go)
  return Math.max((val / max) * 100, 2)
}
</script>

<style scoped>
.bench-chart {
  max-width: 720px;
  margin: 1.5rem auto;
}

.bench-legend {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
}

.bench-group {
  margin-bottom: 1.25rem;
}

.bench-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 4px;
  font-family: var(--vp-font-family-mono);
}

.bench-bars {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.bench-row {
  height: 22px;
  display: flex;
  align-items: center;
}

.bar {
  height: 100%;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 8px;
  min-width: fit-content;
  transition: width 0.4s ease;
}

.bar-milo { background: #4a7fff; }
.bar-c { background: #8b949e; }
.bar-go { background: #36bcb8; }

.bar-value {
  font-size: 0.72rem;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  font-family: var(--vp-font-family-mono);
}
</style>
