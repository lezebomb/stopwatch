"""Bounded, passive UART capture. Raw device logs must stay under .data/."""
import argparse
import pathlib
import re
import time
import serial
from esptool.reset import HardReset

p = argparse.ArgumentParser()
p.add_argument('--port', required=True)
p.add_argument('--seconds', type=int, default=30)
p.add_argument('--log', required=True)
p.add_argument('--reset', action='store_true')
a = p.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
target = pathlib.Path(a.log).resolve()
if not target.is_relative_to(root / '.data'):
    p.error('Raw serial logs must be in the ignored .data directory')
target.parent.mkdir(parents=True, exist_ok=True)
port = serial.Serial()
port.port, port.baudrate, port.timeout = a.port, 115200, 0.2
port.dtr, port.rts = False, False
port.open()
lines = []
try:
    if a.reset:
        HardReset(port, uses_usb=True).reset()
    end = time.monotonic() + a.seconds
    pending = b''
    with target.open('wb') as out:
        while time.monotonic() < end:
            chunk = port.read(4096)
            if not chunk:
                continue
            out.write(chunk)
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                lines.append(line.decode('utf-8', 'replace').strip())
except serial.SerialException as e:
    print('Serial disconnected:', type(e).__name__)
finally:
    port.close()
pattern = re.compile(r'Guru Meditation|panic|assert failed|Backtrace:|Brownout|watchdog|abort\(\)|esp_psram:|PSRAM test|companion:|sw_update:|voice pipeline|CO5300|CST820: Chip ID|ES8311|M5IOE1 initialized|Project name:|App version:|ESP-IDF:|heap_init:')
selected = [s for s in lines if pattern.search(s)]
for line in selected[-32:]:
    line = re.sub(r'(?:mgst_|eyJ|ghp_|github_pat_)[A-Za-z0-9_.-]+', '[redacted]', line)
    print(line)
print(f'Captured {len(lines)} lines; raw log retained locally: {target.relative_to(root)}')
