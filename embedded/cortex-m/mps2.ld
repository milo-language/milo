/* Linker script for QEMU's MPS2 AN-series boards (Cortex-M, e.g. mps2-an385).
 *
 * On a hosted system the linker knows the OS memory map; bare metal, we declare
 * it. The MPS2 maps code/ROM at 0x00000000 and SRAM at 0x20000000 — the same
 * base layout QEMU models for the whole AN3xx family, so one script serves M0/
 * M3/M4/M7 under emulation.
 *
 * The vector table must land at address 0 (the core fetches initial SP + reset
 * PC from there on power-up), so .isr_vector is placed first in FLASH.
 */
ENTRY(Reset_Handler)

MEMORY {
  FLASH (rx)  : ORIGIN = 0x00000000, LENGTH = 4M
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 4M
}

/* Initial stack pointer = top of RAM (stack grows down on ARM). */
_estack = ORIGIN(RAM) + LENGTH(RAM);

/* RAM reserved for the descending stack, kept clear of the growing heap.
 * Override by defining _stack_size on the link line (-Wl,--defsym,_stack_size=N). */
_stack_size = DEFINED(_stack_size) ? _stack_size : 0x4000;  /* 16 KB default */

SECTIONS {
  .isr_vector : {
    KEEP(*(.isr_vector))   /* KEEP: never garbage-collect the vector table */
  } > FLASH

  .text : {
    *(.text*)
    *(.rodata*)
  } > FLASH

  /* .data lives in RAM at runtime but its initializer image ships in FLASH;
   * startup copies FLASH->RAM. _sidata is that flash load address. */
  _sidata = LOADADDR(.data);
  .data : {
    _sdata = .;
    *(.data*)
    _edata = .;
  } > RAM AT > FLASH

  .bss : {
    _sbss = .;
    *(.bss*)
    *(COMMON)
    _ebss = .;
  } > RAM

  /* Heap: all RAM between the end of .bss and the reserved stack at the top.
   * The bump allocator in startup.c hands out [_sheap, _eheap). This adapts to
   * whatever RAM the board's MEMORY block declares — no size baked into C. */
  _sheap = _ebss;
  _eheap = _estack - _stack_size;
}
