// Freestanding wasm64 runtime for Milo programs — the wasm64 analog of
// tools/cortex-m/startup.c. There is no OS, no libc, no crt0: this file
// supplies every symbol Milo's codegen (src/codegen.ts) can auto-declare
// (see its declaredExterns pass), plus a JS/host I/O boundary, so that
// `clang --target=wasm64-unknown-unknown -nostdlib` can link a Milo module
// straight to a runnable .wasm.
//
// Design mirrors startup.c: a bump allocator (no reclamation), hand-rolled
// mem*/str* primitives, and every host interaction (write, randomness,
// process exit) funneled through a small number of `import_module("env")`
// declarations that tools/wasm/run.mjs implements in JS.
//
// wasm64 was chosen over wasm32 because Milo's codegen assumes an 8-byte
// size_t/pointer everywhere (see AGENTS.md's target-selection note): malloc,
// memcpy, memcmp, memchr, fwrite, write are all declared with i64 size
// params, which matches wasm64 exactly and mismatches wasm32 on every one
// of them.
//
// Float formatting and parsing are real, not stubs: see the "exact decimal
// <-> binary" section below. They are exact big-integer algorithms because
// src/codegen.ts's @milo.fmt.f64 helper prints with snprintf("%.*g", ...) and
// re-parses with strtod, raising precision until the text reads back
// bit-identical — a dtoa or strtod that is off by one ulp makes that search
// stop at the wrong digit count and print a number that does not round-trip.
//
// Explicit non-goals, called out rather than silently botched:
//   - No threads/async/net/fs/sockets: those need std/runtime's green-thread
//     scheduler (getcontext/makecontext/swapcontext + mmap) and std/os's BSD
//     socket calls, neither of which has a wasm equivalent short of an
//     Asyncify/CPS rewrite. std/platform.wasm.milo aborts those by name
//     rather than linking a stub that pretends to work.

typedef unsigned long long u64;
typedef long long i64;

// ── host imports (implemented in tools/wasm/run.mjs) ──────────────────────

// Byte-exact write of `n` bytes at `buf` to file descriptor `fd` (1=stdout,
// 2=stderr — the only two fds any Milo program can reach). Returns the
// number of bytes written, mirroring POSIX write(2). This is the ONE I/O
// primitive the whole runtime is built on: fwrite/putchar/dprintf/printf all
// funnel through it, so fd 1 vs fd 2 stay distinct all the way to the host
// (see src/codegen.ts's emitFdWrite/emitStdoutWrite/emitFdPrintf, which pick
// fd 1 for print()'s raw-string path and fd 2 for every panic/bounds/
// overflow message).
__attribute__((import_module("env"), import_name("fd_write")))
i64 __milo_fd_write(int fd, const void *buf, u64 n);

// Fills `n` bytes at `buf` with cryptographically-strong randomness. Backs
// getentropy(), which std/collections' HashMap uses to seed its DoS-resistant
// hash — a constant seed here would silently defeat that, so this must be a
// real host RNG call (crypto.getRandomValues in run.mjs), not a stub.
__attribute__((import_module("env"), import_name("get_random")))
void __milo_get_random(void *buf, u64 n);

// Terminates the host process with `code`, WASI proc_exit style. This is a
// real exit, not a wasm trap: it lets exit()/abort()/a checked-panic unwind
// out of arbitrarily deep Milo call frames by just ending the host process,
// exactly like _exit(2) does on a hosted target. run.mjs implements it as
// `process.exit(code)`.
__attribute__((import_module("env"), import_name("proc_exit")))
__attribute__((noreturn))
void __milo_proc_exit(int code);

// ── fatal-error helpers ────────────────────────────────────────────────────

static u64 milo_strlen(const char *s) {
    const char *p = s;
    while (*p) p++;
    return (u64)(p - s);
}

// Print a NUL-terminated message to stderr and end the process. Every
// "unsupported on wasm" path below (float format/parse, oom) funnels here so
// the failure is always visible on the console the host is watching, never a
// silent wrong value or a bare wasm trap with no explanation.
__attribute__((noreturn))
static void milo_fatal(const char *msg, int code) {
    __milo_fd_write(2, msg, milo_strlen(msg));
    __milo_proc_exit(code);
    __builtin_unreachable();
}

// ── bump allocator ──────────────────────────────────────────────────────────
//
// No reclamation, same as startup.c's — free() is a no-op. Unlike Cortex-M
// (a fixed RAM span from the linker script), wasm has no static memory
// ceiling: the heap starts at the linker-provided `__heap_base` (right after
// all of the program's static data — wasm-ld computes this the same way it
// computes __heap_base for wasm32) and grows the linear memory on demand via
// memory.grow, capped by -DMILO_HEAP_SIZE exactly like startup.c's bound on
// the Cortex-M heap.
//
// Each allocation gets an 8-byte size header ahead of the returned pointer.
// startup.c doesn't need one (its free() is a no-op and nothing ever calls
// realloc on that target), but wasm's std/collections growth path
// (bufAppendFn) does call realloc, and a bump allocator with no header has no
// way to know how many bytes of the old block were actually valid — it would
// have to guess. The header makes realloc's copy exact instead of a guess.
extern unsigned char __heap_base;

static unsigned char *g_heapNext = 0;   // bump cursor; lazily set to &__heap_base
static u64 g_heapBase = 0;              // cached (u64)&__heap_base, for the MILO_HEAP_SIZE cap

#define WASM_PAGE_SIZE 65536ULL

__attribute__((noreturn))
static void milo_oom(void) {
    milo_fatal("milo: out of memory (wasm heap exhausted)\n", 12); // ENOMEM, matches startup.c's oom() exit code
}

