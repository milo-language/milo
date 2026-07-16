import DefaultTheme from 'vitepress/theme'
import MiloLab from './MiloLab.vue'
import BenchmarkChart from './BenchmarkChart.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('MiloLab', MiloLab)
    app.component('BenchmarkChart', BenchmarkChart)
  },
}
