#!/usr/bin/env python3
"""Upload a prepared HLS audiobook, publishing its catalog only after every segment succeeds."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import sys
from upload_library import LibraryClient, MAX_FILE, ROOT

def upload(client, file, key):
    size = file.stat().st_size
    if size <= 0 or size > MAX_FILE:
        raise ValueError(f'{file.name}: stream files must be between 1 byte and 80 MB.')
    with file.open('rb') as body:
        status, response, _ = client.request('POST', '/api/stream-upload', body, {
            'Content-Length': str(size), 'Content-Type': 'application/octet-stream', 'X-Stream-Path': key})
    if status != 201:
        raise ValueError(f'{key}: upload failed (HTTP {status}: {response.decode(errors="replace")}).')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', required=True)
    parser.add_argument('--build', required=True, type=Path)
    parser.add_argument('--code-file', type=Path, default=ROOT/'data/access-code.txt')
    args = parser.parse_args()
    catalog_file = args.build/'catalog.json'
    data = json.loads(catalog_file.read_text(encoding='utf-8'))
    if len(data.get('books', [])) != 1 or not re.fullmatch(r'[a-f0-9]{24}', data['books'][0].get('streamId', '')):
        parser.error('The build catalog is invalid.')
    stream_id = data['books'][0]['streamId']
    stream_directory = args.build/stream_id
    files = sorted(stream_directory.glob('seg-*.aac'))
    if not files or not (stream_directory/'index.m3u8').is_file():
        parser.error('The build is missing its playlist or audio segments.')
    client = LibraryClient(args.site, args.code_file.read_text().strip())
    completed = 0
    with ThreadPoolExecutor(max_workers=3) as pool:
        for offset in range(0, len(files), 3):
            batch = files[offset:offset+3]
            futures = [pool.submit(upload, client, file, f'stream/{stream_id}/{file.name}') for file in batch]
            for future in futures: future.result(); completed += 1
            print(f'Uploaded {completed}/{len(files)} audio segments.', flush=True)
    upload(client, stream_directory/'index.m3u8', f'stream/{stream_id}/index.m3u8')
    upload(client, catalog_file, 'stream/catalog.json')
    print('Continuous stream is published.')
    return 0

if __name__ == '__main__':
    try: sys.exit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr); sys.exit(1)