// Grow linear memory so that at least `untilByte` bytes are addressable.
// wasm memory only grows in whole 64 KiB pages and never shrinks, matching
// the one-way nature of startup.c's bump heap (also never reclaimed).
static void milo_ensureMemory(u64 untilByte) {
    u64 haveBytes = __builtin_wasm_memory_size(0) * WASM_PAGE_SIZE;
    if (untilByte <= haveBytes) return;
#ifdef MILO_HEAP_SIZE
    if (untilByte - g_heapBase > (u64)(MILO_HEAP_SIZE)) milo_oom();
#endif
    u64 needBytes = untilByte - haveBytes;
    u64 needPages = (needBytes + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;
    u64 got = __builtin_wasm_memory_grow(0, needPages);
    if (got == (u64)-1) milo_oom();
}

void *malloc(u64 n) {
    if (g_heapNext == 0) {
        g_heapNext = &__heap_base;
        g_heapBase = (u64)&__heap_base;
    }
    // header (8 bytes) + payload, 8-byte aligned throughout — the widest
    // primitive Milo ever hands libc is an i64/double/pointer, all 8-byte.
    u64 payload = (n + 7ULL) & ~7ULL;
    u64 total = payload + 8ULL;
    u64 base = (u64)g_heapNext;
    milo_ensureMemory(base + total);
    u64 *hdr = (u64 *)g_heapNext;
    *hdr = n; // record the CALLER's requested size, not the padded total — realloc copies exactly this many bytes
    void *p = (void *)(g_heapNext + 8);
    g_heapNext += total;
    return p;
}

void free(void *p) { (void)p; } // no reclamation — same tradeoff as startup.c, see file header

// malloc + memcpy the old bytes forward, then leak the old block (free() is
// already a no-op, so this costs nothing free() itself wasn't already
// costing). Correct, not space-efficient: a real allocator would resize in
// place when possible, but a bump allocator has no "in place" to resize into.
void *realloc(void *p, u64 newSize) {
    if (!p) return malloc(newSize);
    u64 oldSize = ((u64 *)p)[-1];
    void *np = malloc(newSize);
    u64 copyLen = oldSize < newSize ? oldSize : newSize;
    unsigned char *d = np;
    const unsigned char *s = p;
    for (u64 i = 0; i < copyLen; i++) d[i] = s[i];
    return np;
}

// ── mem*/str* primitives (ported from tools/cortex-m/startup.c) ───────────

void *memcpy(void *dst, const void *src, u64 n) {
    unsigned char *d = dst;
    const unsigned char *s = src;
    while (n--) *d++ = *s++;
    return dst;
}

void *memset(void *dst, int c, u64 n) {
    unsigned char *d = dst;
    while (n--) *d++ = (unsigned char)c;
    return dst;
}

// Not declared anywhere in src/codegen.ts or std/*.milo — clang's optimizer inserts
// this call ON ITS OWN. At -O2, InstCombine recognizes a malloc() immediately
// followed by memset(...,0,...) (std/collections' HashMap zeroing a fresh bucket
// array is the case that surfaced this) and rewrites the pair into one calloc()
// call, using the target's TargetLibraryInfo to decide the substitution is legal —
// which fires regardless of -ffreestanding, so simply never emitting a call to
// calloc from Milo's own output does not stop clang from inserting one anyway.
// Cheapest correct fix is to just supply it, the same way a real freestanding libc
// would (defined after malloc/memset above since it's built directly on both).
void *calloc(u64 nmemb, u64 size) {
    u64 n = nmemb * size; // no overflow-checked variant needed here — same as real calloc's baseline contract
    void *p = malloc(n);
    memset(p, 0, n);
    return p;
}

void *memchr(const void *s, int c, u64 n) {
    const unsigned char *p = s;
    while (n--) {
        if (*p == (unsigned char)c) return (void *)p;
        p++;
    }
    return 0;
}

int memcmp(const void *a, const void *b, u64 n) {
    const unsigned char *x = a, *y = b;
    while (n--) {
        if (*x != *y) return *x - *y;
        x++; y++;
    }
    return 0;
}

u64 strlen(const char *s) { return milo_strlen(s); }

// ── 128-bit multiply (compiler-rt's __multi3) ───────────────────────────────
//
// A freestanding link has no compiler-rt/libgcc to resolve the widening-
// multiply helper LLVM emits for i64*i64 overflow checks (see main.ts's
// reportMissingBuiltins, which explains the ARM sibling of this problem:
// __aeabi_* soft-float and __udivdi3-family 64-bit-divide helpers there).
// On wasm the gap is __multi3 specifically.
//
// This body must NOT be `return a * b`. That is what it used to be, on the
// theory that SelectionDAG's "the libcall I'd emit has the same name as the
// function I'm compiling" special case would keep it from recursing. It does
// not on wasm64: any Milo program whose i64 overflow check actually fired
// (std/collections' HashMap hashing, every json fixture) blew the stack in
// __multi3 calling __multi3. So the 128-bit product is assembled by hand out
// of 64x64->64 multiplies, which are single wasm i64.mul instructions and
// cannot lower to a libcall.
typedef __int128 ti_int;

// x*y as a 128-bit result in two halves, via 32-bit limbs so every multiply
// below stays inside one i64.
static void mulFull64(u64 x, u64 y, u64 *lo, u64 *hi) {
    u64 x0 = x & 0xFFFFFFFFULL, x1 = x >> 32;
    u64 y0 = y & 0xFFFFFFFFULL, y1 = y >> 32;
    u64 p00 = x0 * y0, p01 = x0 * y1, p10 = x1 * y0, p11 = x1 * y1;
    u64 mid = (p00 >> 32) + (p01 & 0xFFFFFFFFULL) + (p10 & 0xFFFFFFFFULL);
    *lo = (p00 & 0xFFFFFFFFULL) | (mid << 32);
    *hi = p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
}

ti_int __multi3(ti_int a, ti_int b) {
    unsigned __int128 ua = (unsigned __int128)a, ub = (unsigned __int128)b;
    u64 al = (u64)ua, ah = (u64)(ua >> 64);
    u64 bl = (u64)ub, bh = (u64)(ub >> 64);
    u64 lo, hi;
    mulFull64(al, bl, &lo, &hi);
    hi += al * bh + ah * bl; // the cross terms only ever reach the high half
    return (ti_int)(((unsigned __int128)hi << 64) | (unsigned __int128)lo);
}

// ── exact big integers (the substrate for dtoa + strtod) ───────────────────
//
// Both directions of decimal<->binary conversion are done in exact integer
// arithmetic. Correct rounding is not a nicety here: codegen's float printer
// (see the file header) only terminates on the right digit count if snprintf
// and strtod agree to the last bit, and there is no libm to lean on anyway.
//
// Little-endian u32 limbs; `n` is the used-limb count, so n == 0 means zero
// and the top limb is always nonzero. Sizing is driven by strtod's worst case:
// a subnormal-range input needs a denominator of 10^1200 (~3986 bits), which
// the 53-step division loop then shifts up by another ~54 bits. 160 limbs =
// 5120 bits leaves headroom; bigOverflow() aborts loudly if anything ever
// exceeds it rather than silently wrapping.
#define BIG_LIMBS 160

typedef struct { int n; unsigned int d[BIG_LIMBS]; } Big;

__attribute__((noreturn))
static void bigOverflow(void) {
    milo_fatal("milo: internal error — bignum overflow in the wasm float conversion routines\n", 70);
}

static void bigSetU64(Big *a, u64 v) {
    a->n = 0;
    while (v) { a->d[a->n++] = (unsigned int)(v & 0xFFFFFFFFu); v >>= 32; }
}

static u64 bigToU64(const Big *a) { // caller guarantees a->n <= 2
    u64 v = 0;
    for (int i = a->n - 1; i >= 0; i--) v = (v << 32) | (u64)a->d[i];
    return v;
}

static void bigCopy(Big *dst, const Big *src) {
    dst->n = src->n;
    for (int i = 0; i < src->n; i++) dst->d[i] = src->d[i];
}

static void bigMulSmall(Big *a, unsigned int m) {
    u64 carry = 0;
    for (int i = 0; i < a->n; i++) {
        u64 t = (u64)a->d[i] * (u64)m + carry;
        a->d[i] = (unsigned int)t;
        carry = t >> 32;
    }
    while (carry) {
        if (a->n >= BIG_LIMBS) bigOverflow();
        a->d[a->n++] = (unsigned int)carry;
        carry >>= 32;
    }
}

static void bigAddSmall(Big *a, unsigned int v) {
    u64 carry = v;
    int i = 0;
    for (; i < a->n && carry; i++) {
        u64 t = (u64)a->d[i] + carry;
        a->d[i] = (unsigned int)t;
        carry = t >> 32;
    }
    while (carry) {
        if (a->n >= BIG_LIMBS) bigOverflow();
        a->d[a->n++] = (unsigned int)carry;
        carry >>= 32;
    }
}

static const unsigned int MILO_P10U32[10] = {
    1u, 10u, 100u, 1000u, 10000u, 100000u, 1000000u, 10000000u, 100000000u, 1000000000u
};

// a *= 10^k. Chunked by 10^9 (the largest power of ten that fits in a limb),
// so a 1200-digit scale costs ~134 limb passes rather than 1200.
static void bigMulPow10(Big *a, int k) {
    if (a->n == 0 || k <= 0) return;
    while (k >= 9) { bigMulSmall(a, 1000000000u); k -= 9; }
    if (k > 0) bigMulSmall(a, MILO_P10U32[k]);
}

static void bigShl(Big *a, int bits) {
    if (a->n == 0 || bits <= 0) return;
    int limbs = bits >> 5, rem = bits & 31;
    if (rem) {
        unsigned int carry = 0;
        for (int i = 0; i < a->n; i++) {
            unsigned int v = a->d[i];
            a->d[i] = (v << rem) | carry;
            carry = v >> (32 - rem);
        }
        if (carry) {
            if (a->n >= BIG_LIMBS) bigOverflow();
            a->d[a->n++] = carry;
        }
    }
    if (limbs) {
        if (a->n + limbs > BIG_LIMBS) bigOverflow();
        for (int i = a->n - 1; i >= 0; i--) a->d[i + limbs] = a->d[i];
        for (int i = 0; i < limbs; i++) a->d[i] = 0;
        a->n += limbs;
    }
}

static int bigCmp(const Big *a, const Big *b) {
    if (a->n != b->n) return a->n < b->n ? -1 : 1;
    for (int i = a->n - 1; i >= 0; i--)
        if (a->d[i] != b->d[i]) return a->d[i] < b->d[i] ? -1 : 1;
    return 0;
}

static void bigSub(Big *a, const Big *b) { // a -= b; caller guarantees a >= b
    u64 borrow = 0;
    for (int i = 0; i < a->n; i++) {
        u64 bv = (i < b->n ? (u64)b->d[i] : 0ULL) + borrow;
        u64 av = (u64)a->d[i];
        if (av >= bv) { a->d[i] = (unsigned int)(av - bv); borrow = 0; }
        else { a->d[i] = (unsigned int)(av + 0x100000000ULL - bv); borrow = 1; }
    }
    while (a->n > 0 && a->d[a->n - 1] == 0) a->n--;
}

static int bigBitLen(const Big *a) {
    if (a->n == 0) return 0;
    return (a->n - 1) * 32 + (32 - __builtin_clz(a->d[a->n - 1]));
}

// ── dtoa: Steele & White / Dragon4, fixed digit count ──────────────────────
//
// The value is held as an exact fraction num/den scaled into [1, 10), and each
// digit falls out of "subtract den while it fits, then multiply by ten". No
// approximation anywhere, so the result is the exact decimal expansion,
// rounded once at the end (round-half-to-even on the *exact* value — verified
// against this host's libc, which is the oracle the wasm differential test
// diffs against: %.1f of 0.25 is "0.2", %.0f of 2.5 is "2").
//
// Every scratch Big is file-static rather than a local: they are ~640 bytes
// each and wasm-ld's default stack is modest. Safe because none of these paths
// is reentrant — wasm is single-threaded with no signal handlers, printf never
// re-enters itself, and codegen's print/re-parse loop calls snprintf and strtod
// strictly one after the other (which is also why formatting and parsing get
// separate scratch, so a future nesting can't silently corrupt one from the
// other).
static Big g_fmtNum, g_fmtDen, g_fmtTmp;

// The largest precision any float conversion will accept. Well past printf's
// useful range (%.1074f of the smallest subnormal is the longest exact
// expansion that exists) and past anything codegen emits (17).
#define MILO_MAX_FLOAT_PREC 1100
// Worst case digit count: DBL_MAX's 309 integer digits plus the fraction.
#define MILO_FDIGITS_MAX (MILO_MAX_FLOAT_PREC + 340)
static char g_fmtDigits[MILO_FDIGITS_MAX];

// Loads |v| (finite, nonzero) into num/den scaled so num/den is in [1, 10),
// with *decExp = X such that v == (num/den) * 10^X — i.e. X is floor(log10 v),
// the decimal place of the leading digit.
static void floatScale(double v, Big *num, Big *den, Big *tmp, int *decExp) {
    u64 bits;
    __builtin_memcpy(&bits, &v, 8);
    int be = (int)((bits >> 52) & 0x7FFu);
    u64 mant = bits & 0xFFFFFFFFFFFFFULL;
    u64 f;
    int e;
    if (be == 0) { f = mant; e = -1074; }              // subnormal: no implicit leading bit
    else { f = mant | (1ULL << 52); e = be - 1075; }
    // v == f * 2^e exactly.
    bigSetU64(num, f);
    bigSetU64(den, 1);
    if (e >= 0) bigShl(num, e); else bigShl(den, -e);

    // Seed X from the binary exponent: 2^ebits <= v < 2^(ebits+1), so
    // floor(ebits*log10(2)) is within one of floor(log10 v). Plain double
    // multiply — log10() would need a libm this target does not have.
    int ebits = e + (64 - __builtin_clzll(f)) - 1;
    double t = (double)ebits * 0.301029995663981195;
    int X = (int)t;
    if (t < 0.0 && (double)X != t) X--; // (int) truncates toward zero; we want floor
    if (X >= 0) bigMulPow10(den, X); else bigMulPow10(num, -X);

    // Fix the seed. Multiplying num by ten scales num/den up, so X drops by
    // one to keep v == (num/den) * 10^X; multiplying den does the reverse.
    while (bigCmp(num, den) < 0) { bigMulSmall(num, 10); X--; }
    for (;;) {
        bigCopy(tmp, den);
        bigMulSmall(tmp, 10);
        if (bigCmp(num, tmp) < 0) break;
        bigCopy(den, tmp);
        X++;
    }
    *decExp = X;
}

// Emits exactly P (>= 1) decimal digits of num/den (pre-scaled into [1,10)),
// correctly rounded. *decExp is bumped if rounding carries out of the leading
// digit (9.99 -> 10.0 at two digits).
static void genDigits(Big *num, Big *den, Big *tmp, int P, char *digits, int *decExp) {
    for (int i = 0; i < P; i++) {
        int d = 0;
        while (bigCmp(num, den) >= 0) { bigSub(num, den); d++; }
        // num/den < 10 is the scaling invariant, so d is a digit. If it ever
        // isn't, the scaling is broken and every digit after this is garbage —
        // stop instead of emitting a character past '9'.
        if (d > 9) milo_fatal("milo: internal error — float digit generation lost its scale\n", 70);
        digits[i] = (char)('0' + d);
        bigMulSmall(num, 10);
    }
    // The un-emitted tail is worth (num/den)/10 of the last digit's place, so
    // it passes a half exactly when num > 5*den, and ties land on num == 5*den.
    bigCopy(tmp, den);
    bigMulSmall(tmp, 5);
    int c = bigCmp(num, tmp);
    if (c > 0 || (c == 0 && ((digits[P - 1] - '0') & 1))) { // ties to even
        for (int i = P - 1;; i--) {
            if (digits[i] != '9') { digits[i]++; break; }
            digits[i] = '0';
            if (i == 0) { digits[0] = '1'; (*decExp)++; break; }
        }
    }
}

// ── formatted output ─────────────────────────────────────────────────────
//
// snprintf/dprintf/printf share one format-string walker. The specifier set
// is deliberately narrow — exactly what src/codegen.ts ever emits (grepped
// literal format strings in codegen.ts: %d %u %lld %llu %s %.*s %p %.*g;
// see BOUNDS_ERR_MSG, the overflow-check message, emitDisplayPart, and
// ensureFloatFormatHelper). Width/flags are parsed and skipped (accepted for
// robustness) but not applied — nothing Milo emits ever uses them.
//
// %f %F %e %E %g %G are real conversions built on the exact dtoa above.
// %a/%A (hex float) still abort — nothing in codegen or std emits them, and a
// wrong-but-plausible hex float is worse than a loud stop.

#include <stdarg.h>

typedef struct { char *buf; u64 cap; u64 pos; } Sink;

static void sinkPutc(Sink *s, char c) {
    if (s->buf && s->pos < s->cap) s->buf[s->pos] = c;
    s->pos++;
}

static void sinkWrite(Sink *s, const char *p, u64 n) {
    for (u64 i = 0; i < n; i++) sinkPutc(s, p[i]);
}

static void emitUnsigned(Sink *s, u64 v, int base, int upper) {
    char digitsBuf[32];
    int i = 0;
    const char *digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    if (v == 0) digitsBuf[i++] = '0';
    while (v) { digitsBuf[i++] = digits[v % (u64)base]; v /= (u64)base; }
    while (i > 0) sinkPutc(s, digitsBuf[--i]);
}

static void emitSigned(Sink *s, i64 v) {
    if (v < 0) {
        sinkPutc(s, '-');
        // avoid UB negating INT64_MIN: fold the "+1" back in after negating the rest
        u64 uv = (u64)(-(v + 1)) + 1ULL;
        emitUnsigned(s, uv, 10, 0);
    } else {
        emitUnsigned(s, (u64)v, 10, 0);
    }
}

// %f-style body: `digits[0..P)` are significant digits with digits[0] in the
// 10^X place; write the integer part then exactly F fraction digits. Positions
// outside the digit string are zeros, which is what lets one digit string
// serve both "1" at X=3 (-> "1000") and "1" at X=-4 (-> "0.0001").
static void renderFixed(Sink *s, const char *digits, int P, int X, int F) {
    if (X >= 0) for (int i = 0; i <= X; i++) sinkPutc(s, i < P ? digits[i] : '0');
    else sinkPutc(s, '0');
    if (F > 0) {
        sinkPutc(s, '.');
        for (int j = 0; j < F; j++) {
            int idx = X + 1 + j;
            sinkPutc(s, (idx >= 0 && idx < P) ? digits[idx] : '0');
        }
    }
}

// %e-style body: one leading digit, F fraction digits, then the exponent with
// C's minimum of two digits ("1e+00", "4.94e-324").
static void renderExp(Sink *s, const char *digits, int P, int X, int F, int upper) {
    sinkPutc(s, P > 0 ? digits[0] : '0');
    if (F > 0) {
        sinkPutc(s, '.');
        for (int j = 1; j <= F; j++) sinkPutc(s, j < P ? digits[j] : '0');
    }
    sinkPutc(s, upper ? 'E' : 'e');
    int ex = X;
    if (ex < 0) { sinkPutc(s, '-'); ex = -ex; } else sinkPutc(s, '+');
    if (ex >= 100) sinkPutc(s, (char)('0' + ex / 100));
    sinkPutc(s, (char)('0' + (ex / 10) % 10));
    sinkPutc(s, (char)('0' + ex % 10));
}

// The float conversions. `prec` is -1 when the format string omitted it (C's
// default of 6 for all three). Width and flags are parsed and dropped by the
// caller, floats included — see the section header.
static void emitFloat(Sink *s, double v, char conv, int prec) {
    int upper = conv >= 'A' && conv <= 'Z';
    char lc = upper ? (char)(conv + 32) : conv;
    u64 bits;
    __builtin_memcpy(&bits, &v, 8);
    int neg = (int)(bits >> 63);

    if (((bits >> 52) & 0x7FFu) == 0x7FFu) {
        // NaN prints unsigned, infinity signed — matched to this host's libc,
        // which is the oracle the wasm-vs-native differential test diffs against.
        if (bits & 0xFFFFFFFFFFFFFULL) { sinkWrite(s, upper ? "NAN" : "nan", 3); return; }
        if (neg) sinkPutc(s, '-');
        sinkWrite(s, upper ? "INF" : "inf", 3);
        return;
    }
    if (prec < 0) prec = 6;
    if (prec > MILO_MAX_FLOAT_PREC)
        milo_fatal("milo: printf float precision above 1100 is unsupported on the wasm runtime\n", 70);
    if (neg) sinkPutc(s, '-'); // including -0.0, which libc also signs
    double av = neg ? -v : v;

    char *digits = g_fmtDigits;
    int X = 0, P = 1;
    if (lc == 'f') {
        if (av == 0.0) { digits[0] = '0'; }
        else {
            floatScale(av, &g_fmtNum, &g_fmtDen, &g_fmtTmp, &X);
            P = X + 1 + prec; // digits from the leading one down to the 10^-prec place
            if (P > 0) {
                genDigits(&g_fmtNum, &g_fmtDen, &g_fmtTmp, P, digits, &X);
            } else {
                // Below the last kept place entirely: the answer is 0 or a lone
                // 1 there. P == 0 means v is in [10^-prec-1, 10^-prec), so it
                // rounds up exactly when num/den > 5 (ties to even -> down);
                // P < 0 means v is smaller still and always rounds to zero.
                int up = 0;
                if (P == 0) {
                    bigCopy(&g_fmtTmp, &g_fmtDen);
                    bigMulSmall(&g_fmtTmp, 5);
                    up = bigCmp(&g_fmtNum, &g_fmtTmp) > 0;
                }
                if (up) { digits[0] = '1'; X = -prec; }
                else { digits[0] = '0'; X = 0; }
                P = 1;
            }
        }
        renderFixed(s, digits, P, X, prec);
        return;
    }
    if (lc == 'e') {
        P = prec + 1;
        if (av == 0.0) { for (int i = 0; i < P; i++) digits[i] = '0'; }
        else {
            floatScale(av, &g_fmtNum, &g_fmtDen, &g_fmtTmp, &X);
            genDigits(&g_fmtNum, &g_fmtDen, &g_fmtTmp, P, digits, &X);
        }
        renderExp(s, digits, P, X, prec, upper);
        return;
    }
    // %g: precision is a significant-digit count (0 means 1), the exponent
    // decides fixed vs scientific, and trailing fraction zeros are stripped.
    int sig = prec == 0 ? 1 : prec;
    if (av == 0.0) { digits[0] = '0'; P = 1; }
    else {
        floatScale(av, &g_fmtNum, &g_fmtDen, &g_fmtTmp, &X);
        P = sig;
        genDigits(&g_fmtNum, &g_fmtDen, &g_fmtTmp, P, digits, &X);
    }
    int kept = P;
    while (kept > 1 && digits[kept - 1] == '0') kept--;
    // The fixed/scientific switch uses the REQUESTED precision, not the kept
    // digit count: %.4g of 10000.0 is "1e+04" even though one digit survives.
    if (X < -4 || X >= sig) {
        renderExp(s, digits, kept, X, kept - 1, upper);
    } else {
        int F = kept - 1 - X;
        renderFixed(s, digits, kept, X, F < 0 ? 0 : F);
    }
}

static void vformatTo(Sink *s, const char *fmt, va_list ap) {
    for (const char *f = fmt; *f; ) {
        if (*f != '%') { sinkPutc(s, *f++); continue; }
        f++; // skip '%'
        if (*f == '%') { sinkPutc(s, '%'); f++; continue; }
        // flags (accepted, not applied — see file header)
        while (*f == '-' || *f == '+' || *f == ' ' || *f == '0' || *f == '#') f++;
        // width
        if (*f == '*') { (void)va_arg(ap, int); f++; }
        else while (*f >= '0' && *f <= '9') f++;
        // precision
        int prec = -1;
        if (*f == '.') {
            f++;
            prec = 0;
            if (*f == '*') { prec = va_arg(ap, int); f++; }
            else while (*f >= '0' && *f <= '9') { prec = prec * 10 + (*f - '0'); f++; }
        }
        // length modifier
        int lenMod = 0; // 0 = int, 1 = long, 2 = long long
        if (*f == 'l') { f++; if (*f == 'l') { lenMod = 2; f++; } else lenMod = 1; }
        else if (*f == 'h') { f++; if (*f == 'h') f++; }
        else if (*f == 'z' || *f == 'j' || *f == 't') { lenMod = 2; f++; }
        char conv = *f ? *f++ : 0;
        switch (conv) {
            case 'd': case 'i': {
                i64 v = lenMod == 2 ? va_arg(ap, long long)
                       : lenMod == 1 ? va_arg(ap, long)
                       : va_arg(ap, int);
                emitSigned(s, v);
                break;
            }
            case 'u': case 'x': case 'X': case 'o': {
                u64 v = lenMod == 2 ? va_arg(ap, unsigned long long)
                       : lenMod == 1 ? va_arg(ap, unsigned long)
                       : va_arg(ap, unsigned int);
                int base = conv == 'o' ? 8 : (conv == 'u' ? 10 : 16);
                emitUnsigned(s, v, base, conv == 'X');
                break;
            }
            case 'p': {
                void *v = va_arg(ap, void *);
                sinkPutc(s, '0'); sinkPutc(s, 'x');
                emitUnsigned(s, (u64)v, 16, 0);
                break;
            }
            case 'c': {
                int v = va_arg(ap, int);
                sinkPutc(s, (char)v);
                break;
            }
            case 's': {
                const char *str = va_arg(ap, const char *);
                // %.*s: precision is an exact byte count, not "stop at NUL" —
                // codegen relies on this to print length-counted Milo strings
                // (which may contain embedded NULs) byte-exactly.
                u64 n = prec >= 0 ? (u64)prec : milo_strlen(str);
                sinkWrite(s, str, n);
                break;
            }
            case 'f': case 'F': case 'g': case 'G': case 'e': case 'E':
                emitFloat(s, va_arg(ap, double), conv, prec);
                break;
            case 'a': case 'A':
                // Hex float. Nothing in codegen or std emits it; a loud stop beats
                // a plausible-looking wrong number.
                milo_fatal("milo: %a/%A (hex float) is unsupported on the wasm runtime\n", 70);
                break;
            default:
                milo_fatal("milo: unsupported printf format specifier on wasm runtime\n", 70);
                break;
        }
    }
}

int vsnprintf(char *buf, u64 cap, const char *fmt, va_list ap) {
    Sink s = { buf, cap, 0 };
    vformatTo(&s, fmt, ap);
    if (buf && cap > 0) buf[s.pos < cap ? s.pos : cap - 1] = 0;
    return (int)s.pos;
}

int snprintf(char *buf, u64 cap, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = vsnprintf(buf, cap, fmt, ap);
    va_end(ap);
    return r;
}

// Shared by dprintf/printf: two-pass (count, then fill) so a single write()
// carries the whole message — no interleaving risk from multiple small
// writes, and no arbitrary truncation the way a fixed stack buffer would risk.
static int vfdprintf(int fd, const char *fmt, va_list ap) {
    va_list apCount;
    va_copy(apCount, ap);
    Sink counter = { 0, 0, 0 };
    vformatTo(&counter, fmt, apCount);
    va_end(apCount);

    u64 need = counter.pos;
    char stackBuf[512];
    char *buf = stackBuf;
    int heapAllocated = 0;
    if (need + 1 > sizeof(stackBuf)) { buf = malloc(need + 1); heapAllocated = 1; }

    Sink s = { buf, need + 1, 0 };
    vformatTo(&s, fmt, ap);
    __milo_fd_write(fd, buf, need);
    if (heapAllocated) free(buf);
    return (int)need;
}

int dprintf(int fd, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = vfdprintf(fd, fmt, ap);
    va_end(ap);
    return r;
}

int printf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = vfdprintf(1, fmt, ap);
    va_end(ap);
    return r;
}

