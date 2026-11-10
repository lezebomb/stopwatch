"""Read-only checks for the StopWatch USB app flasher."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

from esptool.cmds import detect_chip, run_stub


def boot_offset(data):
    if len(data) != 0x2000:
        raise ValueError('Could not read both OTA records')
    candidates = []
    for offset in (0, 0x1000):
        seq, state, crc = struct.unpack_from('<I20xII', data, offset)
        if seq == 0xffffffff or state in (3, 4) or crc != zlib.crc32(data[offset:offset + 4], 0xffffffff):
            continue
        if seq == 0 or state not in (2, 0xffffffff):
            raise ValueError('Pending or unknown OTA state; let the current firmware finish booting')
        candidates.append(seq)
    if not candidates and data != b'\xff' * 0x2000:
        raise ValueError('Neither OTA record confirms a stable boot slot')
    # The verified C152 layout has no factory app and exactly two OTA slots.
    return (0x20000, 0x420000)[(max(candidates, default=1) - 1) % 2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('port')
    parser.add_argument('partition_table', type=Path)
    parser.add_argument('app', type=Path)
    args = parser.parse_args()
    with detect_chip(args.port) as esp:
        try:
            if esp.CHIP_NAME != 'ESP32-S3':
                raise ValueError('Unexpected chip')
            info = esp.get_security_info()
            if (esp.secure_download_mode or info['parsed_flags']['SECURE_BOOT_EN'] or
                    info['flash_crypt_cnt'].bit_count() % 2):
                raise ValueError('Protected device: stop and assess before writing')
            stub = run_stub(esp)
            expected = args.partition_table.read_bytes()
            if stub.read_flash(0x10000, len(expected)) != expected:
                raise ValueError('Live partition table differs from the verified installation plan')
            address = boot_offset(stub.read_flash(0x1d000, 0x2000))
            image = args.app.read_bytes()
            identical = stub.flash_md5sum(address, len(image)) == hashlib.md5(image).hexdigest()
            print('@slot ' + json.dumps({'offset': hex(address), 'identical': identical}))
        finally:
            esp.hard_reset()


if __name__ == '__main__':
    main()
