#!/usr/bin/env python3

# Tests for serve.py. Run with: python3 -m unittest scripts/test_serve.py

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import serve  # noqa: E402

FIXTURES = pathlib.Path(__file__).resolve().parent.parent / 'test' / 'fixtures'
HAS_FFMPEG = shutil.which('ffmpeg') is not None

GOOD = {
    'rotate': 0,
    'flip': False,
    'angle': 0,
    'crop': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
    'shortSide': 720,
    'crf': 20,
    'creationTime': None
}


def lut(size=33, change=lambda r, g, b: (r, g, b)):
    lines = [f'LUT_3D_SIZE {size}']
    for b in range(size):
        for g in range(size):
            for r in range(size):
                step = size - 1
                values = change(r / step, g / step, b / step)
                lines.append(' '.join(f'{v:.6f}' for v in values))
    return '\n'.join(lines) + '\n'


def probe(path):
    args = ['ffprobe', '-v', 'error', '-show_entries',
            'stream=codec_type,width,height', '-of', 'json', str(path)]
    return json.loads(subprocess.check_output(args))['streams']


def first_pixel(path):
    args = ['ffmpeg', '-v', 'error', '-i', str(path), '-frames:v', '1',
            '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgb24',
            '-f', 'rawvideo', '-']
    data = subprocess.check_output(args)
    return list(data[:3])


class Settings(unittest.TestCase):
    def test_accepts_valid_settings(self):
        self.assertEqual(serve.parse_settings(GOOD)['shortSide'], 720)

    def test_rejects_bad_values(self):
        bad = [
            {'rotate': 45},
            {'angle': 50},
            {'shortSide': 999},
            {'crf': 'x'},
            {'flip': 'yes'},
            {'crop': {'x': 0.5, 'y': 0, 'w': 0.8, 'h': 1}},
            {'crop': {'x': 0, 'y': 0, 'w': 0, 'h': 1}},
            {'creationTime': '2026-05-31 15:31'},
            {'creationTime': 'x"; rm -rf /'}
        ]
        for change in bad:
            with self.assertRaises(ValueError, msg=change):
                serve.parse_settings({**GOOD, **change})

    def test_rejects_unknown_keys(self):
        with self.assertRaises(ValueError):
            serve.parse_settings({**GOOD, 'filter': 'movie=/etc/passwd'})


class Lut(unittest.TestCase):
    def test_accepts_a_table_of_numbers(self):
        self.assertTrue(serve.parse_lut(lut()).startswith('LUT_3D_SIZE 33'))

    def test_rejects_anything_else(self):
        with self.assertRaises(ValueError):
            serve.parse_lut(lut().replace('0.000000', 'movie=x', 1))
        with self.assertRaises(ValueError):
            serve.parse_lut(lut().replace('0.000000', '2.5', 1))
        with self.assertRaises(ValueError):
            serve.parse_lut(lut(size=17))


class Filters(unittest.TestCase):
    def test_colour_and_scale_only_by_default(self):
        chain = serve.build_filters(GOOD, '/tmp/x/lut.cube')
        self.assertIn('lut3d=file=/tmp/x/lut.cube', chain)
        self.assertIn('min(720,ih)', chain)
        self.assertNotIn('transpose', chain)
        self.assertNotIn('rotate=', chain)
        self.assertNotIn('crop=', chain)

    def test_geometry_in_order(self):
        settings = {
            **GOOD, 'rotate': 90, 'flip': True, 'angle': 10,
            'crop': {'x': 0.1, 'y': 0.2, 'w': 0.5, 'h': 0.6}
        }
        chain = serve.build_filters(settings, '/tmp/x/lut.cube')
        steps = ['lut3d', 'transpose=1', 'hflip', 'rotate=', 'crop=', 'min(']
        positions = [chain.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions))

    def test_original_size_keeps_dimensions_even(self):
        chain = serve.build_filters({**GOOD, 'shortSide': 0}, '/l.cube')
        self.assertNotIn('min(', chain)
        self.assertIn('trunc(iw/2)*2', chain)


