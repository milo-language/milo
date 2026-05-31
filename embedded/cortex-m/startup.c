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

// SYS_EXIT (0x18): report application exit. The "angel" reason code
// ADP_Stopped_ApplicationExit (0x20026) signals a normal exit; on newer
// semihosting the second word carries the exit status so the host can surface
// the program's return value.
__attribute__((noreturn))
void exit(int code) {
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

// Bump allocator over a static arena. No reclamation — free() is a no-op. This
// is a link-time fallback, NOT a WCET-safe heap (see file header).
static unsigned char g_arena[64 * 1024];
static size_t g_arena_off = 0;
void *malloc(size_t n) {
    n = (n + 7u) & ~(size_t)7u;  // 8-byte align
    if (g_arena_off + n > sizeof(g_arena)) return 0;  // out of arena
    void *p = &g_arena[g_arena_off];
    g_arena_off += n;
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
