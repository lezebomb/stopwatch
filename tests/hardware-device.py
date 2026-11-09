"""Opt-in real USB transaction test. Never run in CI, never flashes firmware.

Requires the original factory backup to have been verified and uses only the
public test landscape in slot 0. Refuses to replace another personal photo.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import pathlib
import time

from esptool.reset import HardReset

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('device_sync', ROOT/'scripts/device-sync.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--port', required=True)
p.add_argument('--data', type=pathlib.Path, required=True)
a = p.parse_args()
session = json.loads((ROOT/'.data/hardware-session.json').read_text(encoding='utf-8-sig'))
assert session.get('backupVerified'), 'Verified factory backup required'
photo = json.loads((a.data/'uploaded-test.json').read_text(encoding='utf-8'))
image = (a.data/(photo['id']+'.rgb565')).read_bytes()
digest = hashlib.sha256(image).hexdigest()
assert len(image) == module.PHOTO_BYTES
device = module.Device(a.port)
report = {'photoBytes': len(image), 'cases': []}
started = time.monotonic()
try:
    before = device.command('info')
    assert before['photoSha256'][0] in ('', digest), 'Refusing to overwrite another personal photo'
    original = before['displaySha256']
    device.command('photo.begin', slot=0, size=len(image), sha256=digest)
    device.command('photo.chunk', offset=0, data=base64.b64encode(image[:512]).decode())
    try:
        device.command('photo.end')
        raise AssertionError('Incomplete transfer activated')
    except RuntimeError as e:
        assert 'incomplete-photo' in str(e)
    device.command('photo.abort')
    assert device.command('info')['displaySha256'] == original
    report['cases'].append('incomplete-transfer-keeps-current-cover')

    device.command('photo.begin', slot=0, size=len(image), sha256='0'*64)
    for offset in range(0, len(image), 512):
        device.command('photo.chunk', offset=offset, data=base64.b64encode(image[offset:offset+512]).decode())
    try:
        device.command('photo.end')
        raise AssertionError('Incorrect SHA256 activated')
    except RuntimeError as e:
        assert 'photo-hash-mismatch' in str(e)
    assert device.command('info')['displaySha256'] == original
    report['cases'].append('wrong-sha256-keeps-current-cover')

    device.upload(image, slot=0)
    current = device.command('info')
    assert current['photoSha256'][0] == digest
    report['cases'].append('real-photo-api-to-spiffs-to-display-buffer')

    builtin = (ROOT/'firmware/assets/1.rgb').read_bytes()
    device.command('select', index=1)
    device.wait_display(hashlib.sha256(builtin).hexdigest())
    device.command('select', index=3)
    device.wait_display(digest)
    report['cases'].append('original-and-personal-photo-coexist')

    time.sleep(0.5)  # Let the LVGL tick persist the selected cover.
    HardReset(device.port, uses_usb=True).reset()
    device.close()
    time.sleep(5)
    device = module.Device(a.port)
    device.wait_display(digest)
    after = device.command('info')
    assert after['photoSha256'][0] == digest
    assert after['serialStackMinimum'] > 512
    report['cases'].append('reboot-preserves-personal-photo-and-default-cover')
    report['before'] = before
    report['after'] = after
    report['elapsedSeconds'] = round(time.monotonic()-started, 1)
    report['status'] = 'passed'
    (ROOT/'.data/hardware-photo-test.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'passed', 'cases': report['cases'], 'elapsedSeconds': report['elapsedSeconds'], 'internalFree': after['internalFree'], 'serialStackMinimum': after['serialStackMinimum']}))
finally:
    device.close()
