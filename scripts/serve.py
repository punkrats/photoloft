#!/usr/bin/env python3

# Serves Photoloft's built page to this machine only and exports videos
# with ffmpeg. A fixed local address gives Photoloft its own browser
# origin, so Chromium can keep folder access across restarts. No
# caching, so a rebuild shows up on the next start.
#
# The video API only answers the Photoloft page itself (Host and Origin
# checks plus a per-start token), never reads paths from requests,
# builds every ffmpeg filter from validated numbers, and hands info
# texts to ffmpeg as single cleaned arguments.

import functools
import http.server
import json
import math
import mmap
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
    'rotate', 'flip', 'angle', 'crop', 'shortSide', 'crf', 'creationTime',
    'stripGps', 'meta'
}
CREATION_TIME = re.compile(
    r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$')

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
    crf = raw['crf']
    if not isinstance(crf, int) or isinstance(crf, bool) or not 14 <= crf <= 32:
        raise ValueError('crf')

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
        'crf': crf,
        'creationTime': created,
        'stripGps': raw['stripGps'],
        'meta': parse_meta(raw['meta'])
    }


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


def ffmpeg_args(source, target, settings, lut_path, place):
    return [
        'ffmpeg', '-hide_banner', '-nostdin', '-y', '-i', str(source),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', build_filters(settings, lut_path),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', str(settings['crf']),
        '-colorspace', 'bt709', '-color_primaries', 'bt709',
        '-color_trc', 'bt709',
        '-c:a', 'aac', '-b:a', '160k',
        '-map_metadata', '0', *metadata(settings, place),
        '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats', '-loglevel', 'error',
        str(target)
    ]


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


def duration_of(path):
    args = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1', str(path)]
    try:
        return float(subprocess.check_output(args).strip() or 0)
    except (subprocess.CalledProcessError, ValueError):
        return 0.0


def export_video(source, target, settings, lut_path, on_progress=None):
    total = duration_of(source)
    place = place_of(settings, source)
    args = ffmpeg_args(source, target, settings, lut_path, place)
    with subprocess.Popen(args, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True) as process:
        for line in process.stdout:
            if on_progress and total and line.startswith('out_time_us='):
                done = int(line.split('=')[1] or 0) / 1e6
                on_progress(min(1.0, done / total))
        error = process.stderr.read()
    if process.returncode != 0:
        raise RuntimeError(error.strip() or 'ffmpeg failed')
    if place:
        add_place(target, place)


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
            'started': time.time()
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

        # Any failure ends the job, so the page stops waiting for it.
        try:
            export_video(folder / 'input', folder / 'output.mp4', settings,
                         folder / 'lut.cube', progress)
            job['state'] = 'done'
            job['progress'] = 1.0
        except Exception as error:
            job['state'] = 'failed'
            job['error'] = str(error)[-500:]

    def get(self, job_id):
        with self.lock:
            return self.items.get(job_id)

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


# ─── HTTP ────────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith('/api/'):
            return super().do_GET()
        if not self.permitted(token=path != '/api/token'):
            return self.reply(403, {'error': 'forbidden'})

        if path == '/api/token':
            return self.reply(200, {'token': self.server.token})

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
        except (ValueError, UnicodeDecodeError, OSError) as error:
            shutil.rmtree(folder, ignore_errors=True)
            return self.reply(400, {'error': f'bad upload: {error}'})

        job = self.server.jobs.start(folder, settings)
        return self.reply(200, {'job': job['id']})

    def permitted(self, token):
        host = self.headers.get('Host')
        origin = self.headers.get('Origin')
        if not allowed(host, origin, self.server.server_address[1]):
            return False
        if not token:
            return True
        sent = self.headers.get('X-Photoloft-Token', '')
        return secrets.compare_digest(sent, self.server.token)

    def receive(self, path, remaining):
        with open(path, 'wb') as out:
            while remaining > 0:
                chunk = self.rfile.read(min(CHUNK, remaining))
                if not chunk:
                    raise OSError('upload ended early')
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


def make_server(port):
    handler = functools.partial(Handler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    server.token = secrets.token_urlsafe(24)
    server.jobs = Jobs()
    return server


if __name__ == '__main__':
    import sys

    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    make_server(port).serve_forever()
