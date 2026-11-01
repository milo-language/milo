// Live heap blocks at exit, for scripts/mlir-same.ts --owned: injected with
// DYLD_INSERT_LIBRARIES (darwin), it counts malloc/calloc/realloc/free and writes the
// number of blocks still allocated at exit to $MILO_LIVECOUNT_OUT. The same program built
// by legacy codegen and by MILO_MLIR=1 must end with the same number: one more is a
// missing drop, one fewer an extra free. A count, not a leak report, so unlike `leaks` it
// needs no task port (which this machine's lldb and `leaks` cannot get).
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static long live;

static void *count_malloc(size_t n) {
  void *p = malloc(n);
  if (p) __atomic_add_fetch(&live, 1, __ATOMIC_RELAXED);
  return p;
}
static void *count_calloc(size_t a, size_t b) {
  void *p = calloc(a, b);
  if (p) __atomic_add_fetch(&live, 1, __ATOMIC_RELAXED);
  return p;
}
static void *count_realloc(void *q, size_t n) {
  void *p = realloc(q, n);
  if (p && !q) __atomic_add_fetch(&live, 1, __ATOMIC_RELAXED);
  return p;
}
static void count_free(void *p) {
  if (p) __atomic_sub_fetch(&live, 1, __ATOMIC_RELAXED);
  free(p);
}

// write(2), not stdio: at exit stdio may already be torn down, and its buffer would count.
__attribute__((destructor)) static void report(void) {
  const char *out = getenv("MILO_LIVECOUNT_OUT");
  if (!out) return;
  int fd = open(out, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return;
  char buf[32];
  int n = snprintf(buf, sizeof buf, "%ld\n", live);
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
