#!/usr/bin/env python3

# Serves Photoloft's built page to this machine only and exports videos
# with ffmpeg. A fixed local address gives Photoloft its own browser
# origin, so Chromium can keep folder access across restarts. No
# caching, so a rebuild shows up on the next start.
#
# The video API only answers the Photoloft page itself (Host and Origin
# checks plus a per-start token), never reads paths from requests,
# builds every ffmpeg filter and cut from validated numbers, and hands
# info texts to ffmpeg as single cleaned arguments.
#
# The drive API lists the removable drives mounted under the media
# folder and reads their photos and videos for import. It only reads,
# answers the same checks, and resolves every path inside its drive,
# past no hidden entry.

import collections
import functools
import getpass
import http.server
import json
import math
import mmap
import os
import pathlib
import re
import secrets
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent / 'dist'
DEFAULT_PORT = 47321
LUT_SIZE = 33
MAX_UPLOAD = 16 * 1024 ** 3
JOB_LIFETIME = 3600
CHUNK = 1024 * 1024
NUMBER = re.compile(r'^-?\d+(\.\d+)?([eE]-?\d+)?$')
SHORT_SIDES = (0, 720, 1080)
SETTING_KEYS = {
    'rotate', 'flip', 'angle', 'crop', 'shortSide', 'rate', 'creationTime',
    'stripGps', 'meta', 'trim'
}
CREATION_TIME = re.compile(
    r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$')

# x264 rate control: a constant quality (CRF, lower is better) in one
# pass, or a bitrate in kbit/s in one or two passes. x264 refuses a CRF
# in a second pass.
CRF_RANGE = (14, 32)
KBPS_RANGE = (100, 100_000)

# Cut points go to ffmpeg in milliseconds, so a trim keeps at least one.
SHORTEST_CUT = 0.001

# Info text lengths in characters, the same src/exif.ts uses for photos.
TEXT_LIMITS = {
    'title': 200, 'description': 2000, 'author': 200, 'copyright': 200
}
KEYWORD_LIMIT = 100
KEYWORD_COUNT = 50
META_KEYS = {*TEXT_LIMITS, 'keywords', 'location'}
SPACES = re.compile(r'[\t\n\v\f\r]+')
CONTROLS = re.compile(r'[\x00-\x1f\x7f-\x9f\ufffe\uffff]')

# Info fields as ffmpeg's MP4 tags. The description also goes into the
# comment, which more players show.
INFO_TAGS = {
    'title': ('title',),
    'description': ('description', 'comment'),
    'keywords': ('keywords',),
    'author': ('artist',),
    'copyright': ('copyright',)
}

# ISO 6709 in degrees, as phones write it: +DD.DDDD+DDD.DDDD/, maybe
# followed by an altitude.
ISO_6709 = re.compile(r'^([+-]\d{2}(?:\.\d+)?)([+-]\d{3}(?:\.\d+)?)')
CHUNK_TABLES = {b'stco': '>I', b'co64': '>Q'}
TRACK_BOXES = {b'trak', b'mdia', b'minf', b'stbl'}

# What the page imports: JPEGs and the videos of src/library.ts
# VIDEO_EXTS. Other programs' thumbnail and cache folders stay out of a
# folder import, as in src/storage.ts, and so do the folders systems
# keep on drives.
MEDIA_EXTS = {'.jpg', '.jpeg', '.mp4', '.mov', '.m4v'}
CACHE_FOLDER = re.compile(
    r'^(thumbs|thumbnails?|previews|cache|@eadir)$|\.lrdata$', re.I)
SYSTEM_FOLDERS = {'system volume information', '$recycle.bin'}
RANGE = re.compile(r'^bytes=(\d*)-(\d*)$')
THUMB_PATH = '/api/drive/thumb'

# Thumbnails of drive files: at most this many pixels on the long edge
# when ffmpeg draws them, and how many are kept in memory.
THUMB_SIZE = 360
THUMBS_KEPT = 2000

# A camera's EXIF thumbnail lies in the APP1 segment, at most 64 KB
# into the file.
EXIF_READ = 128 * 1024
ORIENTATION = 0x0112
THUMB_OFFSET = 0x0201
THUMB_LENGTH = 0x0202


# ─── Validation ──────────────────────────────────────────────────────

def parse_settings(raw):
    if not isinstance(raw, dict) or set(raw) != SETTING_KEYS:
        raise ValueError('unexpected settings')

    rotate = raw['rotate']
    if rotate not in (0, 90, 180, 270) or isinstance(rotate, bool):
        raise ValueError('rotate')
    if not isinstance(raw['flip'], bool):
        raise ValueError('flip')

    angle = number(raw['angle'])
    if abs(angle) > 45:
        raise ValueError('angle')

    crop = raw['crop']
    if not isinstance(crop, dict) or set(crop) != {'x', 'y', 'w', 'h'}:
        raise ValueError('crop')
    x, y, w, h = (number(crop[k]) for k in ('x', 'y', 'w', 'h'))
    inside = min(x, y) >= 0 and w > 0 and h > 0
    if not inside or x + w > 1.0001 or y + h > 1.0001:
        raise ValueError('crop')

    if raw['shortSide'] not in SHORT_SIDES:
        raise ValueError('shortSide')

    created = raw['creationTime']
    if created is not None and not (
            isinstance(created, str) and CREATION_TIME.match(created)):
        raise ValueError('creationTime')
    if not isinstance(raw['stripGps'], bool):
        raise ValueError('stripGps')

    return {
        'rotate': rotate,
        'flip': raw['flip'],
        'angle': angle,
        'crop': {'x': x, 'y': y, 'w': w, 'h': h},
        'shortSide': raw['shortSide'],
        'rate': parse_rate(raw['rate']),
        'creationTime': created,
        'stripGps': raw['stripGps'],
        'meta': parse_meta(raw['meta']),
        'trim': parse_trim(raw['trim'])
    }


def parse_rate(raw):
    if isinstance(raw, dict) and set(raw) == {'crf'}:
        return {'crf': whole(raw['crf'], *CRF_RANGE)}
    if isinstance(raw, dict) and set(raw) == {'kbps', 'passes'}:
        return {'kbps': whole(raw['kbps'], *KBPS_RANGE),
                'passes': whole(raw['passes'], 1, 2)}
    raise ValueError('rate')


def whole(value, low, high):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError('not a whole number')
    if not low <= value <= high:
        raise ValueError('out of range')
    return value


# The part of the clip to keep, in seconds, or None for all of it.
def parse_trim(raw):
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) != {'start', 'end'}:
        raise ValueError('trim')
    start, end = number(raw['start']), number(raw['end'])
    if start < 0 or end - start < SHORTEST_CUT:
        raise ValueError('trim')
    return {'start': start, 'end': end}


