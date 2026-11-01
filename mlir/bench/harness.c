// Drives axpy and grid built by either backend: `check` prints result bits for a
// differential compare, `panic` runs axpy with a short b, `bench` times both kernels.
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct { double *ptr; int64_t len, cap; } Vec;
void axpy(Vec *a, Vec *b, double k);
void grid(Vec *m, int64_t w, int64_t h);

static Vec *g_watch;

static uint64_t digest(const Vec *v) {
  uint64_t h = 1469598103934665603ull;
  for (int64_t i = 0; i < v->len; i++) {
    uint64_t bits;
    memcpy(&bits, &v->ptr[i], 8);
    h = (h ^ bits) * 1099511628211ull;
  }
  return h;
}

// The milo-opt pipeline calls this; the baseline module carries its own.
void __milo_bounds_fail(int64_t idx, int64_t len, int32_t line) {
  int64_t written = 0;
  for (int64_t i = 0; i < g_watch->len; i++)
    if (g_watch->ptr[i] != 1.0) written++;
  printf("bounds fail idx=%" PRId64 " len=%" PRId64 " line=%d written=%" PRId64
         " digest=%016" PRIx64 "\n", idx, len, line, written, digest(g_watch));
  exit(101);
}

static Vec make(int64_t n, double seed) {
  Vec v = {malloc(sizeof(double) * (n ? n : 1)), n, n};
  for (int64_t i = 0; i < n; i++) v.ptr[i] = seed + (double)(i % 17) * 0.25;
  return v;
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "check";
  if (!strcmp(mode, "check")) {
    for (int64_t n = 0; n < 40; n += 3) {
      Vec a = make(n, 1.0), b = make(n + 5, 2.0);
      axpy(&a, &b, 3.0);
      printf("axpy n=%" PRId64 " %016" PRIx64 "\n", n, digest(&a));
    }
    int64_t dims[][2] = {{1, 1}, {7, 5}, {37, 29}, {64, 64}, {3, 100}};
    for (int i = 0; i < 5; i++) {
      Vec m = make(dims[i][0] * dims[i][1], 0.5);
      grid(&m, dims[i][0], dims[i][1]);
      printf("grid %" PRId64 "x%" PRId64 " %016" PRIx64 "\n", dims[i][0], dims[i][1], digest(&m));
    }
  } else if (!strcmp(mode, "panic")) {
    int64_t blen = argc > 2 ? atoll(argv[2]) : 50;
    Vec a = make(100, 1.0), b = make(blen, 2.0);
    for (int64_t i = 0; i < a.len; i++) a.ptr[i] = 1.0;
    g_watch = &a;
    axpy(&a, &b, 3.0);
    printf("no panic\n");
  } else if (!strcmp(mode, "bench")) {
    Vec a = make(4096, 1.0), b = make(4096, 2.0);
    double t0 = now();
    for (int r = 0; r < 200000; r++) axpy(&a, &b, 1e-9);
    double t1 = now();
    Vec m = make(1024 * 1024, 0.5);
    for (int r = 0; r < 200; r++) grid(&m, 1024, 1024);
    double t2 = now();
    printf("axpy %.3f ns/elem  grid %.3f ns/elem  (%016" PRIx64 ")\n",
           (t1 - t0) / (200000.0 * 4096) * 1e9, (t2 - t1) / (200.0 * 1024 * 1023) * 1e9,
           digest(&a) ^ digest(&m));
  }
  return 0;
}
