#!/usr/bin/env python3

# Serves Lightbox's built page to this machine only and exports videos
# with ffmpeg. A fixed local address gives Lightbox its own browser
# origin, so Chromium can keep folder access across restarts. No
# caching, so a rebuild shows up on the next start.
#
# The video API only answers the Lightbox page itself (Host and Origin
# checks plus a per-start token), never reads paths from requests, and
# builds every ffmpeg filter from validated numbers.

import functools
import http.server
import json
import math
import pathlib
import re
import secrets
import shutil
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
    'rotate', 'flip', 'angle', 'crop', 'shortSide', 'crf', 'creationTime'
}
CREATION_TIME = re.compile(
    r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$')


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

    return {
        'rotate': rotate,
        'flip': raw['flip'],
        'angle': angle,
        'crop': {'x': x, 'y': y, 'w': w, 'h': h},
        'shortSide': raw['shortSide'],
        'crf': crf,
        'creationTime': created
    }


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


def ffmpeg_args(source, target, settings, lut_path):
    return [
        'ffmpeg', '-hide_banner', '-nostdin', '-y', '-i', str(source),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', build_filters(settings, lut_path),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', str(settings['crf']),
        '-colorspace', 'bt709', '-color_primaries', 'bt709',
        '-color_trc', 'bt709',
        '-c:a', 'aac', '-b:a', '160k',
        '-map_metadata', '0', *creation(settings),
        '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats', '-loglevel', 'error',
        str(target)
    ]


def creation(settings):
    created = settings['creationTime']
    return ['-metadata', f'creation_time={created}'] if created else []


def duration_of(path):
    args = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1', str(path)]
    try:
        return float(subprocess.check_output(args).strip() or 0)
    except (subprocess.CalledProcessError, ValueError):
        return 0.0


def export_video(source, target, settings, lut_path, on_progress=None):
    total = duration_of(source)
    args = ffmpeg_args(source, target, settings, lut_path)
    with subprocess.Popen(args, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True) as process:
        for line in process.stdout:
            if on_progress and total and line.startswith('out_time_us='):
                done = int(line.split('=')[1] or 0) / 1e6
                on_progress(min(1.0, done / total))
        error = process.stderr.read()
    if process.returncode != 0:
        raise RuntimeError(error.strip() or 'ffmpeg failed')


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

        try:
            export_video(folder / 'input', folder / 'output.mp4', settings,
                         folder / 'lut.cube', progress)
            job['state'] = 'done'
            job['progress'] = 1.0
        except (RuntimeError, OSError) as error:
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
                json.loads(self.headers.get('X-Lightbox-Settings', '')))
            lut_length = int(self.headers.get('X-Lightbox-Lut-Length', ''))
            length = int(self.headers.get('Content-Length', ''))
        except ValueError as error:
            return self.reply(400, {'error': f'bad request: {error}'})
        if not 0 < lut_length < length <= MAX_UPLOAD:
            return self.reply(400, {'error': 'bad length'})

        folder = pathlib.Path(tempfile.mkdtemp(prefix='lightbox-'))
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
        sent = self.headers.get('X-Lightbox-Token', '')
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