# Texts are cleaned and capped like photo exports; a missing key leaves
# the camera's value, an empty text removes it.
def parse_meta(raw):
    if not isinstance(raw, dict) or not set(raw) <= META_KEYS:
        raise ValueError('meta')

    meta = {key: clean(raw[key], limit)
            for key, limit in TEXT_LIMITS.items() if key in raw}
    if 'keywords' in raw:
        if not isinstance(raw['keywords'], list):
            raise ValueError('keywords')
        words = [clean(word, KEYWORD_LIMIT) for word in raw['keywords']]
        unique = list(dict.fromkeys(word for word in words if word))
        meta['keywords'] = unique[:KEYWORD_COUNT]
    if 'location' in raw:
        meta['location'] = parse_location(raw['location'])
    return meta


# Line breaks and tabs become spaces, other control characters and
# unpaired surrogates go.
def clean(text, limit):
    if not isinstance(text, str):
        raise ValueError('text')
    plain = text.encode('utf-8', 'ignore').decode()
    plain = CONTROLS.sub('', SPACES.sub(' ', plain)).strip()
    return plain[:limit].strip()


def parse_location(raw):
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) != {'lat', 'lon'}:
        raise ValueError('location')
    lat, lon = number(raw['lat']), number(raw['lon'])
    if abs(lat) > 90 or abs(lon) > 180:
        raise ValueError('location')
    return {'lat': lat, 'lon': lon}


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('not a number')
    if not math.isfinite(value):
        raise ValueError('not finite')
    return float(value)


# A .cube table: the size line, then LUT_SIZE³ lines of three numbers
# between 0 and 1. Anything else is refused.
def parse_lut(text):
    lines = [line.strip() for line in text.strip().splitlines()]
    if not lines or lines[0] != f'LUT_3D_SIZE {LUT_SIZE}':
        raise ValueError('lut size')
    rows = lines[1:]
    if len(rows) != LUT_SIZE ** 3:
        raise ValueError('lut length')

    for row in rows:
        values = row.split()
        if len(values) != 3 or not all(NUMBER.match(v) for v in values):
            raise ValueError('lut row')
        if not all(0 <= float(v) <= 1 for v in values):
            raise ValueError('lut range')
    return '\n'.join(lines) + '\n'


