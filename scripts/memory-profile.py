"""Record only allowlisted StopWatch memory and transport diagnostics."""

import argparse
import json
import pathlib
import re
import runpy
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
Device = runpy.run_path(str(ROOT / 'scripts/device-sync.py'))['Device']
PHASE = re.compile(
    rb'@mem ((?:boot|vm|relay|photo|miao|updater|probe)\.[a-z-]+)'
    rb'((?: -?\d+){11})\s*$'
)
TASK = re.compile(rb'@mem-task (\d+) ([\w-]+) (\d+) (\d+) ([01])\s*$')
DMA = re.compile(rb'@mem-dma ((?:-?\d+ ){10}-?\d+)\s*$')
TARGET = re.compile(rb'@mem-target ([a-z0-9.-]*(?:muse\.ai|facebook\.com|meta\.com))\s*$', re.I)
FAULT = re.compile(rb'Guru Meditation|stack overflow|assert failed|allocate DMA buffer failed|Allocation failed')
TRACE_TAG = re.compile(rb'\bI \(\d+\) sw_mem: ')
PHYSICAL_PSRAM = re.compile(rb'Found (\d+)MB PSRAM device')
TRANSPORT = re.compile(rb'select\(\) timeout|getaddrinfo\(\) returns -?\d+|'
                       rb'mbedtls_ssl_handshake returned -?0x[0-9a-fA-F]+')
PHASE_FIELDS = ('ms', 'dramFree', 'dramMinimum', 'dramLargest', 'dmaLargest',
                'psramFree', 'psramLargest', 'stackFree', 'result', 'detail', 'flags')
DMA_FIELDS = ('ms', 'stage', 'kind', 'requestedBytes', 'alignment', 'caps', 'result',
              'freeBefore', 'largestBefore', 'freeAfter', 'largestAfter')


def capture(log, line):
    tag = TRACE_TAG.search(line)
    if not tag:
        match = PHYSICAL_PSRAM.search(line)
        if match:
            log({'physicalPsramMiB': int(match[1])})
            return
        match = TRANSPORT.search(line)
        if match:
            log({'transport': match[0].decode()})
            return
        match = FAULT.search(line)
        if match:
            log({'fault': match[0].decode()})
        return
    line = line[tag.end():].rstrip().removesuffix(b'\x1b[0m')
    match = PHASE.search(line)
    if match:
        name, numbers = match.groups()
        log({'phase': name.decode(), **dict(zip(PHASE_FIELDS, map(int, numbers.split())))})
        return
    match = TASK.search(line)
    if match:
        number, name, stack, free, external = match.groups()
        log({'task': name.decode(), 'number': int(number), 'stack': int(stack),
             'stackFree': int(free), 'psramStack': external == b'1'})
        return
    match = DMA.fullmatch(line)
    if match:
        log({'dma': dict(zip(DMA_FIELDS, map(int, match[1].split())))})
        return
    match = TARGET.search(line)
    if match:
        log({'museTarget': match[1].decode()})
        return


def listen(device, trace, seconds):
    stop = time.monotonic() + seconds
    while time.monotonic() < stop:
        line = device.port.readline()
        if line:
            trace(line)


def verify_mute(device):
    muse = device.command('muse.status')
    if not muse['silent'] or muse['speakerAmp'] != 0 or muse['speaker'] or muse['volume'] != 0:
        raise RuntimeError('Mute invariant failed')
    return {key: muse[key] for key in ('wifi', 'accountLinked', 'sessionReady',
                                       'silent', 'speakerAmp')}


def exercise(device, trace, log):
    device.command('memory.tasks')
    device.command('memory.dma')
    device.command('memory.http-probe', timeout=35)
    decoded = device.command('diag.miao', timeout=45)['decoded']
    log({'exercise': 'miao-decode', 'frames': decoded})
    before = device.command('info')['miaoFramesDrawn']
    try:
        device.command('diag.codex', enabled=True)
        listen(device, trace, 12)
        after = device.command('info')['miaoFramesDrawn']
        memory = device.command('memory.stats')
        log({'exercise': 'miao-playback', 'frames': after - before,
             'dramFree': memory['dramFree'], 'dramLargest': memory['dramLargest'],
             'psramFree': memory['psramFree']})
    finally:
        device.command('diag.codex', enabled=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--boot-log', type=pathlib.Path)
    parser.add_argument('--seconds', type=int, default=1800)
    parser.add_argument('--exercise', action='store_true')
    args = parser.parse_args()
    private = ROOT / '.data'
    output = args.output.resolve()
    if not output.is_relative_to(private) or args.seconds <= 0:
        parser.error('Use a positive duration and a new report under .data')
    if args.boot_log and not args.boot_log.resolve().is_relative_to(private):
        parser.error('The boot log must be under .data')
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with output.open('x', encoding='utf-8') as report:
        def log(record):
            report.write(json.dumps({'elapsed': round(time.monotonic() - started, 2),
                                     **record}) + '\n')
            report.flush()

        def trace(line):
            capture(log, line)

        if args.boot_log:
            with args.boot_log.open('rb') as boot:
                for line in boot:
                    trace(line)
        device = Device(args.port, diagnostic_line=trace)
        try:
            log({'muse': verify_mute(device)})
            if args.exercise:
                exercise(device, trace, log)
            first = time.monotonic()
            deadline = first + args.seconds
            last_uptime = -1
            last_cover = None
            photo_transitions = 0
            next_check = first
            consecutive_gaps = 0
            print('Monitoring StopWatch memory', flush=True)
            while time.monotonic() < deadline:
                try:
                    sample = device.command('memory.stats', timeout=8)
                    info = device.command('info', timeout=8)
                    if time.monotonic() >= next_check:
                        log({'muse': verify_mute(device)})
                        next_check = time.monotonic() + 60
                except TimeoutError:
                    consecutive_gaps += 1
                    log({'sampleGap': 'usb-no-reply', 'consecutive': consecutive_gaps})
                    if consecutive_gaps >= 4:
                        raise
                    listen(device, trace, 1)
                    continue
                consecutive_gaps = 0
                sample.pop('id')
                sample.pop('ok')
                uptime = info['uptimeMs']
                if uptime < last_uptime:
                    log({'fault': 'uptime reset'})
                last_uptime = uptime
                cover = info['displaySha256']
                if cover and last_cover and cover != last_cover:
                    photo_transitions += 1
                last_cover = cover or last_cover
                log({'sample': sample, 'relay': info['relayState'], 'wifi': info['wifi'],
                     'health': info['otaState'], 'uptimeMs': uptime})
                listen(device, trace, min(3, max(0, deadline - time.monotonic())))
            for attempt in range(4):
                try:
                    device.command('memory.tasks', timeout=8)
                    muse = verify_mute(device)
                    break
                except TimeoutError:
                    log({'sampleGap': 'usb-no-reply', 'consecutive': attempt + 1})
                    if attempt == 3:
                        raise
                    listen(device, trace, 1)
            log({'muse': muse, 'monitorSeconds': time.monotonic() - first,
                 'photoTransitions': photo_transitions})
            print(f'Completed {args.seconds}s of monitoring', flush=True)
        finally:
            device.close()


if __name__ == '__main__':
    main()
