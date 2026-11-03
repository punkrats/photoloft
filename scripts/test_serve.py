#!/usr/bin/env python3

# Tests for serve.py. Run with: python3 -m unittest scripts/test_serve.py

import json
import pathlib
import shutil
import struct
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
HAS_EXIFTOOL = shutil.which('exiftool') is not None

GOOD = {
    'rotate': 0,
    'flip': False,
    'angle': 0,
    'crop': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
    'shortSide': 720,
    'crf': 20,
    'creationTime': None,
    'stripGps': True,
    'meta': {}
}

INFO = {
    'title': 'Café ©',
    'description': 'Sunset at Matira',
    'keywords': ['beach', 'Bora Bora'],
    'author': 'Zoë Name',
    'copyright': '(c) 2026 Zoë Name'
}
PLACE = {'lat': -16.5004, 'lon': -151.7415}


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


def tags(path):
    args = ['ffprobe', '-v', 'error', '-show_entries', 'format_tags',
            '-of', 'json', str(path)]
    return json.loads(subprocess.check_output(args))['format'].get('tags', {})


# The payload of the box at the end of a path such as moov/udta.
def payload(data, *path):
    for kind in path:
        found = serve.first(data, 0, len(data), kind)
        if not found:
            return None
        _, _, start, end = found
        data = data[start:end]
    return data


# The ISO 6709 text of moov/udta/©xyz, read the way Android does.
def xyz(path):
    entry = payload(path.read_bytes(), b'moov', b'udta', b'\xa9xyz')
    if entry is None:
        return None
    length = struct.unpack('>H', entry[:2])[0]
    return entry[4:4 + length].decode('ascii')


def frames(path):
    args = ['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0',
            '-f', 'framemd5', '-']
    return subprocess.check_output(args).decode()


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

    def test_requires_location_and_info_settings(self):
        for key in ('stripGps', 'meta'):
            settings = {k: v for k, v in GOOD.items() if k != key}
            with self.assertRaises(ValueError, msg=key):
                serve.parse_settings(settings)

    def test_accepts_info(self):
        meta = {**INFO, 'location': PLACE}
        parsed = serve.parse_settings({**GOOD, 'meta': meta})
        self.assertEqual(parsed['meta'], meta)
        self.assertNotIn('location', serve.parse_settings(GOOD)['meta'])
        removed = serve.parse_settings({**GOOD, 'meta': {'location': None}})
        self.assertIsNone(removed['meta']['location'])

    def test_cleans_and_caps_info_texts(self):
        meta = {
            'title': '  a\x00b\nc\x07 ',
            'description': 'd' * 3000,
            'author': 'x\ud800y',
            'keywords': [' sea ', '', 'sea', 'k' * 150, *map(str, range(60))]
        }
        parsed = serve.parse_settings({**GOOD, 'meta': meta})['meta']
        self.assertEqual(parsed['title'], 'ab c')
        self.assertEqual(parsed['description'], 'd' * 2000)
        self.assertEqual(parsed['author'], 'xy')
        self.assertEqual(parsed['keywords'][:2], ['sea', 'k' * 100])
        self.assertEqual(len(parsed['keywords']), 50)

    def test_rejects_bad_info(self):
        bad = [
            {'stripGps': 'yes'},
            {'meta': None},
            {'meta': {'rating': 5}},
            {'meta': {'title': 5}},
            {'meta': {'keywords': 'a, b'}},
            {'meta': {'keywords': ['a', 1]}},
            {'meta': {'location': {'lat': 91, 'lon': 0}}},
            {'meta': {'location': {'lat': 0, 'lon': -181}}},
            {'meta': {'location': {'lat': True, 'lon': 0}}},
            {'meta': {'location': {'lat': 0, 'lon': 0, 'alt': 3}}},
            {'meta': {'location': '+41.9+012.5/'}}
        ]
        for change in bad:
            with self.assertRaises(ValueError, msg=change):
                serve.parse_settings({**GOOD, **change})


