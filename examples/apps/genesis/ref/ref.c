// Golden Axe / Genesis reference harness: MAME's Musashi 68000 core + a bus that
// mirrors examples/apps/genesis/m68k.milo EXACTLY (VDP status/timing model, device
// dispatch, DMA). Purpose: diff our hand-written Milo 68k against a proven core to
// find where GA's title-palette/SAT build diverges. Dumps CRAM + the logo SAT attr.
//
//   build: ./build.sh   ->   /tmp/ga-ref
//   run:   /tmp/ga-ref ../../../../roms/games/goldenaxe.md [maxSteps]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "musashi/m68k.h"

static unsigned char ROM[0x400000];
static long romLen = 0;
static unsigned char RAM[0x10000];   // work RAM $FF0000 (64K, mirrored)
static unsigned char VRAM[0x10000];  // 64K VDP VRAM
static unsigned char Z80[0x2000];    // Z80 8K RAM (68k side writes)
static int CRAM[64];
static int VSRAM[40];
static int VREG[24];
static int vdpAddr = 0, vdpCode = 0, vdpFirst = 0, vdpPending = 0;
static int vdpLine = 0, dmaFill = 0;

// ---- low-level 68k-address reads used by DMA (ROM + RAM only) ----
static unsigned int rd8(unsigned int a) {
    a &= 0xFFFFFF;
    if (a < 0x400000) return a < romLen ? ROM[a] : 0;
    if (a >= 0xFF0000) return RAM[a & 0xFFFF];
    return 0;
}

static int vdpStatus(void) { return 0x3400 | (vdpLine >= 224 ? 0x0008 : 0); }

static void vdpDma(void); // fwd

static void vdpDataWrite(int val) {
    if (dmaFill) {
        dmaFill = 0;
        unsigned char fb = (val >> 8) & 0xFF;
        int len = (VREG[20] << 8) | VREG[19]; if (len == 0) len = 0x10000;
        int da = vdpAddr;
        for (int i = 0; i < len; i++) { VRAM[da & 0xFFFF] = fb; da = (da + VREG[15]) & 0x1FFFF; }
        vdpAddr = da & 0x1FFFF; return;
    }
    int target = vdpCode & 0xF, a = vdpAddr;
    if (target == 1) {
        int base = a & 0xFFFE;
        unsigned char hi = (val >> 8) & 0xFF, lo = val & 0xFF;
        if ((a & 1) == 0) { VRAM[base] = hi; VRAM[base + 1] = lo; }
        else { VRAM[base] = lo; VRAM[base + 1] = hi; }
    } else if (target == 3) {
        CRAM[(a >> 1) & 0x3F] = val & 0x0EEE;
    } else if (target == 5) {
        VSRAM[(a >> 1) % 40] = val & 0x7FF;
    }
    vdpAddr = (a + VREG[15]) & 0x1FFFF;
}

static void vdpDmaCopy(void) {
    int src = (VREG[22] << 8) | VREG[21];
    int len = (VREG[20] << 8) | VREG[19]; if (len == 0) len = 0x10000;
    int dst = vdpAddr;
    for (int i = 0; i < len; i++) {
        VRAM[dst & 0xFFFF] = VRAM[src & 0xFFFF];
        src = (src + 1) & 0xFFFF; dst = (dst + VREG[15]) & 0xFFFF;
    }
    vdpAddr = dst & 0x1FFFF;
}

static void vdpDma(void) {
    int mode = (VREG[23] >> 6) & 0x3;
    if (mode == 2) { dmaFill = 1; return; }
    if (mode == 3) { vdpDmaCopy(); return; }
    int src = ((VREG[23] & 0x7F) << 17) | (VREG[22] << 9) | (VREG[21] << 1);
    int len = (VREG[20] << 8) | VREG[19]; if (len == 0) len = 0x10000;
    for (int i = 0; i < len; i++) {
        int w = (rd8(src) << 8) | rd8((src + 1) & 0xFFFFFF);
        vdpDataWrite(w);
        src = (src + 2) & 0xFFFFFF;
    }
}

static void vdpControlWrite(int val) {
    if (vdpPending) {
        vdpPending = 0;
        vdpAddr = (vdpFirst & 0x3FFF) | ((val & 0x3) << 14);
        vdpCode = ((vdpFirst >> 14) & 0x3) | ((val >> 2) & 0x3C);
        if (vdpCode & 0x20) vdpDma();
        return;
    }
    if ((val & 0xC000) == 0x8000) {
        int reg = (val >> 8) & 0x1F;
        if (reg < 24) VREG[reg] = val & 0xFF;
        return;
    }
    vdpFirst = val; vdpPending = 1;
}

// ---- Musashi memory callbacks (big-endian bus) ----
static unsigned int devRead16(unsigned int a) {
    if (a == 0xC00004 || a == 0xC00006) return vdpStatus();
    if (a == 0xC00008 || a == 0xC0000A) return (vdpLine & 0xFF) << 8;
    if (a == 0xC00000 || a == 0xC00002) return 0;
    if (a == 0xA11100) return 0;
    if (a == 0xA10000) return 0x00A0;
    if (a >= 0xA10002 && a <= 0xA1000F) return 0xFFFF;
    return 0;
}
static unsigned int devRead8(unsigned int a) {
    if (a >= 0xA00000 && a <= 0xA0FFFF) { int za = a & 0xFFFF; return za < 0x2000 ? Z80[za] : 0; }
    if (a == 0xA10001) return 0xA0;
    if (a == 0xA10003) return 0x7F; // controller 1: idle
    if (a == 0xA10005) return 0x7F;
    { unsigned int w = devRead16(a & ~1u); return (a & 1) ? (w & 0xFF) : ((w >> 8) & 0xFF); }
}
static int isDev(unsigned int a) { return a >= 0xA00000 && a < 0xC00010; }

