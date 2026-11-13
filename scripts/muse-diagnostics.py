"""Capture allowlisted Muse connection stages without account values or audio."""

import argparse
import collections
import json
import pathlib
import re
import runpy
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
Device = runpy.run_path(str(ROOT / 'scripts/device-sync.py'))['Device']
MEMORY = re.compile(rb'@mem vm\.(response|transport-error) ((?:-?\d+ ){10}-?\d+)')
STAGES = (
    ('dnsFailure', rb'getaddrinfo\(\) returns -?\d+'),
    ('tcpTimeout', rb'select\(\) timeout'),
    ('tlsReset', rb'mbedtls_ssl_handshake returned -?0x0050'),
    ('vmTls', rb'link\.noise_ctrl: TLS connected to '),
    ('websocketUpgrade', rb'link\.noise_ctrl: WebSocket upgraded to '),
    ('noiseHandshake', rb'link\.noise_ctrl: handshake msg3 sent \(\d+ bytes\), session established'),
    ('sessionReady', rb'link\.app: control WebSocket connected'),
    ('registered', rb'link\.noise_ctrl: link\.register acked; tunnel may open'),
    ('chatConnected', rb'muse_chat_session: connected to VM '),
    ('homeLinkConnected', rb'link\.ble: connected conn_handle='),
    ('homeLinkSubscribed', rb'link\.ble: subscribe notify=1'),
    ('homeLinkHello', rb'link\.ble: RX action: pairing_client_hello\b'),
    ('credentialsRevoked', rb'device credentials revoked; unpairing'),
    ('credentialsRefused', rb'device credentials refused; keeping them'),
    ('credentialsRefreshed', rb'device token refresh stored \(method=\d+\)'),
)
STAGES = tuple((name, re.compile(pattern)) for name, pattern in STAGES)
FAULT = re.compile(rb'Guru Meditation|stack overflow|assert failed|'
                   rb'allocate DMA buffer failed|Allocation failed')


def capture(report, line):
    if FAULT.search(line):
        report['events']['fault'] += 1
    for name, pattern in STAGES:
        if pattern.search(line):
            report['events'][name] += 1
    match = re.search(rb'link\.vm_api: (\d+) VMs found', line)
    if match:
        report['vmCount'] = int(match[1])
    match = re.search(rb'link\.vm_api: HTTP (\d{3})', line)
    if match:
        report['httpStatuses'][match[1].decode()] += 1
    match = re.search(rb'esp-tls: Muse LAN tunnel result: (-?\d+)', line)
    if match:
        report['proxyResults'][match[1].decode()] += 1
    match = MEMORY.search(line)
    if match:
        values = list(map(int, match[2].split()))
        key = '/'.join(map(str, values[-3:]))
        report['transportResults' if match[1] == b'transport-error' else 'httpResults'][key] += 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--seconds', type=int, default=90)
    parser.add_argument('--observe-ready', action='store_true',
                        help='Keep sampling an established session for the entire duration')
    parser.add_argument('--report', type=pathlib.Path, default=ROOT / '.data/muse-connect/diagnostics.json')
    args = parser.parse_args()
    if args.seconds < 1 or args.seconds > 1800:
        parser.error('Duration must be between 1 and 1800 seconds')
    target = args.report.resolve()
    if not target.is_relative_to(ROOT / '.data'):
        parser.error('Device reports must remain inside the ignored .data directory')
    target.parent.mkdir(parents=True, exist_ok=True)
    report = {key: collections.Counter() for key in (
        'events', 'httpStatuses', 'proxyResults', 'transportResults', 'httpResults')}
    device = Device(args.port, diagnostic_line=lambda line: capture(report, line))

    def status():
        state = device.command('muse.status', timeout=9)
        if (not state.get('silent') or state.get('speakerAmp') != 0 or
                state.get('speaker') or state.get('volume') != 0 or state.get('inCall')):
            raise RuntimeError('Mute and idle preconditions were not confirmed')
        return {key: state[key] for key in (
            'sdkTokenStored', 'tokenChanged', 'accountLinked', 'sessionReady', 'linkState',
            'bleStarted', 'bleConnected', 'bleSecure', 'wifi', 'silent', 'speakerAmp')}

    try:
        report['before'] = status()
        report['samples'] = []

        def sample(state):
            memory = device.command('memory.stats', timeout=5)
            info = device.command('info', timeout=5)
            report['samples'].append({
                'sessionReady': state['sessionReady'], 'wifi': state['wifi'],
                'uptimeMs': memory['ms'], 'relayState': info['relayState'],
                **{key: memory[key] for key in (
                    'dramFree', 'dramMinimum', 'dramLargest', 'dmaFree',
                    'dmaLargest', 'psramFree', 'psramLargest')},
            })

        sample(report['before'])
        try:
            credentials = device.command('muse.credentials', timeout=5)
            credential_fields = ('sdkTokenSyntaxValid', 'sdkTokenKeyPresent', 'pairingSdkHintKeyPresent',
                                 'pairingSdkHintMatches', 'accessTokenKeyPresent', 'refreshTokenKeyPresent',
                                 'legacyAuthTokenKeyPresent', 'usernameKeyPresent', 'preferredVmKeyPresent',
                                 'setupComplete', 'lookupErrors')
            report['credentials'] = {key: credentials[key] for key in credential_fields if key in credentials}
        except (RuntimeError, TimeoutError):
            report['credentialDiagnosticAvailable'] = False
        until = time.monotonic() + args.seconds
        pending = b''
        next_status = time.monotonic() + 15
        while time.monotonic() < until:
            pending += device.port.read(max(1, device.port.in_waiting))
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                capture(report, line)
            if time.monotonic() >= next_status:
                latest = status()
                sample(latest)
                if latest['sessionReady']:
                    report['events']['sessionReadyPoll'] += 1
                    if not args.observe_ready:
                        break
                next_status = time.monotonic() + 15
        report['after'] = status()
        sample(report['after'])
    finally:
        device.close()
        target.write_text(json.dumps(report, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    main()