// ── stdio surface print()/eprint() need ─────────────────────────────────────

long long write(int fd, const void *buf, u64 n) { return __milo_fd_write(fd, buf, n); }

int putchar(int c) {
    char ch = (char)c;
    __milo_fd_write(1, &ch, 1);
    return c;
}

// fwrite always sees size==1 in codegen's emitStdoutWrite (print()'s scalar/
// struct/container path) — nmemb IS the byte count there. `stream` is always
// our own dummy `stdout` object (see below), so it's ignored rather than
// dispatched on: there is nothing else it could be.
u64 fwrite(const void *ptr, u64 size, u64 nmemb, void *stream) {
    (void)stream;
    u64 n = size * nmemb;
    __milo_fd_write(1, ptr, n);
    return nmemb;
}

int fflush(void *stream) { (void)stream; return 0; } // no userland buffering to flush — every write above is already unbuffered

// codegen's stdoutSymbol getter emits "stdout" (glibc-style) for every OS
// except darwin (which gets "__stdoutp"); target.os is "wasm" here, so this
// is the symbol that gets referenced, not __stdoutp. It just needs to be a
// non-null FILE*-shaped value — fwrite above never dereferences it.
static int g_stdoutDummy = 1;
void *stdout = &g_stdoutDummy;

// ── process termination ─────────────────────────────────────────────────

