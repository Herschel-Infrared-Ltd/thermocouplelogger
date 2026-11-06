#!/usr/bin/env python3
"""Turn the backlight off after a period without touch; the next touch wakes it.

While the screen is off the touchscreen is grabbed, so the waking touch never
reaches the compositor or the page.
"""

import fcntl
import glob
import os
import select
import signal
import struct
import sys
import time

IDLE_SECONDS = float(os.environ.get("SCREEN_SLEEP_SECONDS", "120"))
EVENT = struct.Struct("llHHi")
EV_KEY = 0x01
BTN_TOUCH = 0x14A
EVIOCGRAB = 0x40044590


def find_touchscreen():
    """First input device that reports BTN_TOUCH and absolute axes."""
    long_bits = struct.calcsize("l") * 8
    for block in open("/proc/bus/input/devices").read().split("\n\n"):
        handlers, keys, has_abs = [], [], False
        for line in block.splitlines():
            if line.startswith("H: Handlers="):
                handlers = line.split("=", 1)[1].split()
            elif line.startswith("B: KEY="):
                keys = [int(word, 16) for word in line.split("=", 1)[1].split()]
            elif line.startswith("B: ABS="):
                has_abs = True
        word, bit = divmod(BTN_TOUCH, long_bits)
        if has_abs and len(keys) > word and keys[-1 - word] >> bit & 1:
            for handler in handlers:
                if handler.startswith("event"):
                    return f"/dev/input/{handler}"
    sys.exit("no touchscreen found")


def find_backlight():
    paths = sorted(glob.glob("/sys/class/backlight/*"))
    if not paths:
        sys.exit("no backlight found")
    return paths[0]


def main():
    device = os.environ.get("SCREEN_SLEEP_INPUT") or find_touchscreen()
    backlight = os.environ.get("SCREEN_SLEEP_BACKLIGHT") or find_backlight()
    brightness_path = f"{backlight}/brightness"
    max_brightness = int(open(f"{backlight}/max_brightness").read())

    def set_brightness(value):
        with open(brightness_path, "w") as f:
            f.write(str(value))

    fd = os.open(device, os.O_RDONLY)
    awake_brightness = int(open(brightness_path).read()) or max_brightness
    set_brightness(awake_brightness)
    asleep = False
    grabbed = False
    last_touch = time.monotonic()
    print(f"screen-sleep: {device}, {backlight}, {IDLE_SECONDS:.0f} s", flush=True)

    def restore(*_):
        if asleep:
            set_brightness(awake_brightness)
        sys.exit(0)

    signal.signal(signal.SIGTERM, restore)
    signal.signal(signal.SIGINT, restore)

    while True:
        timeout = None if asleep else max(0, last_touch + IDLE_SECONDS - time.monotonic())
        ready, _, _ = select.select([fd], [], [], timeout)
        if not ready:
            awake_brightness = int(open(brightness_path).read()) or max_brightness
            fcntl.ioctl(fd, EVIOCGRAB, 1)
            grabbed = True
            set_brightness(0)
            asleep = True
            continue

        data = os.read(fd, EVENT.size * 64)
        last_touch = time.monotonic()
        if asleep:
            set_brightness(awake_brightness)
            asleep = False
        if grabbed:
            released = any(
                ev_type == EV_KEY and code == BTN_TOUCH and value == 0
                for _, _, ev_type, code, value in EVENT.iter_unpack(data)
            )
            if released:
                fcntl.ioctl(fd, EVIOCGRAB, 0)
                grabbed = False


if __name__ == "__main__":
    main()
