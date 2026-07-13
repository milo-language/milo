import { NES, Controller } from "/Users/csmith/git/milo/node_modules/jsnes/src/index.js";
import fs from "fs";

const rom = fs.readFileSync("roms/games/1200-in-1.nes");
const romStr = Array.from(rom, b => String.fromCharCode(b)).join("");

let lastFB = null;
const nes = new NES({ onFrame: fb => { lastFB = fb.slice(); } });
nes.loadROM(romStr);

function run(n) { for (let i=0;i<n;i++) nes.frame(); }
function hash(fb){ let h=0x1234; if(!fb) return 0; for(let i=0;i<fb.length;i+=97){ h=(h*31 + fb[i])>>>0; } return h; }
function tap(btn, hold, rel){ for(let i=0;i<hold;i++){ nes.buttonDown(1,btn); nes.frame(); } nes.buttonUp(1,btn); for(let i=0;i<rel;i++) nes.frame(); }

run(60);
console.log("menu pc=", nes.cpu.REG_PC.toString(16), "hash=", hash(lastFB).toString(16));
tap(Controller.BUTTON_START, 6, 90);   // launch
console.log("launched pc=", nes.cpu.REG_PC.toString(16), "hash=", hash(lastFB).toString(16));
const titleHash = hash(lastFB);
tap(Controller.BUTTON_START, 10, 120); // in-game start
console.log("afterStart pc=", nes.cpu.REG_PC.toString(16), "hash=", hash(lastFB).toString(16));
console.log("advanced past title?", hash(lastFB) !== titleHash);
