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

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/milo/logo.svg' }],
    ['link', { rel: 'preload', as: 'font', type: 'font/woff2', href: '/milo/fonts/DepartureMono-Regular.woff2', crossorigin: '' }],
  ],

  markdown: {
    languages: [miloGrammar],
  },

  themeConfig: {
    logo: '/logo.svg',

    search: {
      provider: 'local'
    },

    nav: [
      { text: 'Tour', link: '/tour' },
      { text: 'Docs', link: '/getting-started/installation' },
      { text: 'Language', link: '/language/' },
      { text: 'Playground', link: '/playground' },
      { text: 'Built with Milo', link: '/demos' },
      {
        text: 'More',
        items: [
          { text: 'Standard Library', link: '/stdlib/' },
          { text: 'Benchmarks', link: '/benchmarks' },
          { text: 'Roadmap', link: '/roadmap' },
        ]
      },
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
            { text: 'Memory Safety vs Rust', link: '/language/vs-rust' },
            { text: 'Collections', link: '/language/collections' },
            { text: 'Strings', link: '/language/strings' },
            { text: 'Traits', link: '/language/traits' },
            { text: 'Closures', link: '/language/closures' },
            { text: 'Concurrency', link: '/language/concurrency' },
            { text: 'Warnings & Errors', link: '/language/warnings-and-errors' },
            { text: 'Modules', link: '/language/modules' },
            { text: 'C FFI', link: '/language/ffi' },
            { text: 'JavaScript target', link: '/language/javascript-target' },
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
                { text: 'std/mem', link: '/stdlib/mem' },
              ]
            },
            {
              text: 'Cryptography',
              collapsed: true,
              items: [
                { text: 'std/crypto', link: '/stdlib/crypto' },
                { text: 'std/sha256', link: '/stdlib/sha256' },
                { text: 'std/sha1', link: '/stdlib/sha1' },
                { text: 'std/hmac', link: '/stdlib/hmac' },
                { text: 'std/jwt', link: '/stdlib/jwt' },
                { text: 'std/totp', link: '/stdlib/totp' },
                { text: 'std/base32', link: '/stdlib/base32' },
              ]
            },
            {
              text: 'Compression',
              collapsed: true,
              items: [
                { text: 'std/deflate', link: '/stdlib/deflate' },
                { text: 'std/inflate', link: '/stdlib/inflate' },
                { text: 'std/zip', link: '/stdlib/zip' },
              ]
            },
          ]
        },
        {
          text: 'More',
          items: [
            { text: 'Built with Milo', link: '/demos' },
            { text: 'Benchmarks', link: '/benchmarks' },
            { text: 'Quick Reference', link: '/reference' },
            { text: 'Roadmap', link: '/roadmap' },
          ]
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/milo-language/milo' }
    ],
  }
})
