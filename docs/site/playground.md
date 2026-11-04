---
prev: false
next: false
aside: false
---

<script setup>
// Imported here, not registered in the theme, so the editor ships with this page only.
import Playground from './.vitepress/theme/Playground.vue'
</script>

# Playground

Type Milo and run it here. The compiler's front end (lexer, parser, import resolver and type checker) and the reference interpreter run in your browser; nothing is sent anywhere.

<ClientOnly>
  <Playground />
</ClientOnly>

The interpreter runs the checked program directly, with no code generation, so it is slow and covers part of the language. A feature it does not run yet prints `unsupported:` and the output so far. Programs that call into the OS (files, sockets, threads) are out of scope here; install Milo to compile and run those natively: see [Installation](/getting-started/installation).
