#!/usr/bin/env python3
"""Download supplied YouTube audio into this private library (default: first 3)."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('url')
    p.add_argument('--book', required=True, help='Book name as it appears on the shelf')
    p.add_argument('--items', default='1:3', help='Playlist range, default 1:3; pass e.g. 4:20 for more chapters')
    p.add_argument('--downloader', default='yt-dlp', help='Path to a current yt-dlp executable')
    args = p.parse_args()
    parsed = urlsplit(args.url)
    if parsed.scheme != 'https' or parsed.hostname not in {'youtube.com','www.youtube.com','m.youtube.com','youtu.be'}:
        p.error('Use a YouTube HTTPS video or playlist URL.')
    if not args.book.strip() or args.book.startswith('.') or any(c in args.book for c in '/\\') or len(args.book.encode()) > 220:
        p.error('Invalid book name.')
    downloader = shutil.which(args.downloader)
    if not downloader: p.error('yt-dlp is not installed. Install a current version in an isolated environment.')
    if not shutil.which('ffmpeg'): p.error('ffmpeg is required for conversion to M4A.')
    directory = ROOT/'library'/args.book.strip()
    directory.mkdir(parents=True, exist_ok=True)
    data = ROOT/'data'; data.mkdir(exist_ok=True)
    # No cookies, browser profile access, or third-party stream proxies.
    command = [downloader, '--ignore-config', '--js-runtimes', 'node', '--yes-playlist',
        '--playlist-items', args.items, '--format', 'bestaudio[ext=m4a]/bestaudio/best',
        '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '96K',
        '--embed-metadata', '--no-overwrites', '--no-progress',
        '--download-archive', str(directory/'.download-archive.txt'),
        '--output', str(directory/'%(playlist_index|1)05d - %(title).130B [%(id)s].%(ext)s'),
        '--', args.url]
    result = subprocess.run(command)
    files = [f for f in directory.iterdir() if f.suffix in {'.m4a','.mp3'}]
    print(f'Library has {len(files)} completed audio file(s) in {directory}')
    if result.returncode: print('Import incomplete. Completed chapters are preserved; rerun to resume.', file=sys.stderr)
    return result.returncode

if __name__ == '__main__': sys.exit(main())