__attribute__((noreturn)) void exit(int code) { __milo_proc_exit(code); __builtin_unreachable(); }
__attribute__((noreturn)) void _exit(int code) { __milo_proc_exit(code); __builtin_unreachable(); }

__attribute__((noreturn)) void abort(void) {
    milo_fatal("milo: abort()\n", 134); // 134 = 128+SIGABRT, matching a native abort()'s shell-visible exit code
}

// ── randomness ─────────────────────────────────────────────────────────────

int getentropy(void *buf, u64 n) {
    __milo_get_random(buf, n);
    return 0;
}

// ── float parsing: correctly-rounded decimal -> binary ─────────────────────
//
// Round-to-nearest-even, decided by exact integer comparison, because anything
// less breaks codegen's print/re-parse round-trip search (file header). The
// value is built as an exact fraction, normalized so the quotient sits in
// [1,2), and the mantissa is then extracted one bit at a time by compare-and-
// subtract — binary long division, which needs no big/big divide.
//
// Separate scratch from the formatting side (see the note there).
static Big g_parseNum, g_parseDen;

// Truncation point for the decimal mantissa. The rounding boundaries for
// binary64 are (2m+1)*2^e values whose exact decimals never exceed 768
// significant digits, so a value agreeing with the input on the first 800
// digits can only land on the wrong side of a boundary if it sits exactly ON
// one — which `sticky` (set when a dropped digit was nonzero) then breaks.
#define MILO_MAX_PARSE_DIGITS 800

