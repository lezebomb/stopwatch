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
p.add_argument('--memory-only', action='store_true')
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
memory_line = re.compile(
    r'I \(\d+\) sw_mem: @mem (?:boot|vm|relay|photo|miao|updater|probe)\.[a-z-]+(?: -?\d+){11}'
    r'|I \(\d+\) sw_mem: @mem-target [a-zA-Z0-9.-]+'
    r'|I \(\d+\) sw_update: (?:boot-memory [a-z-]+ internal=\d+ largest=\d+ dma=\d+ dma_largest=\d+ psram=\d+'
    r'|Startup stack headroom: \d+ bytes|health-failed:|idle:)'
    r'|voice pipeline unavailable|AUDIO INIT FAILED'
    r'|Relay task allocation failed; largest internal block: \d+ bytes'
    r'|link\.register acked; tunnel may open'
    r'|WebSocket upgraded to /v1/noise'
    r'|handshake msg3 sent \(\d+ bytes\), session established'
    r'|control WebSocket connected'
    r'|Loaded app from partition at offset 0x[0-9a-f]+'
    r'|Found \d+MB PSRAM device'
    r'|select\(\) timeout|getaddrinfo\(\) returns -?\d+|mbedtls_ssl_handshake returned -?0x[0-9a-fA-F]+'
    r'|Guru Meditation|stack overflow|assert failed|allocate DMA buffer failed|Allocation failed'
)
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
            if not a.memory_only:
                out.write(chunk)
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                decoded = line.decode('utf-8', 'replace').strip()
                if a.memory_only:
                    event = memory_line.search(decoded)
                    if not event:
                        continue
                    decoded = event.group(0)
                    out.write((decoded + '\n').encode())
                lines.append(decoded)
except serial.SerialException as e:
    print('Serial disconnected:', type(e).__name__)
finally:
    port.close()
pattern = re.compile(r'Guru Meditation|panic|stack overflow|assert failed|Backtrace:|Brownout|watchdog|abort\(\)|Loaded app from partition|esp_psram:|PSRAM test|companion:|sw_update:|voice pipeline|CO5300|CST820: Chip ID|ES8311|M5IOE1 initialized|Project name:|App version:|ESP-IDF:|heap_init:')
selected = [s for s in lines if pattern.search(s)]
for line in selected[-32:]:
    line = re.sub(r'(?:mgst_|eyJ|ghp_|github_pat_)[A-Za-z0-9_.-]+', '[redacted]', line)
    print(line)
kind = 'filtered memory log' if a.memory_only else 'raw log'
print(f'Captured {len(lines)} lines; {kind} retained locally: {target.relative_to(root)}')
