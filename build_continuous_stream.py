#!/usr/bin/env python3
"""Losslessly package one local audiobook as a native HLS stream for iOS background playback."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

def natural(value):
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r'(\d+)', value)]

def probe(path):
    result = subprocess.run([
        'ffprobe', '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration',
        '-of', 'json', str(path)
    ], check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    stream = data['streams'][0]
    return float(data['format']['duration']), stream['codec_name'], int(stream['sample_rate']), int(stream['channels'])

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--book', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    directory = ROOT/'library'/args.book
    if not args.book or args.book.startswith('.') or any(char in args.book for char in '/\\') or not directory.is_dir() or directory.is_symlink():
        parser.error('Choose an existing book directory inside library/.')
    if args.output.exists():
        parser.error('Choose a new output directory so an older stream cannot be mixed into this build.')
    files = sorted((path for path in directory.iterdir() if path.is_file() and not path.is_symlink() and path.suffix.lower() in {'.m4a','.mp4','.aac'}), key=lambda path: natural(path.name))
    if not files:
        parser.error('The selected book contains no supported AAC audio files.')

    stream_id = hashlib.sha256(f'{args.book}/continuous-aac-v1'.encode()).hexdigest()[:24]
    stream_directory = args.output/stream_id
    stream_directory.mkdir(parents=True)
    chapters, playlist, elapsed, longest = [], ['#EXTM3U', '#EXT-X-VERSION:3'], 0.0, 0.0
    segment_lines = []
    for number, source in enumerate(files, 1):
        duration, codec, sample_rate, channels = probe(source)
        if (codec, sample_rate, channels) != ('aac', 44100, 2):
            raise ValueError(f'{source.name}: expected AAC 44.1 kHz stereo, got {codec} {sample_rate} Hz {channels} channels.')
        segment_name = f'seg-{number:05}.aac'
        target = stream_directory/segment_name
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(source), '-map', '0:a:0', '-c:a', 'copy', '-f', 'adts', str(target)], check=True)
        chapter_id = hashlib.sha256(f'{args.book}/{source.name}'.encode()).hexdigest()[:24]
        chapters.append({'id': chapter_id, 'start': round(elapsed, 6), 'duration': round(duration, 6)})
        segment_lines.extend([f'#EXTINF:{duration:.6f},', segment_name])
        elapsed += duration; longest = max(longest, duration)
        print(f'Packaged {number}/{len(files)}: {source.name}', flush=True)

    playlist.extend([f'#EXT-X-TARGETDURATION:{math.ceil(longest)}', '#EXT-X-MEDIA-SEQUENCE:0', *segment_lines, '#EXT-X-ENDLIST', ''])
    (stream_directory/'index.m3u8').write_text('\n'.join(playlist), encoding='utf-8')
    catalog = {'version': 1, 'books': [{'title': args.book, 'streamId': stream_id, 'chapters': chapters}]}
    (args.output/'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Built {len(files)} chapters, {elapsed/3600:.2f} hours, stream {stream_id}.')
    return 0

if __name__ == '__main__':
    try: sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError, KeyError, IndexError) as error:
        print(f'Build failed: {error}', file=sys.stderr); sys.exit(1)
