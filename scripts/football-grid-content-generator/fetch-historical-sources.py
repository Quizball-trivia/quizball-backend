#!/usr/bin/env python3
"""Download immutable research snapshots and verify their checksums; no database access."""
import argparse
import hashlib
import importlib.util
import os
import ssl
import tempfile
import urllib.request
from pathlib import Path


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def fetch(url, target, digest):
    if target.exists():
        with target.open('rb') as handle:
            actual = hashlib.file_digest(handle, 'sha256').hexdigest()
        if actual != digest:
            raise ValueError(f'Existing snapshot differs: {target.name}; refusing to overwrite')
        return 'verified_cache'
    try:
        import certifi
        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        context = ssl.create_default_context()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            request = urllib.request.Request(url, headers={'User-Agent': 'QuizballHistoricalAudit/1.0'})
            with urllib.request.urlopen(request, timeout=60, context=context) as response:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        with temporary.open('rb') as handle:
            if hashlib.file_digest(handle, 'sha256').hexdigest() != digest:
                raise ValueError(f'Download checksum mismatch: {target.name}')
        # Hard-link installation is atomic and refuses concurrent replacement.
        os.link(temporary, target)
        return 'downloaded'
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--source', choices=['all', 'aggregate', 'epl'], default='all')
    args = parser.parse_args()
    if args.source in ('all', 'aggregate'):
        source = module('audit-historical-coverage')
        for name, digest in source.PINS.items():
            host = 'media.githubusercontent.com/media' if name == 'player_performances.csv' else 'raw.githubusercontent.com'
            category = Path(name).stem
            url = f'https://{host}/{source.SOURCE}/{source.COMMIT}/datalake/transfermarkt/{category}/{name}'
            print(name, fetch(url, args.out / name, digest))
    if args.source in ('all', 'epl'):
        source = module('audit-epl-history')
        for name, digest in source.PINS.items():
            url = f'https://raw.githubusercontent.com/pssguy/epldata/{source.COMMIT}/data-raw/{name}'
            print(name, fetch(url, args.out / 'epldata' / name, digest))


if __name__ == '__main__':
    main()
