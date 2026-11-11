"""Development USB link to the existing Muse console. Never opens a network port.

Photos use immutable files + verified NVS album generations on the device.
Production Windows wireless delivery remains a separate, unconfigured path.
"""
import argparse
import base64
import getpass
import hashlib
import json
import pathlib
import re
import sys
import time
import urllib.request
import urllib.error
import warnings
from urllib.parse import urlparse

import serial

PHOTO_BYTES = 466 * 466 * 2


class Device:
    def __init__(self, port, *, diagnostic_line=None):
        self.port = serial.Serial()
        self.port.port, self.port.baudrate, self.port.timeout = port, 115200, 0.2
        self.port.dtr, self.port.rts = False, False
        self.port.open()
        self.sequence = 0
        self.diagnostic_line = diagnostic_line

    def close(self):
        self.port.close()

    def command(self, op, timeout=15, **values):
        self.sequence += 1
        request = dict(id=self.sequence, op=op, **values)
        packet = b'>sw:' + json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'
        if len(packet) >= 1024:
            raise ValueError('Device command exceeds existing SDK console limit')
        self.port.write(packet)
        self.port.flush()
        end = time.monotonic() + timeout
        pending = b''
        while time.monotonic() < end:
            pending += self.port.read(max(1,self.port.in_waiting))
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                marker = line.find(b'@sw {')
                if marker < 0:
                    if self.diagnostic_line:
                        self.diagnostic_line(line)
                    continue
                try:
                    reply = json.loads(line[marker + 4:])
                except (UnicodeError, ValueError):
                    continue
                if reply.get('id') != request['id']:
                    continue
                if not reply.get('ok'):
                    raise RuntimeError(reply.get('error', 'Device rejected command'))
                return reply
        raise TimeoutError('Device did not acknowledge command')

    def upload(self, image, slot=0, select=True):
        image = bytes(image)
        if len(image) != PHOTO_BYTES:
            raise ValueError('Expected exact 466x466 little-endian RGB565 image')
        digest = hashlib.sha256(image).hexdigest()
        self.command('photo.begin', slot=slot, size=len(image), sha256=digest)
        try:
            for offset in range(0, len(image), 512):
                result = self.command('photo.chunk', offset=offset, data=base64.b64encode(image[offset:offset+512]).decode())
                if result['received'] != min(offset + 512, len(image)):
                    raise RuntimeError('Device acknowledged a wrong byte offset')
            self.command('photo.end')
        except BaseException:
            try:
                self.command('photo.abort')
            except (RuntimeError, TimeoutError):
                pass
            raise
        if select:
            self.command('select', index=slot+3)
            self.wait_display(digest)
        return digest

    def wait_display(self, digest, seconds=15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if self.command('info')['displaySha256'] == digest:
                return
            time.sleep(0.25)
        raise RuntimeError('Verified file has not reached the actual display buffer')


def watch(device, args):
    target = urlparse(args.relay)
    if target.scheme != 'https' and not (target.scheme == 'http' and target.hostname in ('127.0.0.1', 'localhost')):
        raise ValueError('Remote relay requires HTTPS')
    secret = json.loads(pathlib.Path(args.session_file).read_text(encoding='utf-8-sig'))['token']
    synced = {}
    failures = 0
    while True:
        try:
            req = urllib.request.Request(args.relay.rstrip('/')+'/api/state', headers={'Cookie': 'sw_session='+secret})
            with urllib.request.urlopen(req, timeout=10) as res:
                state = json.load(res)
            photos = state.get('photos', [])
            device_hashes = device.command('info').get('photoSha256', [])
            for slot, photo in enumerate(photos[:12]):
                if synced.get(slot) == photo['id']:
                    continue
                raw = (pathlib.Path(args.data) / (photo['id']+'.rgb565')).read_bytes()
                if slot >= len(device_hashes) or device_hashes[slot] != hashlib.sha256(raw).hexdigest():
                    device.upload(raw, slot, select=False)
                synced[slot] = photo['id']
            desired = state.get('settings', {}).get('defaultPhoto', 'builtin-0')
            if desired.startswith('builtin-'):
                selected = int(desired.split('-')[1])
            else:
                selected = next((i+3 for i,p in enumerate(photos[:12]) if p['id']==desired),0)
            if desired != getattr(args, '_selected', None):
                device.command('select', index=selected)
                args._selected = desired
            real = state.get('mode') == 'production' and state.get('bridgeOnline') and state.get('codex', {}).get('online')
            task = max((t for t in state.get('tasks', []) if t.get('mode')=='production'),key=lambda t:t.get('updated') or t.get('created') or 0,default={}) if real else {}
            title = str(task.get('title', '')).encode()[:140].decode('utf-8', 'ignore')
            device.command('task', source='app-server', online=bool(real), state=task.get('state','idle'), title=title)
            failures = 0
        except urllib.error.HTTPError as e:
            if e.code in (401,403):
                print('Viewer authorization expired or revoked; pair once again. No credentials were logged.',flush=True)
                return
        except (OSError, ValueError, RuntimeError, TimeoutError) as error:
            if isinstance(error, RuntimeError) and str(error) in ('album-recovery-required', 'photo-space-full'):
                print('Device needs attention: '+str(error)+'. Existing photos preserved; automatic writes stopped.',flush=True)
                return
            # Failed upload never activates partial data. Reconnect by reopening
            # the same local USB port; no pairing identity is regenerated.
            device.close()
            failures += 1
            wait = min(60, 3 * 2 ** min(failures-1, 5))
            print(f'USB or relay sync unavailable; current photos preserved; retry in {wait}s.',flush=True)
            time.sleep(wait)
            try:
                device.__init__(args.port)
            except serial.SerialException:
                continue
            args._selected = None
            synced.clear()
        time.sleep(2)


def read_muse_token(from_stdin=False):
    try:
        if from_stdin:
            token = sys.stdin.readline(256).strip()
        else:
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                token = getpass.getpass('Paste your Muse SDK token (hidden): ').strip()
    except getpass.GetPassWarning:
        raise SystemExit('Open an interactive terminal to enter the token privately.') from None
    if not re.fullmatch(r'mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]', token):
        raise SystemExit('Invalid Muse SDK token format.')
    return token


def set_muse_token(device, token, replace=False):
    status = device.command('muse.status')
    if status.get('sdkTokenStored') and not replace:
        print('Muse SDK token is already stored. No token was written.')
        return
    device.port.reset_input_buffer()
    device.port.write(f'>sdk_token={token}\n'.encode('ascii'))
    device.port.flush()
    deadline = time.monotonic() + 10
    pending = b''
    while time.monotonic() < deadline:
        pending += device.port.readline()
        if not pending.endswith(b'\n'):
            continue
        if pending.rstrip().endswith(b'@sdk_token ok'):
            print('Muse token saved on the StopWatch. Complete pairing in Muse > Settings > Devices.')
            return
        if b'@sdk_token error' in pending:
            raise SystemExit('StopWatch rejected the Muse SDK token.')
        pending = b''
    raise SystemExit('StopWatch did not confirm saving the Muse SDK token.')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port', required=True)
    p.add_argument('--info', action='store_true')
    p.add_argument('--photo', type=pathlib.Path)
    p.add_argument('--slot', type=int, default=0)
    p.add_argument('--watch', action='store_true')
    p.add_argument('--pipe', action='store_true', help='Trusted parent process NDJSON over stdin/stdout; no listener')
    p.add_argument('--relay')
    p.add_argument('--session-file')
    p.add_argument('--set-muse-token', action='store_true', help='Privately enter the SDK token over USB; restarts the device')
    p.add_argument('--replace-muse-token', action='store_true', help='Explicitly replace the stored token; pair again in Muse afterwards')
    p.add_argument('--muse-status', action='store_true', help='Read Muse authorization and hardware mute status without secrets')
    p.add_argument('--token-stdin', action='store_true', help='Receive the token from the local masked-entry helper over stdin')
    p.add_argument('--data', default='.data')
    a = p.parse_args()
    if a.set_muse_token and (a.info or a.photo or a.pipe or a.watch):
        p.error('--set-muse-token must be used by itself with --port')
    if a.replace_muse_token and not a.set_muse_token:
        p.error('--replace-muse-token requires --set-muse-token')
    if a.token_stdin and not a.set_muse_token:
        p.error('--token-stdin requires --set-muse-token')
    if a.watch and (not a.relay or not a.session_file):
        p.error('--watch requires --relay and an ignored viewer --session-file')
    muse_token = None
    if a.set_muse_token:
        probe = Device(a.port)
        try:
            status = probe.command('muse.status')
        finally:
            probe.close()
        if status.get('sdkTokenStored') and not a.replace_muse_token:
            print('Muse SDK token is already stored. No token was written.')
            return
        muse_token = read_muse_token(from_stdin=a.token_stdin)
    device = Device(a.port)
    try:
        if a.set_muse_token:
            set_muse_token(device, muse_token, replace=a.replace_muse_token)
            return
        if a.muse_status:
            print(json.dumps(device.command('muse.status')))
        if a.info:
            print(json.dumps(device.command('info')))
        if a.photo:
            digest = device.upload(a.photo.read_bytes(), a.slot)
            print(json.dumps({'displayed': True, 'sha256': digest}))
        if a.pipe:
            for line in sys.stdin:
                request = json.loads(line)
                identifier = request.pop('id')
                op = request.pop('op')
                try:
                    reply = device.command(op, **request)
                    print(json.dumps({'id': identifier, 'reply': reply}), flush=True)
                except (RuntimeError, TimeoutError, OSError) as e:
                    print(json.dumps({'id': identifier, 'error': str(e)}), flush=True)
        if a.watch:
            watch(device, a)
    finally:
        device.close()


if __name__ == '__main__':
    main()
