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
      { text: 'Language', link: '/language/' },
      { text: 'Standard Library', link: '/stdlib/' },
      { text: 'Playground', link: '/playground' },
      { text: 'Benchmarks', link: '/benchmarks' },
      { text: 'Roadmap', link: '/roadmap' },
      { text: 'AI Coding', link: '/ai-coding' },
    ],

    sidebar: {
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation', link: '/getting-started/installation' },
            { text: 'Quickstart', link: '/getting-started/quickstart' },
            { text: 'IDE Setup', link: '/getting-started/ide-setup' },
            { text: 'Debugging', link: '/getting-started/debugging' },
          ]
        },
        {
          text: 'Language',
          items: [
            { text: 'Language Overview', link: '/language/' },
            { text: 'Contracts & Safety', link: '/language/safety' },
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
            { text: 'Concurrency', link: '/language/concurrency' },
            { text: 'Warnings & Errors', link: '/language/warnings-and-errors' },
            { text: 'Modules', link: '/language/modules' },
            { text: 'C FFI', link: '/language/ffi' },
          ]
        },
        {
          text: 'Standard Library',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/stdlib/' },
            {
              text: 'I/O & Filesystem',
              collapsed: true,
              items: [
                { text: 'std/io', link: '/stdlib/io' },
                { text: 'std/fs', link: '/stdlib/fs' },
                { text: 'std/path', link: '/stdlib/path' },
                { text: 'std/env', link: '/stdlib/env' },
              ]
            },
            {
              text: 'Networking',
              collapsed: true,
              items: [
                { text: 'std/net', link: '/stdlib/net' },
                { text: 'std/http', link: '/stdlib/http' },
              ]
            },
            {
              text: 'Data',
              collapsed: true,
              items: [
                { text: 'std/json', link: '/stdlib/json' },
                { text: 'std/arena', link: '/stdlib/arena' },
                { text: 'std/set', link: '/stdlib/set' },
              ]
            },
            {
              text: 'CLI & System',
              collapsed: true,
              items: [
                { text: 'std/argparse', link: '/stdlib/argparse' },
                { text: 'std/args', link: '/stdlib/args' },
                { text: 'std/process', link: '/stdlib/process' },
                { text: 'std/signal', link: '/stdlib/signal' },
              ]
            },
            {
              text: 'Data Formats',
              collapsed: true,
              items: [
                { text: 'std/csv', link: '/stdlib/csv' },
                { text: 'std/toml', link: '/stdlib/toml' },
                { text: 'std/base64', link: '/stdlib/base64' },
                { text: 'std/hex', link: '/stdlib/hex' },
              ]
            },
            {
              text: 'Date, Time & IDs',
              collapsed: true,
              items: [
                { text: 'std/time', link: '/stdlib/time' },
                { text: 'std/datetime', link: '/stdlib/datetime' },
                { text: 'std/uuid', link: '/stdlib/uuid' },
              ]
            },
            {
              text: 'Concurrency',
              collapsed: true,
              items: [
                { text: 'std/thread', link: '/stdlib/thread' },
                { text: 'std/sync', link: '/stdlib/sync' },
                { text: 'std/runtime', link: '/stdlib/runtime' },
                { text: 'std/event', link: '/stdlib/event' },
              ]
            },
            {
              text: 'Database & Network',
              collapsed: true,
              items: [
                { text: 'std/sqlite', link: '/stdlib/sqlite' },
                { text: 'std/url', link: '/stdlib/url' },
              ]
            },
            {
              text: 'Strings & Formatting',
              collapsed: true,
              items: [
                { text: 'std/string', link: '/stdlib/string' },
                { text: 'std/fmt', link: '/stdlib/fmt' },
                { text: 'std/strconv', link: '/stdlib/strconv' },
                { text: 'std/unicode', link: '/stdlib/unicode' },
              ]
            },
            {
              text: 'Math & Random',
              collapsed: true,
              items: [
                { text: 'std/math', link: '/stdlib/math' },
                { text: 'std/random', link: '/stdlib/random' },
              ]
            },
            {
              text: 'Utilities',
              collapsed: true,
              items: [
                { text: 'std/color', link: '/stdlib/color' },
                { text: 'std/regex', link: '/stdlib/regex' },
                { text: 'std/sort', link: '/stdlib/sort' },
                { text: 'std/testing', link: '/stdlib/testing' },
                { text: 'std/log', link: '/stdlib/log' },
                { text: 'std/crypto', link: '/stdlib/crypto' },
                { text: 'std/mem', link: '/stdlib/mem' },
              ]
            },
          ]
        },
        {
          text: 'More',
          items: [
            { text: 'Examples', link: '/examples' },
            { text: 'Benchmarks', link: '/benchmarks' },
            { text: 'Quick Reference', link: '/reference' },
            { text: 'AI Coding', link: '/ai-coding' },
            { text: 'Roadmap', link: '/roadmap' },
          ]
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/cs01/milo' }
    ],
  }
})
