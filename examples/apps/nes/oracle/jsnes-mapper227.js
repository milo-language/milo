import Mapper0 from "./mapper0.js";

// iNES Mapper 227 (multicart, e.g. "1200-in-1"). The write *address* is the
// register. A2-A6 = 16 KiB bank, A7 = L mode, A1 = mirroring, A0 = S (PRG A14
// source): L=1,S=0 -> 32 KiB contiguous; L=1,S=1 -> 16 KiB mirror; L=0 -> UxROM.
class Mapper227 extends Mapper0 {
  static mapperName = "Multicart-227";

  write(address, value) {
    if (address < 0x8000) {
      super.write(address, value);
      return;
    }
    const a = address;
    const bank = (a >> 2) & 0x1f;
    const l = (a >> 7) & 1;
    const s = a & 1;
    const mirror = (a >> 1) & 1;
    if (l === 1) {
      if (s === 0) {
        this.loadRomBank(bank & 0x1e, 0x8000);
        this.loadRomBank((bank & 0x1e) | 1, 0xc000);
      } else {
        this.loadRomBank(bank, 0x8000);
        this.loadRomBank(bank, 0xc000);
      }
    } else {
      this.loadRomBank(bank, 0x8000);
      this.loadRomBank((bank & 0x18) | (s ? 7 : 0), 0xc000);
    }
    this.nes.ppu.setMirroring(
      mirror === 0
        ? this.nes.rom.VERTICAL_MIRRORING
        : this.nes.rom.HORIZONTAL_MIRRORING
    );
  }

  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("227: Invalid ROM! Unable to load.");
    }
    this.loadRomBank(0, 0x8000);
    this.loadRomBank(0, 0xc000);
    this.loadCHRROM();
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }
}

export default Mapper227;
