import { defineConfig, createContentLoader, type SiteConfig } from 'vitepress'
import { Feed } from 'feed'
import fs from 'node:fs'
import path from 'node:path'
import { toDate } from './postdate'
import { miloGrammar } from './miloGrammar'

const SITE = 'https://milo-language.github.io/milo'

// RSS is the feed most of this audience actually reads, and it has to be generated
// at buildEnd because that's the only hook where the rendered post HTML exists.
async function generateFeed(config: SiteConfig) {
  const feed = new Feed({
    title: 'Milo',
    description: 'Notes from building Milo — a memory-safe systems language.',
    id: SITE,
    link: SITE,
    language: 'en',
    image: `${SITE}/logo.svg`,
    favicon: `${SITE}/logo.svg`,
    copyright: `Copyright © ${new Date().getFullYear()} the Milo authors`,
    feedLinks: { rss: `${SITE}/feed.rss`, atom: `${SITE}/feed.atom` },
  })

  const posts = (await createContentLoader('blog/posts/*.md', { render: true }).load())
    .map((p) => ({ ...p, published: toDate(p.frontmatter.date) }))
    .filter((p) => p.published !== null)
    .sort((a, b) => +b.published! - +a.published!)

  // Always emitted, even with zero posts: the <head> alternate link and the
  // subscribe box both point at /feed.rss, and a 404 there is worse than an empty
  // channel. Feed.atom1() throws without `updated`, so it always gets a date.
  feed.options.updated = posts[0]?.published ?? new Date()

  for (const post of posts) {
    feed.addItem({
      title: post.frontmatter.title,
      id: `${SITE}${post.url}`,
      link: `${SITE}${post.url}`,
      description: post.frontmatter.description,
      content: post.html,
      author: [{ name: post.frontmatter.author ?? 'The Milo team' }],
      date: post.published!,
    })
  }

  fs.writeFileSync(path.join(config.outDir, 'feed.rss'), feed.rss2())
  fs.writeFileSync(path.join(config.outDir, 'feed.atom'), feed.atom1())
}


// Two sidebars: the stdlib's (~60 module pages, which buried everything else when it
// shared a tree) and one docs tree for every other page, grouped by what the reader
// came for: start, learn in order, look up a task, weigh the design, or look up a fact.
// File paths predate the grouping and are kept for link stability; the sidebar, not the
// directory, is the structure.
const docsSidebar = [
  {
    text: 'Get started',
    items: [
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Your first program', link: '/getting-started/quickstart' },
      { text: 'Tour (13 lessons)', link: '/tour' },
      { text: 'Editor setup', link: '/getting-started/ide-setup' },
    ]
  },
  {
    text: 'Learn Milo',
    items: [
      { text: 'Variables & control flow', link: '/language/variables' },
      { text: 'Functions', link: '/language/functions' },
      { text: 'Ownership & borrowing', link: '/language/ownership' },
      { text: 'Structs', link: '/language/structs' },
      { text: 'Enums & matching', link: '/language/enums' },
      { text: 'Collections', link: '/language/collections' },
      { text: 'Strings', link: '/language/strings' },
      { text: 'Error handling', link: '/language/error-handling' },
      { text: 'Traits', link: '/language/traits' },
      { text: 'Closures', link: '/language/closures' },
      { text: 'Modules', link: '/language/modules' },
      { text: 'Packages', link: '/packages' },
    ]
  },
  {
    text: 'How-to',
    items: [
      { text: 'Patterns without lifetimes', link: '/language/patterns' },
      { text: 'Concurrency', link: '/features/concurrency' },
      { text: 'Call C (FFI)', link: '/features/ffi' },
      { text: 'Contracts & proofs', link: '/language/safety' },
      { text: 'Safety profiles', link: '/language/safety-profiles' },
      { text: 'Debugging', link: '/getting-started/debugging' },
      { text: 'Coding with AI agents', link: '/ai-coding' },
    ]
  },
  {
    text: 'Why Milo',
    collapsed: true,
    items: [
      { text: 'Why there are no lifetimes', link: '/language/why-no-lifetimes' },
      { text: 'Memory safety vs Rust', link: '/language/vs-rust' },
      { text: 'Benchmarks', link: '/benchmarks' },
      { text: 'Built with Milo', link: '/demos' },
      { text: 'Roadmap', link: '/roadmap' },
    ]
  },
  {
    text: 'Reference',
    collapsed: true,
    items: [
      { text: 'Syntax quick reference', link: '/reference' },
      { text: 'Command-line reference', link: '/cli' },
      { text: 'Keywords', link: '/language/keywords' },
      { text: 'Annotations & builtins', link: '/features/annotations' },
      { text: 'Concurrency API', link: '/features/concurrency-api' },
      { text: 'Warnings & errors', link: '/language/warnings-and-errors' },
      { text: 'Compile errors', link: '/language/errors' },
      { text: 'Standard library', link: '/stdlib/' },
    ]
  },
]

