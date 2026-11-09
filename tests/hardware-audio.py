"""Opt-in SDK offline speaker/microphone test; no speech saved or sent online.

Plays SDK test tones at volume 30, then restores all original audio settings.
Raw UART logs stay in .data. Requires explicit --port, never runs in CI.
"""
import argparse
import importlib.util
import json
import pathlib
import re
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('device_sync', ROOT/'scripts/device-sync.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--port', required=True)
a = p.parse_args()
device = module.Device(a.port)
raw = bytearray()


def capture(seconds, until=None):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        raw.extend(device.port.read(max(1, device.port.in_waiting)))
        if until and until(bytes(raw)):
            return


def status():
    start = len(raw)
    device.port.write(b'>status\n')
    end = time.monotonic()+10
    while time.monotonic() < end:
        raw.extend(device.port.read(max(1, device.port.in_waiting)))
        for line in bytes(raw[start:]).splitlines():
            marker = line.find(b'@status {')
            if marker >= 0:
                try:
                    return json.loads(line[marker+8:])['device']
                except (ValueError, KeyError):
                    pass
    raise TimeoutError('SDK status did not arrive')


original = status()
original = {key: original[key] for key in ('volume', 'speaker', 'mic_gain')}
(ROOT/'.data/audio-original.json').write_text(json.dumps(original), encoding='utf-8')
try:
    device.port.write(b'>volume=30\n>speaker=1\n')
    device.command('info')  # Fence the SDK commands before playback.
    device.port.write(b'm')
    capture(4)
    device.port.write(b'>test.loopback\n')
    capture(70, until=lambda data: len(re.findall(rb'gain\s+\d+:', data))>=8)
finally:
    device.port.write(f">volume={original['volume']}\n>speaker={int(original['speaker'])}\n".encode())
    device.command('info')
    after = status()
    device.close()
    (ROOT/'.data/hardware-audio-raw.log').write_bytes(raw)

assert all(after[key]==value for key,value in original.items()), 'Audio settings not restored'
lines = raw.decode('utf-8', 'replace').splitlines()
spectra = [line for line in lines if re.search(r'gain\s+\d+:', line)]
assert len(spectra)>=8, 'SDK loopback sweep incomplete; inspect private log'
signal = False
for line in spectra:
    floor = re.search(r'floor (-?[\d.]+)/(-?[\d.]+)', line)
    tone = re.search(r'1000:(-?[\d.]+)/(-?[\d.]+)', line)
    if floor and tone:
        signal |= any(float(tone[i])>float(floor[i])+6 for i in (1,2))
assert signal, 'No microphone response to the generated 1kHz tone'
report = {'offlineSdkLoopback': True, 'microphoneToneResponse': True, 'gainSteps': len(spectra), 'settingsRestored': True, 'humanHearing': 'pending', 'levels': spectra}
(ROOT/'.data/hardware-audio-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({key:value for key,value in report.items() if key!='levels'}))