def allowed(host, origin, port):
    expected = f'127.0.0.1:{port}'
    return host == expected and origin in (None, f'http://{expected}')


# ─── ffmpeg ──────────────────────────────────────────────────────────

# Browsers decode HD video with BT.709, so the conversion to RGB for
# the colour table and back uses it explicitly. Crop values are
# fractions of the straightened frame.
def build_filters(settings, lut_path):
    chain = [
        'scale=in_color_matrix=bt709:in_range=tv',
        'format=rgb24',
        f'lut3d=file={lut_path}:interp=tetrahedral'
    ]

    turns = {90: ['transpose=1'], 180: ['hflip', 'vflip'],
             270: ['transpose=2']}
    chain += turns.get(settings['rotate'], [])
    if settings['flip']:
        chain.append('hflip')

    if abs(settings['angle']) > 0.01:
        rad = f"{math.radians(settings['angle']):.6f}"
        chain.append(f'rotate={rad}:ow=rotw({rad}):oh=roth({rad}):c=black')

    crop = settings['crop']
    if (crop['w'], crop['h']) != (1, 1):
        size = f"w=iw*{crop['w']:.6f}:h=ih*{crop['h']:.6f}"
        chain.append(f"crop={size}:x=iw*{crop['x']:.6f}:y=ih*{crop['y']:.6f}")

    side = settings['shortSide']
    if side:
        width = f"'if(gte(iw,ih),-2,min({side},iw))'"
        height = f"'if(gte(iw,ih),min({side},ih),-2)'"
        chain.append(f'scale=w={width}:h={height}:flags=lanczos')
    else:
        chain.append('scale=trunc(iw/2)*2:trunc(ih/2)*2')

    chain += ['scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p']
    return ','.join(chain)


# The ffmpeg runs of an export, in order. Two passes start with a run
# that only writes x264's statistics next to the target; its video goes
# to the null device, since stdout carries the progress.
def ffmpeg_commands(source, target, settings, lut_path, place):
    rate = settings['rate']
    control = (['-crf', str(rate['crf'])] if 'crf' in rate
               else ['-b:v', f"{rate['kbps']}k"])
    head = ['ffmpeg', '-hide_banner', '-nostdin', '-y',
            *cut(settings['trim']), '-i', str(source), '-map', '0:v:0']
    video = ['-vf', build_filters(settings, lut_path),
             '-c:v', 'libx264', '-preset', 'medium', *control]
    report = ['-progress', 'pipe:1', '-nostats', '-loglevel', 'error']
    final = [
        *head, '-map', '0:a:0?', *video,
        '-colorspace', 'bt709', '-color_primaries', 'bt709',
        '-color_trc', 'bt709',
        '-c:a', 'aac', '-b:a', '160k',
        '-map_metadata', '0', *metadata(settings, place),
        '-movflags', '+faststart', *report
    ]
    if rate.get('passes') != 2:
        return [[*final, str(target)]]

    log = ['-passlogfile', str(target.with_name('passlog'))]
    first = [*head, *video, '-pass', '1', *log, *report,
             '-f', 'null', os.devnull]
    return [first, [*final, '-pass', '2', *log, str(target)]]


# Seeking in the input while re-encoding decodes from the keyframe
# before the in mark and drops every frame before it, so the export
# starts and ends on the frames the marks point at.
def cut(trim):
    if not trim:
        return []
    length = trim['end'] - trim['start']
    return ['-accurate_seek', '-ss', f"{trim['start']:.3f}",
            '-t', f'{length:.3f}']


# Tags over the source's own: the capture time, the info texts set in
# Photoloft, and the location chosen for the export, which also clears
# the camera's.
def metadata(settings, place):
    tags = {}
    if settings['creationTime']:
        tags['creation_time'] = settings['creationTime']
    meta = settings['meta']
    for field, keys in INFO_TAGS.items():
        if field in meta:
            value = meta[field]
            text = ', '.join(value) if field == 'keywords' else value
            tags.update(dict.fromkeys(keys, text))
    tags['location'] = place or ''
    return [arg for key, value in tags.items()
            for arg in ('-metadata', f'{key}={value}')]


# The location an export carries, as ISO 6709: the one set in Photoloft,
# else the camera's unless camera locations are removed.
def place_of(settings, source):
    meta = settings['meta']
    if 'location' in meta:
        place = meta['location']
    elif settings['stripGps']:
        place = None
    else:
        place = recorded_place(source)
    return iso6709(place) if place else None