class Place(unittest.TestCase):
    def test_writes_iso_6709_degrees(self):
        self.assertEqual(serve.iso6709(PLACE), '-16.5004-151.7415/')
        place = {'lat': 5.1, 'lon': 12.5}
        self.assertEqual(serve.iso6709(place), '+05.1000+012.5000/')

    def test_reads_iso_6709_degrees(self):
        self.assertEqual(serve.parse_iso6709('+41.900+012.500/'),
                         {'lat': 41.9, 'lon': 12.5})
        self.assertEqual(serve.parse_iso6709('-16.5004-151.7415+30.000/'),
                         PLACE)
        for text in ('', '+4154.0+01230.0/', '+95.0+012.0/', 'x'):
            self.assertIsNone(serve.parse_iso6709(text), text)

    def test_adds_user_data_and_moves_chunk_offsets(self):
        frame = b'frame data'

        def movie(offset):
            table = serve.box(b'stco', struct.pack('>III', 0, 1, offset))
            for kind in (b'stbl', b'minf', b'mdia', b'trak', b'moov'):
                table = serve.box(kind, table)
            return serve.box(b'ftyp', b'isom') + table + \
                serve.box(b'mdat', frame)

        folder = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder)
        path = folder / 'tiny.mp4'
        path.write_bytes(movie(len(movie(0)) - len(frame)))
        serve.add_place(path, '+41.9000+012.5000/')

        self.assertEqual(xyz(path), '+41.9000+012.5000/')
        data = path.read_bytes()
        chunks = payload(data, b'moov', b'trak', b'mdia', b'minf', b'stbl',
                         b'stco')
        offset = struct.unpack('>I', chunks[8:12])[0]
        self.assertEqual(data[offset:offset + len(frame)], frame)


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

    def test_writes_info_texts(self):
        settings = {**GOOD, 'meta': INFO}
        written = tags(self.export('clip.mp4', settings, lut()))
        self.assertEqual(written['title'], 'Café ©')
        self.assertEqual(written['description'], 'Sunset at Matira')
        self.assertEqual(written['comment'], 'Sunset at Matira')
        self.assertEqual(written['keywords'], 'beach, Bora Bora')
        self.assertEqual(written['artist'], 'Zoë Name')
        self.assertEqual(written['copyright'], '(c) 2026 Zoë Name')

    def test_removes_emptied_info_texts(self):
        source = self.export('clip.mp4', {**GOOD, 'meta': INFO}, lut())
        kept = self.dir / 'kept.mp4'
        source.rename(kept)
        settings = {**GOOD, 'meta': {'title': '', 'author': 'New'}}
        written = tags(self.export(kept, settings, lut()))
        self.assertNotIn('title', written)
        self.assertEqual(written['artist'], 'New')
        self.assertEqual(written['copyright'], '(c) 2026 Zoë Name')

    def test_removes_camera_locations(self):
        out = self.export('located.mp4', GOOD, lut())
        self.assertFalse([k for k in tags(out) if 'location' in k])
        self.assertIsNone(xyz(out))

    def test_keeps_camera_locations_when_asked(self):
        out = self.export('located.mp4', {**GOOD, 'stripGps': False}, lut())
        self.assertEqual(xyz(out), '+41.9000+012.5000/')
        self.assertTrue(tags(out)['location'].startswith('+41.9'))

    def test_writes_a_set_location_in_place_of_the_camera_one(self):
        for strip in (True, False):
            meta = {'location': PLACE}
            settings = {**GOOD, 'stripGps': strip, 'meta': meta}
            out = self.export('located.mp4', settings, lut())
            self.assertEqual(xyz(out), '-16.5004-151.7415/')
            self.assertEqual(serve.parse_iso6709(tags(out)['location']),
                             {'lat': -16.5004, 'lon': -151.7415})

    def test_removes_every_location_for_none(self):
        settings = {**GOOD, 'stripGps': False, 'meta': {'location': None}}
        out = self.export('located.mp4', settings, lut())
        self.assertFalse([k for k in tags(out) if 'location' in k])
        self.assertIsNone(xyz(out))

    def test_adding_a_location_keeps_every_frame(self):
        plain = self.export('clip.mp4', GOOD, lut())
        before = frames(plain)
        serve.add_place(plain, '-16.5004-151.7415/')
        self.assertEqual(xyz(plain), '-16.5004-151.7415/')
        self.assertEqual(frames(plain), before)

    @unittest.skipUnless(HAS_EXIFTOOL, 'exiftool missing')
    def test_passes_exiftool_validation(self):
        meta = {**INFO, 'location': PLACE}
        out = self.export('located.mp4', {**GOOD, 'meta': meta}, lut())
        args = ['exiftool', '-j', '-a', '-n', '-G1', '-All', '-validate',
                '-warning', str(out)]
        info = json.loads(subprocess.check_output(args))[0]
        self.assertEqual(info['ExifTool:Validate'], '0 0 0', info)
        self.assertEqual(info['ItemList:Title'], 'Café ©')
        self.assertEqual(info['ItemList:Artist'], 'Zoë Name')
        self.assertEqual(info['UserData:GPSCoordinates'],
                         '-16.5004 -151.7415')

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

    # Runs an export the way the page does and returns the result file.
    def export(self, settings):
        token = json.loads(self.call('/api/token'))['token']
        table = lut().encode()
        body = table + (FIXTURES / 'clip.mp4').read_bytes()
        headers = {
            'X-Lightbox-Token': token,
            'X-Lightbox-Settings': settings,
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

        folder = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder)
        out = folder / 'out.mp4'
        out.write_bytes(self.call(f'/api/videos/{job}/result', None, headers))
        return out

    def test_exports_through_the_api(self):
        out = self.export(json.dumps(GOOD))
        self.assertEqual(probe(out)[0]['codec_type'], 'video')

    def test_reads_info_with_escaped_characters_from_the_header(self):
        settings = json.dumps({**GOOD, 'meta': {'title': 'Café ©'}})
        self.assertIn('Caf\\u00e9 \\u00a9', settings)
        self.assertEqual(tags(self.export(settings))['title'], 'Café ©')

    def test_refuses_requests_without_the_token(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.call('/api/videos', b'x', {'X-Lightbox-Token': 'wrong'})
        caught.exception.close()
        self.assertEqual(caught.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
