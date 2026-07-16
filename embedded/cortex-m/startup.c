// Minimal bare-metal startup + ARM semihosting + freestanding libc shim for
// Milo Cortex-M programs.
//
// Replaces the role libc's crt0 plays on a hosted system: there is no OS to
// load us, set up a stack, or zero our globals — this code does it by hand,
// then calls the Milo program's main() and reports its exit code to the host
// debugger/emulator via semihosting.
//
// It also provides the handful of libc symbols Milo's codegen emits (memcpy,
// memset, malloc/free, printf, exit). These exist for LINK COMPLETENESS — the
// std runtime defines string helpers that reference them even when unused. A
// WCET-grade program is compiled under `--safety` (noDynamicAllocation), so it
// never actually calls malloc/printf at runtime; the bump allocator below is a
// fallback for non-safety builds, not a real heap.
//
// Compiled freestanding (-ffreestanding -nostdlib) and linked at the reset
// vector by the accompanying linker script.

typedef unsigned long size_t;

extern int main(void);

// Symbols defined by the linker script (see *.ld). Addresses, not values —
// take their address to get the section boundaries.
extern unsigned _sidata;  // .data init image in flash
extern unsigned _sdata;   // .data start in RAM
extern unsigned _edata;   // .data end in RAM
extern unsigned _sbss;    // .bss start in RAM
extern unsigned _ebss;    // .bss end in RAM
extern unsigned _estack;  // top of stack (initial SP)