def recorded_place(path):
    args = ['ffprobe', '-v', 'error', '-show_entries', 'format_tags=location',
            '-of', 'json', str(path)]
    try:
        found = json.loads(subprocess.check_output(args))
    except (subprocess.CalledProcessError, ValueError):
        return None
    tags = found.get('format', {}).get('tags', {})
    return parse_iso6709(tags.get('location', ''))


# Seconds the export lasts: the trimmed part, ending with the file, or
# the whole file; 0 when ffprobe cannot tell.
def duration_of(path, trim=None):
    args = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1', str(path)]
    try:
        full = float(subprocess.check_output(args).strip() or 0)
    except (subprocess.CalledProcessError, ValueError):
        return 0.0
    if not trim or not full:
        return full
    return max(0.0, min(full, trim['end']) - trim['start'])


# The share done from one line of ffmpeg's -progress output, or None for
# other lines and for a time that is no number, such as the
# out_time_us=N/A ffmpeg reports until its muxer has a first packet.
def progress_share(line, total):
    key, _, value = line.partition('=')
    if key != 'out_time_us' or not total:
        return None
    try:
        return min(1.0, int(value) / 1e6 / total)
    except ValueError:
        return None


# Each ffmpeg run counts for an equal share of the progress.
def export_video(source, target, settings, lut_path, on_progress=None,
                 runner=None):
    runner = runner or Runner()
    total = duration_of(source, settings['trim'])
    place = place_of(settings, source)
    commands = ffmpeg_commands(source, target, settings, lut_path, place)
    for done, args in enumerate(commands):
        def report(share, done=done):
            if on_progress:
                on_progress((done + share) / len(commands))
        run_ffmpeg(runner, args, total, report)
    if place:
        add_place(target, place)


# ffmpeg's errors go to a file, since a damaged clip can log more than a
# pipe holds before its progress ends.
def run_ffmpeg(runner, args, total, report):
    with (tempfile.TemporaryFile() as log,
          runner.start(args, log) as process):
        for line in process.stdout:
            share = progress_share(line, total)
            if share is not None:
                report(share)
        if process.wait() == 0:
            return
        if runner.stopped:
            raise RuntimeError('cancelled')
        log.seek(0)
        error = log.read().decode(errors='replace').strip()
        raise RuntimeError(error or 'ffmpeg failed')


# Starts a job's ffmpeg runs one at a time. Stopping kills the run in
# progress and refuses any later one, under one lock, so a pass that
# is about to start cannot slip past a cancel.
class Runner:
    def __init__(self):
        self.lock = threading.Lock()
        self.stopped = False
        self.process = None

    def start(self, args, log):
        with self.lock:
            if self.stopped:
                raise RuntimeError('cancelled')
            self.process = subprocess.Popen(
                args, stdout=subprocess.PIPE, stderr=log, text=True)
            return self.process

    def stop(self):
        with self.lock:
            self.stopped = True
            if self.process:
                self.process.kill()


# ─── MP4 location ────────────────────────────────────────────────────

def iso6709(place):
    return f"{place['lat']:+08.4f}{place['lon']:+09.4f}/"


def parse_iso6709(text):
    match = ISO_6709.match(text)
    if not match:
        return None
    lat, lon = float(match[1]), float(match[2])
    if abs(lat) > 90 or abs(lon) > 180:
        return None
    return {'lat': lat, 'lon': lon}


# Writes the location as ©xyz into moov/udta, where Android and Google
# Photos read it; ffmpeg's MP4 muxer only writes a 3GPP loci box. Chunk
# offsets pointing behind the moov box move by the bytes added.
def add_place(path, place):
    text = place.encode('ascii')
    entry = box(b'\xa9xyz', struct.pack('>HH', len(text), 0x15c7) + text)
    temp = path.with_name(path.name + '.part')

    with (open(path, 'rb') as file,
          mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ) as data):
        found = first(data, 0, len(data), b'moov')
        if not found:
            raise RuntimeError('no moov box')
        _, start, body, end = found

        moov = bytearray(data[start:end])
        udta = first(moov, body - start, len(moov), b'udta')
        added = len(entry) if udta else len(entry) + 8
        shift_chunks(moov, body - start, len(moov), start, added)
        if udta:
            _, at, _, stop = udta
            grow(moov, at, added)
            moov[stop:stop] = entry
        else:
            moov += box(b'udta', entry)
        grow(moov, 0, added)

        with open(temp, 'wb') as out:
            out.write(data[:start])
            out.write(moov)
            for at in range(end, len(data), CHUNK):
                out.write(data[at:at + CHUNK])
    temp.replace(path)


