import DefaultTheme from 'vitepress/theme'
import MiloPlayground from './MiloPlayground.vue'
import BenchmarkChart from './BenchmarkChart.vue'
import TourStepper from './TourStepper.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('MiloPlayground', MiloPlayground)
    app.component('BenchmarkChart', BenchmarkChart)
    app.component('TourStepper', TourStepper)
  },
}