unsigned int m68k_read_memory_8(unsigned int a) {
    a &= 0xFFFFFF;
    if (a < 0x400000) return a < romLen ? ROM[a] : 0;
    if (a >= 0xFF0000) return RAM[a & 0xFFFF];
    if (isDev(a)) return devRead8(a);
    return 0;
}
unsigned int m68k_read_memory_16(unsigned int a) {
    a &= 0xFFFFFF;
    if (a < 0x400000) { if (a + 1 < romLen) return (ROM[a] << 8) | ROM[a + 1]; return 0; }
    if (a >= 0xFF0000) { int o = a & 0xFFFF; return (RAM[o] << 8) | RAM[(o + 1) & 0xFFFF]; }
    if (isDev(a)) return devRead16(a);
    return 0;
}
unsigned int m68k_read_memory_32(unsigned int a) {
    return (m68k_read_memory_16(a) << 16) | m68k_read_memory_16(a + 2);
}
unsigned int m68k_read_disassembler_16(unsigned int a) { return m68k_read_memory_16(a); }
unsigned int m68k_read_disassembler_32(unsigned int a) { return m68k_read_memory_32(a); }

static void devWrite16(unsigned int a, unsigned int val) {
    if (a >= 0xA00000 && a <= 0xA0FFFF) {
        int za = a & 0xFFFF;
        if (za < 0x2000) { Z80[za] = (val >> 8) & 0xFF; Z80[(za + 1) & 0x1FFF] = val & 0xFF; }
        return;
    }
    if (a == 0xC00000 || a == 0xC00002) { vdpDataWrite(val); return; }
    if (a == 0xC00004 || a == 0xC00006) { vdpControlWrite(val); return; }
}
void m68k_write_memory_8(unsigned int a, unsigned int val) {
    a &= 0xFFFFFF; val &= 0xFF;
    if (a < 0x400000) return; // ROM
    if (a >= 0xFF0000) { RAM[a & 0xFFFF] = val; return; }
    if (a >= 0xA00000 && a <= 0xA0FFFF) { int za = a & 0xFFFF; if (za < 0x2000) Z80[za] = val; return; }
}
void m68k_write_memory_16(unsigned int a, unsigned int val) {
    a &= 0xFFFFFF; val &= 0xFFFF;
    if (a < 0x400000) return;
    if (a >= 0xFF0000) { int o = a & 0xFFFF; RAM[o] = (val >> 8) & 0xFF; RAM[(o + 1) & 0xFFFF] = val & 0xFF; return; }
    if (isDev(a)) { devWrite16(a, val); return; }
}
void m68k_write_memory_32(unsigned int a, unsigned int val) {
    m68k_write_memory_16(a, (val >> 16) & 0xFFFF);
    m68k_write_memory_16(a + 2, val & 0xFFFF);
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: ga-ref <rom> [maxSteps]\n"); return 1; }
    long maxSteps = argc >= 3 ? atol(argv[2]) : 16000000;
    FILE *f = fopen(argv[1], "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", argv[1]); return 1; }
    romLen = fread(ROM, 1, sizeof(ROM), f); fclose(f);
    printf("ROM %ld bytes\n", romLen);

    m68k_init();
    m68k_set_cpu_type(M68K_CPU_TYPE_68000);
    m68k_pulse_reset();

    int lineClock = 0, wasV = 0, frames = 0;
    for (long i = 0; i < maxSteps; i++) {
        m68k_execute(1);
        if (++lineClock >= 130) {
            lineClock = 0;
            if (++vdpLine >= 262) { vdpLine = 0; frames++; }
        }
        int inV = vdpLine >= 224;
        if (inV && !wasV) { if (VREG[1] & 0x20) m68k_set_irq(6); }
        if (!inV && wasV) m68k_set_irq(0);
        wasV = inV;
    }

    unsigned int pc = m68k_get_reg(NULL, M68K_REG_PC);
    printf("frames=%d final PC=%06X\n", frames, pc);
    for (int l = 0; l < 4; l++) {
        printf("CRAM line%d:", l);
        for (int c = 0; c < 16; c++) printf(" %04x", CRAM[l * 16 + c]);
        printf("\n");
    }
    int sat = (VREG[5] & 0x7F) << 9;
    printf("SAT base=%04x\n", sat);
    for (int s = 0; s < 8; s++) {
        int o = sat + s * 8;
        int attr = (VRAM[(o + 4) & 0xFFFF] << 8) | VRAM[(o + 5) & 0xFFFF];
        int tile = attr & 0x7FF, pal = (attr >> 13) & 3, pri = (attr >> 15) & 1;
        printf("  spr%d attr=%04x tile=%04x pal=%d pri=%d\n", s, attr, tile, pal, pri);
    }
    return 0;
}