def shift_chunks(data, start, end, after, by):
    for kind, _, body, stop in boxes(data, start, end):
        if kind in TRACK_BOXES:
            shift_chunks(data, body, stop, after, by)
        if kind not in CHUNK_TABLES:
            continue

        form = CHUNK_TABLES[kind]
        step = struct.calcsize(form)
        count = struct.unpack_from('>I', data, body + 4)[0]
        if body + 8 + count * step > stop:
            raise RuntimeError('broken chunk table')
        for at in range(body + 8, body + 8 + count * step, step):
            offset = struct.unpack_from(form, data, at)[0]
            if offset > after:
                if offset + by >= 1 << (8 * step):
                    raise RuntimeError('chunk offset overflow')
                struct.pack_into(form, data, at, offset + by)


# (type, start, payload start, end) of each box between two offsets.
def boxes(data, start, end):
    at = start
    while at + 8 <= end:
        size, kind = struct.unpack_from('>I4s', data, at)
        header = 8
        if size == 1 and at + 16 <= end:
            size, header = struct.unpack_from('>Q', data, at + 8)[0], 16
        elif size == 0:
            size = end - at
        if size < header or at + size > end:
            raise RuntimeError('broken MP4 box')
        yield kind, at, at + header, at + size
        at += size


def first(data, start, end, kind):
    return next((b for b in boxes(data, start, end) if b[0] == kind), None)


def box(kind, payload):
    return struct.pack('>I4s', len(payload) + 8, kind) + payload


def grow(data, at, by):
    size = struct.unpack_from('>I', data, at)[0]
    if size == 1:
        large = struct.unpack_from('>Q', data, at + 8)[0]
        struct.pack_into('>Q', data, at + 8, large + by)
    elif size:
        struct.pack_into('>I', data, at, size + by)


# ─── Jobs ────────────────────────────────────────────────────────────

class Jobs:
    def __init__(self):
        self.items = {}
        self.lock = threading.Lock()

    def start(self, folder, settings):
        self.prune()
        job = {
            'id': secrets.token_hex(8),
            'folder': folder,
            'state': 'running',
            'progress': 0.0,
            'error': None,
            'started': time.time(),
            'runner': Runner()
        }
        with self.lock:
            self.items[job['id']] = job
        thread = threading.Thread(target=self.run, args=(job, settings))
        thread.daemon = True
        thread.start()
        return job

    def run(self, job, settings):
        folder = job['folder']

        def progress(value):
            job['progress'] = value

        # Any failure ends the job, so the page stops waiting for it. The
        # upload and any half-written output go at once, since the page
        # never fetches a failed job's result.
        try:
            export_video(folder / 'input', folder / 'output.mp4', settings,
                         folder / 'lut.cube', progress, job['runner'])
            job['state'] = 'done'
            job['progress'] = 1.0
        except Exception as error:
            shutil.rmtree(folder, ignore_errors=True)
            job['error'] = str(error)[-500:]
            job['state'] = 'failed'

        # A job cancelled while it ran goes as soon as it ends.
        if job['runner'].stopped:
            self.finish(job['id'])

    def get(self, job_id):
        with self.lock:
            return self.items.get(job_id)

    # Stops a running job, which then removes itself, and removes an
    # ended one at once. The state is read after the stop, so a job that
    # ends in between is removed by one side or the other.
    def cancel(self, job_id):
        job = self.get(job_id)
        if not job:
            return False
        job['runner'].stop()
        if job['state'] != 'running':
            self.finish(job_id)
        return True

    def finish(self, job_id):
        with self.lock:
            job = self.items.pop(job_id, None)
        if job:
            shutil.rmtree(job['folder'], ignore_errors=True)

    def prune(self):
        cutoff = time.time() - JOB_LIFETIME
        with self.lock:
            old = [j for j in self.items.values() if j['started'] < cutoff]
        for job in old:
            if job['state'] != 'running':
                self.finish(job['id'])


# ─── Drives ──────────────────────────────────────────────────────────

def default_media():
    return os.environ.get('PHOTOLOFT_MEDIA_ROOT') or \
        f'/run/media/{getpass.getuser()}'


def drives(media):
    try:
        entries = list(os.scandir(media))
    except OSError:
        return []
    return sorted(e.name for e in entries
                  if e.is_dir(follow_symlinks=False) and not hidden(e.name))


def hidden(name):
    return name.startswith('.') or name.lower() in SYSTEM_FOLDERS