// Exact powers of ten up to 10^22, the largest that is representable in a
// double. Used only by the fast path below.
static const double MILO_P10F64[23] = {
    1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
    1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22
};

static int matchNoCase(const char *p, const char *lit) {
    for (; *lit; p++, lit++) {
        char c = *p;
        if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
        if (c != *lit) return 0;
    }
    return 1;
}

static int isHexDigit(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

// The shared parser. `mantBits`/`minNormalExp`/`maxExp` select the target
// format (53/-1022/1023 for binary64, 24/-126/127 for binary32) so strtof gets
// a genuinely single-rounded result instead of the double-rounding a
// (float)strtod(...) shortcut would introduce. The binary32 result is returned
// as a double, which holds it exactly.
static double parseFloatText(const char *s, char **end, int mantBits, int minNormalExp,
                             int maxExp, int maxDecExp, int minDecExp) {
    const char *p = s;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\v' || *p == '\f' || *p == '\r') p++;
    int neg = 0;
    if (*p == '+' || *p == '-') { neg = *p == '-'; p++; }

    if (matchNoCase(p, "inf")) {
        p += 3;
        if (matchNoCase(p, "inity")) p += 5;
        if (end) *end = (char *)p;
        return neg ? -__builtin_inf() : __builtin_inf();
    }
    if (matchNoCase(p, "nan")) {
        p += 3;
        if (end) *end = (char *)p;
        // "-nan" keeps the sign bit, matching libc — NaN's sign is not
        // meaningful arithmetically but it is observable through the bits.
        return neg ? -__builtin_nan("") : __builtin_nan("");
    }
    // C99 strtod also accepts hex floats. This one does not implement them, and
    // returning 0 with end at the 'x' (what a C89 strtod would do) is exactly
    // the plausible-but-wrong answer this runtime refuses to produce.
    if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X') &&
        (isHexDigit(p[2]) || (p[2] == '.' && isHexDigit(p[3]))))
        milo_fatal("milo: hex float literals are unsupported by the wasm runtime's strtod\n", 70);

    Big *num = &g_parseNum, *den = &g_parseDen;
    bigSetU64(num, 0);
    int ndig = 0;        // significant digits accumulated (leading zeros excluded)
    int dexp = 0;        // value == num * 10^dexp
    int sticky = 0;      // a nonzero digit fell off past MILO_MAX_PARSE_DIGITS
    int sawDigit = 0, seenDot = 0;
    unsigned int chunk = 0;
    int chunkLen = 0;
    for (;; p++) {
        char c = *p;
        if (c == '.' && !seenDot) { seenDot = 1; continue; }
        if (c < '0' || c > '9') break;
        sawDigit = 1;
        if (ndig == 0 && c == '0') {
            if (seenDot) dexp--;   // 0.00x — each zero pushes the mantissa down one place
        } else if (ndig < MILO_MAX_PARSE_DIGITS) {
            chunk = chunk * 10u + (unsigned int)(c - '0');
            if (++chunkLen == 9) { bigMulSmall(num, 1000000000u); bigAddSmall(num, chunk); chunk = 0; chunkLen = 0; }
            ndig++;
            if (seenDot) dexp--;
        } else {
            if (c != '0') sticky = 1;
            if (!seenDot) dexp++;  // dropped integer digit still scales the value
        }
    }
    if (chunkLen) { bigMulPow10(num, chunkLen); bigAddSmall(num, chunk); }

    if (sawDigit && (*p == 'e' || *p == 'E')) {
        const char *q = p + 1;
        int esign = 1;
        if (*q == '+' || *q == '-') { esign = *q == '-' ? -1 : 1; q++; }
        if (*q >= '0' && *q <= '9') {
            int ev = 0;
            while (*q >= '0' && *q <= '9') {
                if (ev < 1000000) ev = ev * 10 + (*q - '0'); // clamp: the range checks below reject it anyway
                q++;
            }
            dexp += esign * ev;
            p = q;
        }
        // No digits after 'e': the exponent is not part of the number, so `p`
        // stays before the 'e' (C's "longest valid prefix" rule).
    }
    if (!sawDigit) { if (end) *end = (char *)s; return 0.0; }
    if (end) *end = (char *)p;

    if (num->n == 0) return neg ? -0.0 : 0.0;
    // value is in [10^(ne-1), 10^ne), so these bounds are exact rejections, not
    // guesses — and they also cap how far bigMulPow10 below can scale.
    int ne = ndig + dexp;
    if (ne > maxDecExp) return neg ? -__builtin_inf() : __builtin_inf();
    if (ne < minDecExp) return neg ? -0.0 : 0.0;

    // Fast path (Clinger): an exactly-representable mantissa times an exactly-
    // representable power of ten is one correctly-rounded operation.
    if (mantBits == 53 && ndig <= 15 && dexp >= -22 && dexp <= 22) {
        double m = (double)bigToU64(num);
        double r = dexp >= 0 ? m * MILO_P10F64[dexp] : m / MILO_P10F64[-dexp];
        return neg ? -r : r;
    }

    bigSetU64(den, 1);
    if (dexp > 0) bigMulPow10(num, dexp); else if (dexp < 0) bigMulPow10(den, -dexp);

    // Normalize to num/den in [1,2) and record the binary exponent.
    int shift = bigBitLen(num) - bigBitLen(den);
    if (shift > 0) bigShl(den, shift); else if (shift < 0) bigShl(num, -shift);
    int exp = shift;
    if (bigCmp(num, den) < 0) { bigShl(num, 1); exp--; }

    // Subnormal results carry fewer than mantBits bits: the lowest bit is
    // pinned at 2^(minNormalExp-mantBits+1) no matter how small the value is.
    int prec = mantBits;
    if (exp < minNormalExp) prec = mantBits + (exp - minNormalExp);
    if (prec < 0) return neg ? -0.0 : 0.0;

    u64 q = 0;
    for (int i = 0; i < prec; i++) {
        q <<= 1;
        if (bigCmp(num, den) >= 0) { bigSub(num, den); q |= 1; }
        bigShl(num, 1);
    }
    // After the loop the leftover is num/(2*den) of an ulp, so it passes a half
    // exactly when num > den; num == den is a true tie unless a digit was dropped.
    int c = bigCmp(num, den);
    if (c > 0 || (c == 0 && (sticky || (q & 1)))) q++;

    if (prec == mantBits && q == (1ULL << mantBits)) { q >>= 1; exp++; } // 1.111..1 rounded up to 10.0
    if (prec == mantBits && exp > maxExp) return neg ? -__builtin_inf() : __builtin_inf();

    // Assemble the bit pattern. For prec < mantBits the value is q * 2^lowest,
    // which IS the subnormal encoding — and a q that carried all the way to
    // 2^(mantBits-1) lands on the smallest normal's pattern on its own.
    double r;
    if (mantBits == 53) {
        u64 bits = prec == 53
            ? ((u64)(exp + 1023) << 52) | (q & 0xFFFFFFFFFFFFFULL)
            : q;
        __builtin_memcpy(&r, &bits, 8);
    } else {
        unsigned int bits = prec == 24
            ? ((unsigned int)(exp + 127) << 23) | (unsigned int)(q & 0x7FFFFFu)
            : (unsigned int)q;
        float f;
        __builtin_memcpy(&f, &bits, 4);
        r = (double)f;
    }
    return neg ? -r : r;
}

double strtod(const char *s, char **end) {
    return parseFloatText(s, end, 53, -1022, 1023, 310, -400);
}

float strtof(const char *s, char **end) {
    return (float)parseFloatText(s, end, 24, -126, 127, 40, -55);
}

// std/string.milo's parseFloat() calls this directly.
double atof(const char *s) { return strtod(s, 0); }
