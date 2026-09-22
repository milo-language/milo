import { defineConfig, createContentLoader, type SiteConfig } from 'vitepress'
import { Feed } from 'feed'
import fs from 'node:fs'
import path from 'node:path'
import { toDate } from './postdate'

// The canonical grammar is generated from the compiler's keyword lists by
// scripts/gen-tmlanguage.ts and gated by tests/tmLanguage.test.ts. This used to be a
// hand-made COPY sitting next to this config, and it had drifted to the pre-generator
// version: it highlighted `char`, `String` and `Box` (none exist in Milo) and missed
// `unsafe`, `from`, `trait`, `interface`, `type`, `move`, the contract keywords and the
// `int`/`byte`/`float`/`string` type names. Read the one file the gate covers.
// Shiki resolves a fence's language by the grammar's `name`, and the generated
// grammar carries the display name 'Milo'. Every ```milo fence therefore missed and
// fell back to plain text while the build still exited 0. Pin the id to the fence.
const miloGrammar = {
  ...JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../editors/vscode/syntaxes/milo.tmLanguage.json'),
      'utf-8',
    ),
  ),
  name: 'milo',
}

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


// Each top-level section owns its own sidebar, keyed by URL prefix. One combined tree
// put all ~90 pages on every page of the site; a reader in std/json had the whole
// language section open above them. Pages that keep a top-level URL for link stability
// (/packages, /benchmarks, /reference, /tour) are mapped onto their section's sidebar
// by an explicit key below, so the nav never disagrees with the sidebar.
const gettingStartedSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Your first program', link: '/getting-started/quickstart' },
      { text: 'Tour of the language', link: '/tour' },
      { text: 'IDE Setup', link: '/getting-started/ide-setup' },
      { text: 'Debugging', link: '/getting-started/debugging' },
    ]
  },
  {
    text: 'Next',
    items: [
      { text: 'Language', link: '/language/' },
      { text: 'Features', link: '/features/' },
      { text: 'Standard Library', link: '/stdlib/' },
    ]
  },
]

const languageSidebar = [
  {
    text: 'Language',
    items: [
      { text: 'Overview', link: '/language/' },
      { text: 'Quick Reference', link: '/reference' },
    ]
  },
  {
    text: 'Basics',
    items: [
      { text: 'Variables & Types', link: '/language/variables' },
      { text: 'Functions', link: '/language/functions' },
      { text: 'Structs', link: '/language/structs' },
      { text: 'Enums & Matching', link: '/language/enums' },
      { text: 'Collections', link: '/language/collections' },
      { text: 'Strings', link: '/language/strings' },
      { text: 'Traits', link: '/language/traits' },
      { text: 'Closures', link: '/language/closures' },
      { text: 'Modules', link: '/language/modules' },
    ]
  },
  {
    text: 'Ownership & Safety',
    items: [
      { text: 'Ownership', link: '/language/ownership' },
      { text: 'Error Handling', link: '/language/error-handling' },
      { text: 'Contracts & Safety', link: '/language/safety' },
      { text: 'Warnings & Errors', link: '/language/warnings-and-errors' },
      { text: 'Keyword Reference', link: '/language/keywords' },
    ]
  },
  {
    text: 'Rationale',
    items: [
      { text: 'Memory Safety vs Rust', link: '/language/vs-rust' },
      { text: 'Why There Are No Lifetimes', link: '/language/why-no-lifetimes' },
      { text: 'Patterns Without Lifetimes', link: '/language/patterns' },
    ]
  },
]

const featuresSidebar = [
  {
    text: 'Features',
    items: [
      { text: 'Overview', link: '/features/' },
      { text: 'Concurrency', link: '/features/concurrency' },
      { text: 'C FFI', link: '/features/ffi' },
      { text: 'Annotations & Builtins', link: '/features/annotations' },
      { text: 'Packages', link: '/packages' },
      { text: 'AI-assisted development', link: '/ai-coding' },
      { text: 'Benchmarks', link: '/benchmarks' },
    ]
  },
]

const stdlibSidebar = [
  {
    text: 'Standard Library',
    items: [
      { text: 'Overview', link: '/stdlib/' },
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
      { text: 'std/foreign', link: '/stdlib/foreign' },
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
    ]
  },
]

// Landing, demos and roadmap belong to no section: give them the four
// entry points rather than an arbitrary section's tree.
const rootSidebar = [
  {
    text: 'Start here',
    items: [
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Tour of the language', link: '/tour' },
    ]
  },
  {
    text: 'Docs',
    items: [
      { text: 'Language', link: '/language/' },
      { text: 'Features', link: '/features/' },
      { text: 'Standard Library', link: '/stdlib/' },
      { text: 'Built with Milo', link: '/demos' },
      { text: 'Roadmap', link: '/roadmap' },
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
  },

  themeConfig: {
    logo: '/logo.svg',

    search: {
      provider: 'local'
    },

    nav: [
      { text: 'Tour', link: '/tour' },
      { text: 'Get Started', link: '/getting-started/installation' },
      { text: 'Language', link: '/language/', activeMatch: '^/(language|reference)' },
      { text: 'Features', link: '/features/', activeMatch: '^/(features|packages|ai-coding|benchmarks)' },
      { text: 'Standard Library', link: '/stdlib/' },
      { text: 'Blog', link: '/blog/', activeMatch: '/blog/' },
      {
        text: 'More',
        items: [
          { text: 'Built with Milo', link: '/demos' },
          { text: 'Quick Reference', link: '/reference' },
          { text: 'Roadmap', link: '/roadmap' },
        ]
      },
    ],

    sidebar: {
      // Blog pages get no sidebar — the docs tree is irrelevant while reading a post.
      '/blog/': [],

      '/getting-started/': gettingStartedSidebar,
      '/tour': gettingStartedSidebar,

      '/language/': languageSidebar,
      '/reference': languageSidebar,

      '/features/': featuresSidebar,
      '/packages': featuresSidebar,
      '/ai-coding': featuresSidebar,
      '/benchmarks': featuresSidebar,

      '/stdlib/': stdlibSidebar,

      '/': rootSidebar,
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/milo-language/milo' }
    ],
  },

  buildEnd: generateFeed,
})
