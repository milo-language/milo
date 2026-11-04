// Live heap blocks at exit, for scripts/mlir-same.ts --owned: injected with
// DYLD_INSERT_LIBRARIES (darwin), it counts malloc/calloc/realloc/free and writes the
// number of blocks still allocated at exit to $MILO_LIVECOUNT_OUT. The same program built
// through MLIR must end with the number the reference interpreter ends with: one more is a
// missing drop, one fewer an extra free. A count, not a leak report, so unlike `leaks` it
// needs no task port (which this machine's lldb and `leaks` cannot get).
//
// Only calls made from the main executable's own code count. libSystem allocates for
// itself (stdio buffers, locale, atexit tables) and how much depends on the binary's
// layout: the same scalar program at -O0 ended with 185 live blocks built one way and 184
// the other, with no difference in what the Milo code allocated.
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <mach-o/getsect.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static long live;
static uintptr_t text_lo, text_hi;

static int from_program(void *ret) {
  if (!text_hi) {
    // The executable is not image 0 once this library is inserted ahead of it.
    const struct mach_header_64 *exe = 0;
    for (uint32_t i = 0; i < _dyld_image_count() && !exe; i++) {
      const struct mach_header *h = _dyld_get_image_header(i);
      if (h->filetype == MH_EXECUTE) exe = (const struct mach_header_64 *)h;
    }
    unsigned long size = 0;
    uint8_t *lo = exe ? getsegmentdata(exe, "__TEXT", &size) : 0;
    text_lo = (uintptr_t)lo;
    text_hi = (uintptr_t)lo + size;
  }
  return (uintptr_t)ret >= text_lo && (uintptr_t)ret < text_hi;
}
#define FROM_PROGRAM from_program(__builtin_return_address(0))

static void *count_malloc(size_t n) {
  void *p = malloc(n);
  if (p && FROM_PROGRAM) __atomic_add_fetch(&live, 1, __ATOMIC_RELAXED);
  return p;
}
static void *count_calloc(size_t a, size_t b) {
  void *p = calloc(a, b);
  if (p && FROM_PROGRAM) __atomic_add_fetch(&live, 1, __ATOMIC_RELAXED);
  return p;
}
static void *count_realloc(void *q, size_t n) {
  void *p = realloc(q, n);
  if (p && !q && FROM_PROGRAM) __atomic_add_fetch(&live, 1, __ATOMIC_RELAXED);
  return p;
}
static void count_free(void *p) {
  if (p && FROM_PROGRAM) __atomic_sub_fetch(&live, 1, __ATOMIC_RELAXED);
  free(p);
}

// write(2), not stdio: at exit stdio may already be torn down, and its buffer would count.
__attribute__((destructor)) static void report(void) {
  const char *out = getenv("MILO_LIVECOUNT_OUT");
  if (!out) return;
  int fd = open(out, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return;
  char buf[32];
  // No executable found means nothing was counted; say so rather than report 0.
  from_program(0);
  int n = text_hi ? snprintf(buf, sizeof buf, "%ld\n", live) : snprintf(buf, sizeof buf, "no executable\n");
  write(fd, buf, n);
  close(fd);
}

#define INTERPOSE(mine, theirs)                                                          \
  __attribute__((used)) static struct { const void *m, *t; } interpose_##theirs          \
      __attribute__((section("__DATA,__interpose"))) = {(const void *)mine, (const void *)theirs};
INTERPOSE(count_malloc, malloc)
INTERPOSE(count_calloc, calloc)
INTERPOSE(count_realloc, realloc)
INTERPOSE(count_free, free)