// ARM semihosting: trap to the host with operation in r0, args block in r1.
// QEMU (-semihosting) and most debug probes intercept the bkpt 0xAB.
static inline long semihost(int op, void *arg) {
    register long r0 asm("r0") = op;
    register void *r1 asm("r1") = arg;
    asm volatile("bkpt 0xAB" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

// SYS_WRITE0 (0x04): print a NUL-terminated string to the host console.
static void semihost_write0(const char *s) {
    semihost(0x04, (void *)s);
}

// Print the program's exit code as a line the host can observe and assert on.
// QEMU's legacy SYS_EXIT collapses every status to process-exit 1, so the
// numeric result can't be read from the process exit code — we emit it on the
// semihosting console instead, exactly as you'd observe on real hardware via a
// debug UART. Format: "exit=<n>\n".
static void print_exit_code(int code) {
    char buf[16];
    int i = 0;
    unsigned v = (code < 0) ? (unsigned)(-code) : (unsigned)code;
    char digits[10];
    int n = 0;
    do { digits[n++] = (char)('0' + (v % 10u)); v /= 10u; } while (v);
    buf[i++] = 'e'; buf[i++] = 'x'; buf[i++] = 'i'; buf[i++] = 't'; buf[i++] = '=';
    if (code < 0) buf[i++] = '-';
    while (n) buf[i++] = digits[--n];
    buf[i++] = '\n'; buf[i] = '\0';
    semihost_write0(buf);
}

// SYS_EXIT (0x18): report application exit. The "angel" reason code
// ADP_Stopped_ApplicationExit (0x20026) signals a normal exit; the second word
// carries the status. We also print "exit=<n>" first (see print_exit_code).
__attribute__((noreturn))
void exit(int code) {
    print_exit_code(code);
    unsigned args[2] = { 0x20026u, (unsigned)code };
    semihost(0x18, args);
    for (;;) {}  // unreachable; satisfies noreturn if host declines to exit
}

// ── freestanding libc shim ──
// External linkage so lld resolves the references emitted by Milo's IR.

void *memcpy(void *dst, const void *src, size_t n) {
    unsigned char *d = dst; const unsigned char *s = src;
    while (n--) *d++ = *s++;
    return dst;
}

void *memset(void *dst, int c, size_t n) {
    unsigned char *d = dst;
    while (n--) *d++ = (unsigned char)c;
    return dst;
}

// std/string's substring search calls these (memchr-skip + memcmp-verify).
void *memchr(const void *s, int c, size_t n) {
    const unsigned char *p = s;
    while (n--) {
        if (*p == (unsigned char)c) return (void *)p;
        p++;
    }
    return 0;
}

int memcmp(const void *a, const void *b, size_t n) {
    const unsigned char *x = a, *y = b;
    while (n--) {
        if (*x != *y) return *x - *y;
        x++; y++;
    }
    return 0;
}

// Bump allocator over the RAM the linker script leaves between .bss and the
// reserved stack ([_sheap, _eheap) — see *.ld). No reclamation: free() is a
// no-op. This is a link-time fallback, NOT a WCET-safe heap (see file header).
//
// The size is NOT baked in here — it adapts to whatever RAM the board's MEMORY
// block declares. Cap it explicitly for a bounded heap by defining
// MILO_HEAP_SIZE (bytes) on the link line: clang ... -DMILO_HEAP_SIZE=N.
extern unsigned char _sheap;   // heap start (= end of .bss), from linker script
extern unsigned char _eheap;   // heap end (below the reserved stack), from linker

static unsigned char *g_heap_ptr = 0;   // bump cursor; lazily set on first call
static unsigned char *g_heap_end = 0;

// Out of heap. Unrecoverable here — the bump allocator can't reclaim and Milo's
// codegen doesn't check malloc's result (it dereferences straight away). So make
// exhaustion OBSERVABLE (a semihosting message + ENOMEM exit) instead of letting
// the null propagate into a silent null-deref HardFault-reboot.
__attribute__((noreturn))
static void oom(void) {
    semihost_write0("milo: out of memory (bare-metal heap exhausted)\n");
    exit(12);  // ENOMEM
}

void *malloc(size_t n) {
    if (g_heap_ptr == 0) {              // first call: resolve the linker region
        g_heap_ptr = &_sheap;
        g_heap_end = &_eheap;
#ifdef MILO_HEAP_SIZE
        // Bound the heap to MILO_HEAP_SIZE if that's smaller than the RAM span.
        if ((size_t)(g_heap_end - g_heap_ptr) > (size_t)(MILO_HEAP_SIZE))
            g_heap_end = g_heap_ptr + (size_t)(MILO_HEAP_SIZE);
#endif
    }
    n = (n + 7u) & ~(size_t)7u;         // 8-byte align
    // Overflow-safe exhaustion check: compare remaining space, never ptr + n
    // (which could wrap past the top of the address space).
    if (n > (size_t)(g_heap_end - g_heap_ptr)) oom();
    void *p = g_heap_ptr;
    g_heap_ptr += n;
    return p;
}

void free(void *p) { (void)p; }

// printf stub: compute-only / WCET programs don't print. Returns 0 so callers
// that check the result see "0 chars written". Real UART/semihosting output is
// a later milestone.
int printf(const char *fmt, ...) { (void)fmt; return 0; }

// Entry at the reset vector. Sets up C runtime state, then runs the program.
__attribute__((noreturn))
void Reset_Handler(void) {
    // Copy initialized globals (.data) from their flash image into RAM.
    unsigned *src = &_sidata, *dst = &_sdata;
    while (dst < &_edata) *dst++ = *src++;
    // Zero uninitialized globals (.bss).
    for (dst = &_sbss; dst < &_ebss; dst++) *dst = 0;

    int rc = main();
    exit(rc);
}

// Cortex-M vector table. Word 0 is the initial stack pointer, word 1 is the
// reset handler. The hardware reads these two from address 0x0 on power-up.
// We only populate the entries a compute-only program needs; faults default
// to the reset handler (a crash will simply restart).
__attribute__((section(".isr_vector"), used))
void (* const g_vectors[])(void) = {
    (void (*)(void))&_estack,  // 0x00: initial SP
    Reset_Handler,             // 0x04: reset
    Reset_Handler,             // 0x08: NMI
    Reset_Handler,             // 0x0C: HardFault
};
