// Minimal bare-metal startup + ARM semihosting for Milo Cortex-M programs.
//
// Replaces the role libc's crt0 plays on a hosted system: there is no OS to
// load us, set up a stack, or zero our globals — this code does it by hand,
// then calls the Milo program's main() and reports its exit code to the host
// debugger/emulator via semihosting.
//
// Compiled freestanding (-ffreestanding -nostdlib) and linked at the reset
// vector by the accompanying linker script.

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
static void sys_exit(int code) {
    unsigned args[2] = { 0x20026u, (unsigned)code };
    semihost(0x18, args);
    for (;;) {}  // unreachable; satisfies noreturn if host declines to exit
}

// Entry at the reset vector. Sets up C runtime state, then runs the program.
__attribute__((noreturn))
void Reset_Handler(void) {
    // Copy initialized globals (.data) from their flash image into RAM.
    unsigned *src = &_sidata, *dst = &_sdata;
    while (dst < &_edata) *dst++ = *src++;
    // Zero uninitialized globals (.bss).
    for (dst = &_sbss; dst < &_ebss; dst++) *dst = 0;

    int rc = main();
    sys_exit(rc);
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
