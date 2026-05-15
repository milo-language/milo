import { defineConfig } from 'vitepress'
import fs from 'node:fs'
import path from 'node:path'

const miloGrammar = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'milo.tmLanguage.json'), 'utf-8')
)

export default defineConfig({
  title: 'Milo',
  description: 'Memory-safe systems language — ownership without lifetimes',

  base: '/milo/',
  appearance: 'dark',

  markdown: {
    languages: [miloGrammar],
  },

  themeConfig: {
    search: {
      provider: 'local'
    },

    nav: [
      { text: 'Docs', link: '/getting-started/installation' },
      { text: 'Language', link: '/language/variables' },
      { text: 'Standard Library', link: '/stdlib/' },
      { text: 'Benchmarks', link: '/benchmarks' },
    ],

    sidebar: {
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Quickstart', link: '/getting-started/quickstart' },
            { text: 'IDE Setup', link: '/getting-started/ide-setup' },
          ]
        },
        {
          text: 'Language',
          items: [
            { text: 'Variables & Types', link: '/language/variables' },
            { text: 'Functions', link: '/language/functions' },
            { text: 'Structs', link: '/language/structs' },
            { text: 'Enums & Matching', link: '/language/enums' },
            { text: 'Error Handling', link: '/language/error-handling' },
            { text: 'Ownership', link: '/language/ownership' },
            { text: 'Collections', link: '/language/collections' },
            { text: 'Strings', link: '/language/strings' },
            { text: 'Traits', link: '/language/traits' },
            { text: 'Closures', link: '/language/closures' },
            { text: 'Modules', link: '/language/modules' },
            { text: 'C FFI', link: '/language/ffi' },
          ]
        },
        {
          text: 'Standard Library',
          link: '/stdlib/',
        },
        {
          text: 'More',
          items: [
            { text: 'Examples', link: '/examples' },
            { text: 'Benchmarks', link: '/benchmarks' },
            { text: 'Quick Reference', link: '/reference' },
          ]
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/cs01/milo' }
    ],
  }
})
