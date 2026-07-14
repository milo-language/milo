#!/usr/bin/env bash
# Pair a Bluetooth game controller on the Raspberry Pi so it auto-reconnects on
# every boot. Run once per controller. Put the pad in pairing mode first (varies
# by brand: 8BitDo = hold Start+Select ~3s; Xbox = hold the pair button; DualSense
# = hold Share+PS). Then run this and follow the prompt.
#
# This drives bluetoothctl non-interactively: scan, then pair/trust/connect the
# MAC you pick. `trust` is the key step — it lets the Pi reconnect the pad after
# a reboot without re-pairing.
set -euo pipefail

echo "Putting the controller in pairing mode now? (hold its pair combo)"
echo "Scanning for 15s..."
bluetoothctl --timeout 15 scan on || true

echo
echo "Discovered devices:"
bluetoothctl devices

echo
read -rp "Paste the controller's MAC (XX:XX:XX:XX:XX:XX): " mac
if [ -z "${mac:-}" ]; then
    echo "no MAC given, aborting" >&2
    exit 1
fi

bluetoothctl pair "$mac"
bluetoothctl trust "$mac"     # persist across reboots
bluetoothctl connect "$mac"

echo
echo "Paired + trusted $mac. It should reconnect automatically on boot."
echo "SDL2's built-in mapping DB covers most pads; if buttons are off, set"
echo "SDL_GAMECONTROLLERCONFIG or drop a gamecontrollerdb.txt next to the binaries."