class Guard(unittest.TestCase):
    def test_allows_the_page_itself(self):
        self.assertTrue(serve.allowed('127.0.0.1:47321', None, 47321))
        origin = 'http://127.0.0.1:47321'
        self.assertTrue(serve.allowed('127.0.0.1:47321', origin, 47321))

    def test_refuses_other_sites_and_rebinding(self):
        site = 'http://evil.example'
        self.assertFalse(serve.allowed('127.0.0.1:47321', site, 47321))
        self.assertFalse(serve.allowed('evil.example:47321', None, 47321))


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg missing')
class Export(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.dir)

    def export(self, source, settings, table):
        lut_path = self.dir / 'lut.cube'
        lut_path.write_text(table)
        out = self.dir / 'out.mp4'
        serve.export_video(FIXTURES / source, out, settings, lut_path)
        return out

    def test_applies_the_colour_table_and_size(self):
        brighter = lut(change=lambda r, g, b: (min(1, r + 0.2), g, b))
        out = self.export('flat.mp4', {**GOOD, 'shortSide': 24}, brighter)
        video = [s for s in probe(out) if s['codec_type'] == 'video'][0]
        self.assertEqual((video['width'], video['height']), (32, 24))
        expected = [0x96 + 51, 0x78, 0x60]
        for got, want in zip(first_pixel(out), expected):
            self.assertLessEqual(abs(got - want), 4)

    def test_writes_a_corrected_recording_time(self):
        settings = {**GOOD, 'creationTime': '2026-05-31T15:31:00.000Z'}
        out = self.export('clip.mp4', settings, lut())
        args = ['ffprobe', '-v', 'error', '-show_entries',
                'format_tags=creation_time', '-of', 'csv=p=0', str(out)]
        tag = subprocess.check_output(args).decode().strip()
        self.assertTrue(tag.startswith('2026-05-31T15:31:00'), tag)

    def test_keeps_phone_rotation_and_sound_without_upscaling(self):
        out = self.export('VID_20240108_093000.mp4', GOOD, lut())
        streams = probe(out)
        video = [s for s in streams if s['codec_type'] == 'video'][0]
        self.assertEqual((video['width'], video['height']), (240, 320))
        self.assertIn('audio', [s['codec_type'] for s in streams])


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg missing')
class Api(unittest.TestCase):
    def setUp(self):
        self.server = serve.make_server(0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def call(self, path, data=None, headers=None):
        url = f'http://127.0.0.1:{self.port}{path}'
        request = urllib.request.Request(url, data=data, headers=headers or {})
        with urllib.request.urlopen(request) as response:
            return response.read()

    def test_exports_through_the_api(self):
        token = json.loads(self.call('/api/token'))['token']
        table = lut().encode()
        body = table + (FIXTURES / 'clip.mp4').read_bytes()
        headers = {
            'X-Lightbox-Token': token,
            'X-Lightbox-Settings': json.dumps(GOOD),
            'X-Lightbox-Lut-Length': str(len(table))
        }
        job = json.loads(self.call('/api/videos', body, headers))['job']

        status = {}
        for _ in range(100):
            status = json.loads(self.call(f'/api/videos/{job}', None, headers))
            if status['state'] != 'running':
                break
            time.sleep(0.1)
        self.assertEqual(status['state'], 'done', status)

        result = self.call(f'/api/videos/{job}/result', None, headers)
        out = pathlib.Path(tempfile.mkdtemp()) / 'out.mp4'
        out.write_bytes(result)
        self.assertEqual(probe(out)[0]['codec_type'], 'video')

    def test_refuses_requests_without_the_token(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.call('/api/videos', b'x', {'X-Lightbox-Token': 'wrong'})
        self.assertEqual(caught.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
