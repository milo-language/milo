// Hot-reload apply runtime, linked only into `--hot` hosts (src/hot.ts hostLinkFlags).
//
// If MILO_HOT_FIFO is set, a background thread reads lines
//   <patch library path> \t <N> \t <fn1>,<fn2>,... \t <global1>,<global2>,...
// For each one it dlopens the library, copies every global's new initializer
// (`<global>.init.v<N>`, `<global>.init.v<N>.size` bytes) over the host's `<global>`,
// stores the library's `<fn>.v<N>` into the host's `<fn>.slot`, then appends `ok N`
// (or `err N <msg>`) to the file named by MILO_HOT_ACK.
// glibc defines RTLD_DEFAULT only under _GNU_SOURCE.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static const char *ack_path;

static void ack(const char *status, const char *n, const char *msg) {
  FILE *f = fopen(ack_path, "a");
  if (!f) return;
  if (msg) {
    // One line per ack: the driver matches on lines, and dlerror() text can hold newlines.
    fprintf(f, "%s %s ", status, n);
    for (const char *p = msg; *p; p++) fputc(*p == '\n' ? ' ' : *p, f);
    fputc('\n', f);
  } else {
    fprintf(f, "%s %s\n", status, n);
  }
  fclose(f);
}

static void apply(char *line) {
  char *path = line, *n = strchr(line, '\t'), *names;
  if (!n) return;
  *n++ = 0;
  names = strchr(n, '\t');
  if (!names) { ack("err", n, "malformed request"); return; }
  *names++ = 0;
  char *datas = strchr(names, '\t');
  if (datas) *datas++ = 0;

  // Never dlclose: a thread may be inside an old version's code (a frame loop that called
  // the previous body), and unmapping it would crash that frame.
  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  void *h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  clock_gettime(CLOCK_MONOTONIC, &t1);
  if (!h) { ack("err", n, dlerror()); return; }

  // Resolve every slot and body before storing any, so a missing symbol leaves the
  // program on its previous version instead of half patched.
  enum { MAX = 4096 };
  static void **slots[MAX];
  static void *fns[MAX];
  int count = 0;
  char sym[1024];
  for (char *save = NULL, *name = strtok_r(names, ",", &save); name; name = strtok_r(NULL, ",", &save)) {
    if (count == MAX) { ack("err", n, "too many functions in one patch"); return; }
    snprintf(sym, sizeof sym, "%s.slot", name);
    slots[count] = (void **)dlsym(RTLD_DEFAULT, sym);
    snprintf(sym, sizeof sym, "%s.v%s", name, n);
    fns[count] = dlsym(h, sym);
    if (!slots[count] || !fns[count]) {
      char msg[1100];
      snprintf(msg, sizeof msg, "missing %s for %s", slots[count] ? "body" : "slot", name);
      ack("err", n, msg);
      return;
    }
    count++;
  }
  static void *dsts[MAX];
  static const void *srcs[MAX];
  static long long sizes[MAX];
  int ndata = 0;
  for (char *save = NULL, *name = datas ? strtok_r(datas, ",", &save) : NULL; name; name = strtok_r(NULL, ",", &save)) {
    if (ndata == MAX) { ack("err", n, "too many globals in one patch"); return; }
    dsts[ndata] = dlsym(RTLD_DEFAULT, name);
    snprintf(sym, sizeof sym, "%s.init.v%s", name, n);
    srcs[ndata] = dlsym(h, sym);
    snprintf(sym, sizeof sym, "%s.init.v%s.size", name, n);
    const long long *size = (const long long *)dlsym(h, sym);
    if (!dsts[ndata] || !srcs[ndata] || !size) {
      char msg[1100];
      snprintf(msg, sizeof msg, "missing %s for global %s", dsts[ndata] ? "initializer" : "host symbol", name);
      ack("err", n, msg);
      return;
    }
    sizes[ndata++] = *size;
  }
  // Data before code, so a new body never runs against the old value. The copy is not
  // atomic: a thread reading the global during it can see a mix of old and new bytes.
  for (int i = 0; i < ndata; i++) memcpy(dsts[i], srcs[i], (size_t)sizes[i]);
  // Release pairs with the thunk's acquire load: a caller that sees the new pointer also
  // sees everything dlopen wrote (relocations, the patch's constants).
  for (int i = 0; i < count; i++) __atomic_store_n(slots[i], fns[i], __ATOMIC_RELEASE);
  // The dlopen time rides along for `MILO_VERBOSE=1`: on macOS the first load of a new
  // file is assessed by the OS, and that is most of the apply latency.
  char note[64];
  snprintf(note, sizeof note, "dlopen %.1fms", (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6);
  ack("ok", n, note);
}

static void *hot_thread(void *arg) {
  // O_RDWR, not O_RDONLY: the open never blocks waiting for a writer, and this thread
  // holding a write end means read never sees EOF when the driver closes its end
  // between patches.
  int fd = open((const char *)arg, O_RDWR);
  if (fd < 0) return NULL;
  FILE *in = fdopen(fd, "r");
  if (!in) return NULL;
  char *line = NULL;
  size_t cap = 0;
  ssize_t len;
  while ((len = getline(&line, &cap, in)) > 0) {
    if (line[len - 1] == '\n') line[len - 1] = 0;
    apply(line);
  }
  return NULL;
}

__attribute__((constructor)) static void milo_hot_init(void) {
  const char *fifo = getenv("MILO_HOT_FIFO");
  ack_path = getenv("MILO_HOT_ACK");
  if (!fifo || !ack_path) return;
  pthread_t t;
  if (pthread_create(&t, NULL, hot_thread, (void *)fifo) == 0) pthread_detach(t);
}