# The real path of `path` (parts split by /) on the drive, or None when
# the drive is no folder of the media folder, or the path passes a
# hidden entry, leads off the drive or to nothing.
def drive_path(media, drive, path):
    root = os.path.realpath(media)
    if not drive or hidden(drive) or '/' in drive:
        return None
    base = os.path.realpath(os.path.join(root, drive))
    if os.path.dirname(base) != root or not os.path.isdir(base):
        return None

    parts = [part for part in path.split('/') if part]
    if any(hidden(part) for part in parts):
        return None
    target = os.path.realpath(os.path.join(base, *parts))
    inside = target == base or target.startswith(base + os.sep)
    return target if inside and os.path.exists(target) else None


def is_media(name):
    return os.path.splitext(name)[1].lower() in MEDIA_EXTS


def media_file(entry, path):
    stat = entry.stat(follow_symlinks=False)
    return {
        'path': path,
        'name': entry.name,
        'size': stat.st_size,
        'modified': int(stat.st_mtime * 1000)
    }


# The folder's subfolders and photos and videos; `path` is where the
# folder lies on its drive.
def listing(folder, path):
    folders, files = [], []
    for entry in os.scandir(folder):
        if hidden(entry.name):
            continue
        if entry.is_dir(follow_symlinks=False):
            folders.append(entry.name)
        elif entry.is_file(follow_symlinks=False) and is_media(entry.name):
            files.append(media_file(entry, join_path(path, entry.name)))
    files.sort(key=lambda f: f['name'])
    return {'folders': sorted(folders), 'files': files}


# The photos and videos in the folder and all its subfolders, and how
# many other files there are.
def walk(folder, path):
    files, skipped = [], 0
    for entry in sorted(os.scandir(folder), key=lambda e: e.name):
        if hidden(entry.name):
            continue
        inner = join_path(path, entry.name)
        if entry.is_dir(follow_symlinks=False):
            if CACHE_FOLDER.search(entry.name):
                continue
            found = walk(entry.path, inner)
            files += found['files']
            skipped += found['skipped']
        elif entry.is_file(follow_symlinks=False):
            if is_media(entry.name):
                files.append(media_file(entry, inner))
            else:
                skipped += 1
    return {'files': files, 'skipped': skipped}


def join_path(path, name):
    return f'{path}/{name}' if path else name


# The part of a file of `size` bytes a Range header asks for, as start
# and end, or None for the whole file. A range that starts past the end
# raises ValueError.
def byte_range(header, size):
    found = RANGE.match(header or '')
    if not found or found.groups() == ('', ''):
        return None

    first, last = found.groups()
    if first:
        start = int(first)
        end = min(size, int(last) + 1) if last else size
    else:
        start, end = max(0, size - int(last)), size
    if start >= end:
        raise ValueError('range outside the file')
    return start, end


# The thumbnail a camera stored in the photo's EXIF, carrying the
# photo's orientation so the browser shows it upright, or None.
def exif_thumbnail(path):
    with open(path, 'rb') as source:
        data = source.read(EXIF_READ)
    tiff = exif_tiff(data)
    if tiff is None:
        return None

    try:
        order = '<' if tiff[:2] == b'II' else '>'
        first = ifd_entries(tiff, order, struct.unpack(order + 'I',
                                                       tiff[4:8])[0])
        second = ifd_entries(tiff, order, first.get('next', 0))
    except struct.error:
        return None
    start = second.get(THUMB_OFFSET)
    length = second.get(THUMB_LENGTH)
    thumb = tiff[start:start + length] if start and length else b''
    if not thumb.startswith(b'\xff\xd8'):
        return None

    orientation = first.get(ORIENTATION, 1)
    if not 2 <= orientation <= 8:
        return thumb
    return thumb[:2] + orientation_segment(orientation) + thumb[2:]


# The TIFF data of the JPEG's EXIF segment, or None.
def exif_tiff(data):
    if data[:2] != b'\xff\xd8':
        return None
    at = 2
    while at + 4 <= len(data) and data[at] == 0xff:
        marker = data[at + 1]
        length = struct.unpack('>H', data[at + 2:at + 4])[0]
        segment = data[at + 4:at + 2 + length]
        if marker == 0xe1 and segment[:6] == b'Exif\x00\x00':
            return segment[6:]
        if marker == 0xda:
            return None
        at += 2 + length
    return None


