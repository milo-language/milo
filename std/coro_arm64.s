// Custom arm64 coroutine context switching
// Replaces macOS's buggy/deprecated ucontext implementation
//
// Context buffer layout (176 bytes):
//   0-72:   x19-x28 (10 callee-saved GPRs, 80 bytes)
//  80:      x29 (fp)
//  88:      x30 (lr / resume address)
//  96:      sp
// 104-160:  d8-d15 (8 callee-saved FP/SIMD regs, 64 bytes)
// 168:      unused/padding

.global _milo_swapcontext
.global _milo_makecontext

.align 4
_milo_swapcontext:
    // x0 = save buffer, x1 = load buffer
    // Save callee-saved registers into save buffer
    stp x19, x20, [x0, #0]
    stp x21, x22, [x0, #16]
    stp x23, x24, [x0, #32]
    stp x25, x26, [x0, #48]
    stp x27, x28, [x0, #64]
    stp x29, x30, [x0, #80]
    mov x9, sp
    str x9, [x0, #96]
    stp d8, d9, [x0, #104]
    stp d10, d11, [x0, #120]
    stp d12, d13, [x0, #136]
    stp d14, d15, [x0, #152]

    // Load callee-saved registers from target buffer
    ldp x19, x20, [x1, #0]
    ldp x21, x22, [x1, #16]
    ldp x23, x24, [x1, #32]
    ldp x25, x26, [x1, #48]
    ldp x27, x28, [x1, #64]
    ldp x29, x30, [x1, #80]
    ldr x9, [x1, #96]
    mov sp, x9
    ldp d8, d9, [x1, #104]
    ldp d10, d11, [x1, #120]
    ldp d12, d13, [x1, #136]
    ldp d14, d15, [x1, #152]

    ret

// milo_makecontext(ctx, func, stack_base, stack_size, arg0, arg1, arg2, arg3)
// x0 = context buffer (176 bytes)
// x1 = function pointer
// x2 = stack base (bottom of usable region)
// x3 = stack size
// x4 = arg0 (i32), x5 = arg1 (i32), x6 = arg2 (i32), x7 = arg3 (i32)
//
// Sets up context so swapcontext will start executing func(arg0, arg1, arg2, arg3)
// on the given stack.
.align 4
_milo_makecontext:
    // Compute stack top, 16-byte aligned
    add x9, x2, x3         // x9 = stack_base + stack_size (top)
    and x9, x9, #~0xF      // align down to 16 bytes

    // Reserve space for trampoline args on new stack
    sub x9, x9, #48        // 6 slots: fn, arg0..arg3, padding

    // Store function and args on the new stack for the trampoline
    str x1, [x9, #0]       // fn pointer
    str w4, [x9, #8]       // arg0 (i32)
    str w5, [x9, #12]      // arg1 (i32)
    str w6, [x9, #16]      // arg2 (i32)
    str w7, [x9, #20]      // arg3 (i32)

    // Set up context buffer
    stp xzr, xzr, [x0, #0]   // x19, x20 = 0
    stp xzr, xzr, [x0, #16]  // x21, x22 = 0
    stp xzr, xzr, [x0, #32]  // x23, x24 = 0
    stp xzr, xzr, [x0, #48]  // x25, x26 = 0
    stp xzr, xzr, [x0, #64]  // x27, x28 = 0
    str xzr, [x0, #80]        // fp = 0

    // lr = trampoline address
    adrp x10, _milo_coro_trampoline@PAGE
    add x10, x10, _milo_coro_trampoline@PAGEOFF
    str x10, [x0, #88]        // lr = trampoline

    str x9, [x0, #96]         // sp = adjusted stack top

    // Zero FP regs
    stp xzr, xzr, [x0, #104]
    stp xzr, xzr, [x0, #120]
    stp xzr, xzr, [x0, #136]
    stp xzr, xzr, [x0, #152]

    ret

// Trampoline: reads fn + args from stack, calls fn
.align 4
_milo_coro_trampoline:
    // sp points to our saved data
    ldr x9, [sp, #0]       // fn pointer
    ldr w0, [sp, #8]       // arg0
    ldr w1, [sp, #12]      // arg1
    ldr w2, [sp, #16]      // arg2
    ldr w3, [sp, #20]      // arg3
    add sp, sp, #48         // pop saved data
    blr x9                  // call fn(arg0, arg1, arg2, arg3)
    brk #0                  // should never return
