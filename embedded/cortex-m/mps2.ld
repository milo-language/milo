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
}