# The first value of each short or long entry of the IFD at `offset`,
# by tag, and the offset of the next IFD under 'next'.
def ifd_entries(tiff, order, offset):
    if not offset:
        return {}
    count = struct.unpack(order + 'H', tiff[offset:offset + 2])[0]
    entries = {}
    for i in range(count):
        at = offset + 2 + i * 12
        tag, kind = struct.unpack(order + 'HH', tiff[at:at + 4])
        if kind == 3:
            entries[tag] = struct.unpack(order + 'H', tiff[at + 8:at + 10])[0]
        elif kind == 4:
            entries[tag] = struct.unpack(order + 'I', tiff[at + 8:at + 12])[0]
    end = offset + 2 + count * 12
    entries['next'] = struct.unpack(order + 'I', tiff[end:end + 4])[0]
    return entries


# An APP1 segment holding nothing but the orientation.
def orientation_segment(orientation):
    tiff = b'MM\x00\x2a' + struct.pack('>IHHHIHHI', 8, 1, ORIENTATION, 3, 1,
                                        orientation, 0, 0)
    payload = b'Exif\x00\x00' + tiff
    return b'\xff\xe1' + struct.pack('>H', len(payload) + 2) + payload


# A small upright JPEG of the photo or the video's first frame: the
# camera's EXIF thumbnail when there is one, else one ffmpeg draws.
# None when neither works.
def thumbnail(path):
    if os.path.splitext(path)[1].lower() in ('.jpg', '.jpeg'):
        stored = exif_thumbnail(path)
        if stored:
            return stored

    side = THUMB_SIZE
    scale = f"scale='min({side},iw)':'min({side},ih)':" \
        'force_original_aspect_ratio=decrease'
    args = ['ffmpeg', '-v', 'error', '-i', path, '-frames:v', '1',
            '-vf', scale, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg',
            'pipe:1']
    try:
        done = subprocess.run(args, capture_output=True, timeout=60)
    except subprocess.TimeoutExpired:
        return None
    return done.stdout if done.returncode == 0 and done.stdout else None


# Thumbnails drawn so far, by path, size and time, the oldest dropped
# first beyond THUMBS_KEPT.
class Thumbs:
    def __init__(self):
        self.lock = threading.Lock()
        self.kept = collections.OrderedDict()

    def get(self, path):
        stat = os.stat(path)
        key = (path, stat.st_size, stat.st_mtime_ns)
        with self.lock:
            if key in self.kept:
                return self.kept[key]
        data = thumbnail(path)
        if data:
            with self.lock:
                self.kept[key] = data
                while len(self.kept) > THUMBS_KEPT:
                    self.kept.popitem(last=False)
        return data