const stdlibSidebar = [
  {
    text: 'Standard Library',
    items: [
      { text: 'Overview', link: '/stdlib/' },
      { text: 'std/prelude', link: '/stdlib/prelude' },
    ]
  },
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
      { text: 'std/html', link: '/stdlib/html' },
      { text: 'std/mime', link: '/stdlib/mime' },
      { text: 'std/multipart', link: '/stdlib/multipart' },
      { text: 'std/url', link: '/stdlib/url' },
      { text: 'std/fetch', link: '/stdlib/fetch' },
      { text: 'std/tls', link: '/stdlib/tls' },
      { text: 'std/https', link: '/stdlib/https' },
      { text: 'std/ws', link: '/stdlib/ws' },
      { text: 'std/httpmw', link: '/stdlib/httpmw' },
      { text: 'std/unix', link: '/stdlib/unix' },
    ]
  },
  {
    text: 'Data',
    collapsed: true,
    items: [
      { text: 'std/json', link: '/stdlib/json' },
      { text: 'std/arena', link: '/stdlib/arena' },
      { text: 'std/set', link: '/stdlib/set' },
      { text: 'std/sqlite', link: '/stdlib/sqlite' },
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
      { text: 'std/term', link: '/stdlib/term' },
      { text: 'std/keys', link: '/stdlib/keys' },
      { text: 'std/ansi', link: '/stdlib/ansi' },
      { text: 'std/pty', link: '/stdlib/pty' },
      { text: 'std/sysinfo', link: '/stdlib/sysinfo' },
      { text: 'std/environ', link: '/stdlib/environ' },
      { text: 'std/os', link: '/stdlib/os' },
      { text: 'std/dl', link: '/stdlib/dl' },
    ]
  },
  {
    text: 'Data Formats',
    collapsed: true,
    items: [
      { text: 'std/csv', link: '/stdlib/csv' },
      { text: 'std/base64', link: '/stdlib/base64' },
      { text: 'std/hex', link: '/stdlib/hex' },
      { text: 'std/binary', link: '/stdlib/binary' },
      { text: 'std/png', link: '/stdlib/png' },
    ]
  },
  {
    text: 'Date, Time & IDs',
    collapsed: true,
    items: [
      { text: 'std/time', link: '/stdlib/time' },
      { text: 'std/timer', link: '/stdlib/timer' },
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
      { text: 'std/seal', link: '/stdlib/seal' },
      { text: 'std/shard', link: '/stdlib/shard' },
      { text: 'std/select', link: '/stdlib/select' },
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
      { text: 'std/rng', link: '/stdlib/rng' },
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
      { text: 'std/foreign', link: '/stdlib/foreign' },
      { text: 'std/cstr', link: '/stdlib/cstr' },
      { text: 'std/pool', link: '/stdlib/pool' },
      { text: 'std/smt', link: '/stdlib/smt' },
    ]
  },
  {
    text: 'Cryptography',
    collapsed: true,
    items: [
      { text: 'std/crypto', link: '/stdlib/crypto' },
      { text: 'std/sha256', link: '/stdlib/sha256' },
      { text: 'std/sha512', link: '/stdlib/sha512' },
      { text: 'std/sha1', link: '/stdlib/sha1' },
      { text: 'std/hmac', link: '/stdlib/hmac' },
      { text: 'std/subtle', link: '/stdlib/subtle' },
      { text: 'std/hkdf', link: '/stdlib/hkdf' },
      { text: 'std/pbkdf2', link: '/stdlib/pbkdf2' },
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
      { text: 'std/zstd', link: '/stdlib/zstd' },
      { text: 'std/checksum', link: '/stdlib/checksum' },
      { text: 'std/xxhash', link: '/stdlib/xxhash' },
    ]
  },
]

export default defineConfig({
  title: 'Milo',
  description: 'A memory-safe systems language with second-class references: no lifetimes, no GC, one owner per value',

  base: '/milo/',
  appearance: 'dark',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/milo/logo.svg' }],
    ['link', { rel: 'preload', as: 'font', type: 'font/woff2', href: '/milo/fonts/DepartureMono-Regular.woff2', crossorigin: '' }],
    ['link', { rel: 'alternate', type: 'application/rss+xml', title: 'Milo', href: '/milo/feed.rss' }],
  ],

  markdown: {
    languages: [miloGrammar],
    config(md) {
      // A `milo error` snippet is followed by the compiler's output, which names a
      // line: number its gutter so the two can be matched without counting. Done here
      // rather than as `:line-numbers` in the fence, because tests/docs.test.ts reads
      // the fence's info string for its check/error/skip mode.
      md.core.ruler.push('milo-error-line-numbers', (state) => {
        // The landing carousel shows no compiler output, and a gutter pushed its code off the edge.
        if (state.env?.relativePath === 'index.md') return
        for (const t of state.tokens) {
          if (t.type === 'fence' && /^milo\s+error\b/.test(t.info)) t.info = 'milo:line-numbers'
        }
      })
    },
  },

  themeConfig: {
    logo: '/logo.svg',

    search: {
      provider: 'local'
    },

    nav: [
      { text: 'Get started', link: '/getting-started/installation', activeMatch: '^/(getting-started|tour)' },
      { text: 'Learn', link: '/language/variables', activeMatch: '^/(language/(variables|functions|ownership|structs|enums|collections|strings|error-handling|traits|closures|modules)|packages)' },
      { text: 'How-to', link: '/language/patterns', activeMatch: '^/(language/(patterns|safety|safety-profiles)|features/(concurrency(?!-)|ffi)|ai-coding)' },
      { text: 'Why Milo', link: '/language/why-no-lifetimes', activeMatch: '^/(language/(why-no-lifetimes|vs-rust)|benchmarks|demos|roadmap)' },
      { text: 'Reference', link: '/reference', activeMatch: '^/(reference|cli|language/(keywords|warnings-and-errors|errors)|features/(annotations|concurrency-api))' },
      { text: 'Stdlib', link: '/stdlib/', activeMatch: '^/stdlib/' },
    ],

    sidebar: {
      // Blog pages get no sidebar: the docs tree is irrelevant while reading a post.
      '/blog/': [],
      '/stdlib/': stdlibSidebar,
      '/': docsSidebar,
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/milo-language/milo' }
    ],
  },

  buildEnd: generateFeed,
})
