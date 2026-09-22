import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import BenchmarkChart from './BenchmarkChart.vue'
import CodeCarousel from './CodeCarousel.vue'
import BlogIndex from './BlogIndex.vue'
import PostHeader from './PostHeader.vue'
import PostFooter from './PostFooter.vue'
import Subscribe from './Subscribe.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  // PostHeader and PostFooter render themselves only when the page's frontmatter has
  // a `date`, which in practice means blog posts and nothing else.
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'doc-before': () => h(PostHeader),
      'doc-after': () => h(PostFooter),
    })
  },
  enhanceApp({ app }) {
    app.component('BenchmarkChart', BenchmarkChart)
    app.component('CodeCarousel', CodeCarousel)
    app.component('BlogIndex', BlogIndex)
    app.component('Subscribe', Subscribe)

    // Copy-command chips on the "Built with Milo" tiles. The chips live inside <a>
    // tiles, so we intercept in the capture phase to copy WITHOUT following the link.
    if (!import.meta.env.SSR) {
      const copy = (el: HTMLElement, ev: Event) => {
        if (!el.classList.contains('tile-copy')) return
        ev.preventDefault()
        ev.stopPropagation()
        const cmd = el.dataset.cmd || ''
        navigator.clipboard?.writeText(cmd)
        const label = el.dataset.label || el.textContent || ''
        el.dataset.label = label
        el.textContent = 'copied ✓'
        el.classList.add('copied')
        window.setTimeout(() => {
          el.textContent = el.dataset.label || label
          el.classList.remove('copied')
        }, 1200)
      }
      window.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement)?.closest?.('.tile-copy') as HTMLElement
        if (el) copy(el, e)
      }, true)
      window.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        const el = (e.target as HTMLElement)?.closest?.('.tile-copy') as HTMLElement
        if (el) copy(el, e)
      }, true)
    }
  },
}