# ─── HTTP ────────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):
    answered = False

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *args):
        pass

    # A thumbnail goes into an image, which sends no headers of its
    # own, so it may carry the token in its address.
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path = url.path
        query = urllib.parse.parse_qs(url.query)
        if not path.startswith('/api/'):
            return super().do_GET()
        sent = query.get('token', [''])[0] if path == THUMB_PATH else None
        if not self.permitted(token=path != '/api/token', sent=sent):
            return self.reply(403, {'error': 'forbidden'})

        if path == '/api/token':
            return self.reply(200, {'token': self.server.token})
        if path == '/api/drives':
            return self.reply(200, {'drives': drives(self.server.media)})
        if path.startswith('/api/drive/'):
            return self.drive_request(path, query)

        parts = path.split('/')
        job = self.server.jobs.get(parts[3]) if len(parts) > 3 else None
        if not job or not parts[2] == 'videos':
            return self.reply(404, {'error': 'not found'})
        if len(parts) == 4:
            return self.reply(200, status(job))
        if len(parts) == 5 and parts[4] == 'result' and job['state'] == 'done':
            return self.send_result(job)
        return self.reply(404, {'error': 'not found'})

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if not self.permitted(token=True):
            return self.reply(403, {'error': 'forbidden'})
        if path != '/api/videos':
            return self.reply(404, {'error': 'not found'})

        try:
            settings = parse_settings(
                json.loads(self.headers.get('X-Photoloft-Settings', '')))
            lut_length = int(self.headers.get('X-Photoloft-Lut-Length', ''))
            length = int(self.headers.get('Content-Length', ''))
        except ValueError as error:
            return self.reply(400, {'error': f'bad request: {error}'})
        if not 0 < lut_length < length <= MAX_UPLOAD:
            return self.reply(400, {'error': 'bad length'})

        folder = pathlib.Path(tempfile.mkdtemp(prefix='photoloft-'))
        try:
            table = parse_lut(self.rfile.read(lut_length).decode('ascii'))
            (folder / 'lut.cube').write_text(table)
            self.receive(folder / 'input', length - lut_length)
        except ConnectionError:
            # The page stopped sending, as a cancel does, and waits for
            # no answer.
            shutil.rmtree(folder, ignore_errors=True)
            self.close_connection = True
            return None
        except (ValueError, UnicodeDecodeError, OSError) as error:
            shutil.rmtree(folder, ignore_errors=True)
            return self.reply(400, {'error': f'bad upload: {error}'})

        job = self.server.jobs.start(folder, settings)
        return self.reply(200, {'job': job['id']})

    def do_DELETE(self):
        path = urllib.parse.urlsplit(self.path).path
        if not self.permitted(token=True):
            return self.reply(403, {'error': 'forbidden'})

        parts = path.split('/')
        found = len(parts) == 4 and parts[:3] == ['', 'api', 'videos']
        if not found or not self.server.jobs.cancel(parts[3]):
            return self.reply(404, {'error': 'not found'})
        return self.reply(200, {})

    def permitted(self, token, sent=None):
        host = self.headers.get('Host')
        origin = self.headers.get('Origin')
        if not allowed(host, origin, self.server.server_address[1]):
            return False
        if not token:
            return True
        sent = sent if sent is not None else \
            self.headers.get('X-Photoloft-Token', '')
        return secrets.compare_digest(sent, self.server.token)

    # Files and thumbnails come only of photos and videos, judged by the
    # name the path resolves to. A page that stops reading, as one
    # leaving a folder of thumbnails does, gets nothing more; a drive
    # pulled out half way through a file ends the connection, the answer
    # having started.
    def drive_request(self, path, query):
        self.answered = False
        drive = query.get('drive', [''])[0]
        inner = query.get('path', [''])[0]
        found = drive_path(self.server.media, drive, inner)
        kind = path[len('/api/drive/'):]
        folder = found and os.path.isdir(found)
        media = found and not folder and is_media(found)
        try:
            if kind == 'list' and folder:
                return self.reply(200, listing(found, inner.strip('/')))
            if kind == 'walk' and folder:
                return self.reply(200, walk(found, inner.strip('/')))
            if kind == 'file' and media:
                return self.send_file(found)
            if kind == 'thumb' and media:
                return self.send_thumb(found)
        except ConnectionError:
            self.close_connection = True
            return None
        except OSError:
            if self.answered:
                self.close_connection = True
                return None
        return self.reply(404, {'error': 'not found'})

    def send_response(self, *args):
        self.answered = True
        super().send_response(*args)

    def send_file(self, path):
        size = os.path.getsize(path)
        try:
            part = byte_range(self.headers.get('Range'), size)
        except ValueError:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None

        start, end = part or (0, size)
        with open(path, 'rb') as source:
            source.seek(start)
            self.send_response(206 if part else 200)
            if part:
                self.send_header('Content-Range',
                                 f'bytes {start}-{end - 1}/{size}')
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(end - start))
            self.end_headers()
            left = end - start
            while left > 0:
                chunk = source.read(min(CHUNK, left))
                if not chunk:
                    raise OSError('the file ended early')
                self.wfile.write(chunk)
                left -= len(chunk)
        return None

    def send_thumb(self, path):
        data = self.server.thumbs.get(path)
        if not data:
            return self.reply(404, {'error': 'no thumbnail'})
        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return None

    def receive(self, path, remaining):
        with open(path, 'wb') as out:
            while remaining > 0:
                chunk = self.rfile.read(min(CHUNK, remaining))
                if not chunk:
                    raise ConnectionAbortedError('upload ended early')
                out.write(chunk)
                remaining -= len(chunk)

    def send_result(self, job):
        path = job['folder'] / 'output.mp4'
        self.send_response(200)
        self.send_header('Content-Type', 'video/mp4')
        self.send_header('Content-Length', str(path.stat().st_size))
        self.end_headers()
        with open(path, 'rb') as source:
            shutil.copyfileobj(source, self.wfile, CHUNK)
        self.server.jobs.finish(job['id'])

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def status(job):
    return {
        'state': job['state'],
        'progress': job['progress'],
        'error': job['error']
    }


def make_server(port, media=None):
    handler = functools.partial(Handler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    server.token = secrets.token_urlsafe(24)
    server.jobs = Jobs()
    server.media = media or default_media()
    server.thumbs = Thumbs()
    return server


if __name__ == '__main__':
    import sys

    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    make_server(port).serve_forever()
