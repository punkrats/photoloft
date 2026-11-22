#!/usr/bin/env python3

# Tests for serve.py. Run with: python3 -m unittest scripts/test_serve.py

import json
import os
import pathlib
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest import mock

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
    'rate': {'crf': 20},
    'creationTime': None,
    'stripGps': True,
    'meta': {},
    'trim': None
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


# Every frame as a small grey image, for telling frames apart.
def thumbnails(path):
    args = ['ffmpeg', '-v', 'error', '-i', str(path), '-vf',
            'scale=80:60,format=gray', '-f', 'rawvideo', '-']
    data = subprocess.check_output(args)
    size = 80 * 60
    return [data[at:at + size] for at in range(0, len(data), size)]


def nearest(frame, candidates):
    def distance(other):
        return sum(abs(a - b) for a, b in zip(frame, other))
    scores = [distance(other) for other in candidates]
    return scores.index(min(scores))


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

    def test_accepts_a_quality_or_a_bitrate(self):
        rates = [{'crf': 14}, {'crf': 32}, {'kbps': 100, 'passes': 1},
                 {'kbps': 100000, 'passes': 2}]
        for rate in rates:
            parsed = serve.parse_settings({**GOOD, 'rate': rate})
            self.assertEqual(parsed['rate'], rate)

    def test_rejects_bad_rates(self):
        bad = [
            None,
            {},
            {'crf': 'x'},
            {'crf': 13},
            {'crf': 33},
            {'crf': 20.5},
            {'crf': True},
            {'kbps': 8000},
            {'kbps': 99, 'passes': 1},
            {'kbps': 100001, 'passes': 1},
            {'kbps': '8000', 'passes': 1},
            {'kbps': 8000, 'passes': 3},
            {'kbps': 8000, 'passes': True},
            {'crf': 20, 'kbps': 8000, 'passes': 1}
        ]
        for rate in bad:
            with self.assertRaises(ValueError, msg=rate):
                serve.parse_settings({**GOOD, 'rate': rate})

    def test_requires_location_info_and_trim_settings(self):
        for key in ('stripGps', 'meta', 'trim'):
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

    def test_accepts_a_trim(self):
        trim = {'start': 0.4, 'end': 1.6}
        parsed = serve.parse_settings({**GOOD, 'trim': trim})
        self.assertEqual(parsed['trim'], trim)
        self.assertIsNone(serve.parse_settings(GOOD)['trim'])

    def test_rejects_bad_trims(self):
        bad = [
            {'start': -0.1, 'end': 1},
            {'start': 1, 'end': 1},
            {'start': 1, 'end': 1.0004},
            {'start': 2, 'end': 1},
            {'start': '0', 'end': 1},
            {'start': True, 'end': 1},
            {'start': 0, 'end': float('inf')},
            {'start': 0},
            {'start': 0, 'end': 1, 'step': 1},
            [0, 1],
            '0.4-1.6'
        ]
        for trim in bad:
            with self.assertRaises(ValueError, msg=trim):
                serve.parse_settings({**GOOD, 'trim': trim})

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


class Commands(unittest.TestCase):
    def commands(self, rate):
        settings = {**GOOD, 'rate': rate}
        target = pathlib.Path('/job/output.mp4')
        return serve.ffmpeg_commands('in.mp4', target, settings, 'l.cube',
                                     None)

    def test_encodes_a_constant_quality_once(self):
        [args] = self.commands({'crf': 24})
        self.assertIn('-crf', args)
        self.assertEqual(args[args.index('-crf') + 1], '24')
        self.assertNotIn('-b:v', args)
        self.assertNotIn('-pass', args)
        self.assertEqual(args[-1], '/job/output.mp4')

    def test_encodes_a_bitrate_once(self):
        [args] = self.commands({'kbps': 8000, 'passes': 1})
        self.assertEqual(args[args.index('-b:v') + 1], '8000k')
        self.assertNotIn('-crf', args)
        self.assertNotIn('-pass', args)

    def test_encodes_a_bitrate_in_two_passes(self):
        first, second = self.commands({'kbps': 2500, 'passes': 2})
        for args, number in ((first, '1'), (second, '2')):
            self.assertEqual(args[args.index('-b:v') + 1], '2500k')
            self.assertEqual(args[args.index('-pass') + 1], number)
            log = args[args.index('-passlogfile') + 1]
            self.assertEqual(log, '/job/passlog')
            self.assertEqual(args[args.index('-progress') + 1], 'pipe:1')

        # The first pass only analyses the video and writes no file.
        self.assertEqual(first[-3:], ['-f', 'null', os.devnull])
        self.assertNotIn('0:a:0?', first)
        self.assertNotIn('-metadata', first)
        self.assertEqual(second[-1], '/job/output.mp4')
        self.assertIn('0:a:0?', second)
        self.assertEqual(first[first.index('-vf') + 1],
                         second[second.index('-vf') + 1])


class Cut(unittest.TestCase):
    def args(self, trim):
        settings = {**GOOD, 'trim': trim}
        target = pathlib.Path('out.mp4')
        commands = serve.ffmpeg_commands('in.mp4', target, settings, 'l.cube',
                                         None)
        return commands[-1]

    def test_reads_the_whole_input_without_a_trim(self):
        args = self.args(None)
        self.assertNotIn('-ss', args)
        self.assertNotIn('-t', args)

    def test_seeks_accurately_into_the_input(self):
        args = self.args({'start': 0.4, 'end': 1.6})
        cut = args[args.index('-accurate_seek'):args.index('-i')]
        self.assertEqual(cut, ['-accurate_seek', '-ss', '0.400', '-t', '1.200'])


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg missing')
class Duration(unittest.TestCase):
    def test_measures_the_whole_file_or_the_trimmed_part(self):
        clip = FIXTURES / 'clip.mp4'
        self.assertAlmostEqual(serve.duration_of(clip), 2.0, places=2)
        trim = {'start': 0.4, 'end': 1.6}
        self.assertAlmostEqual(serve.duration_of(clip, trim), 1.2, places=2)

    def test_ends_a_trim_past_the_file_at_its_end(self):
        trim = {'start': 1.5, 'end': 9}
        length = serve.duration_of(FIXTURES / 'clip.mp4', trim)
        self.assertAlmostEqual(length, 0.5, places=2)


class Progress(unittest.TestCase):
    def test_reads_the_share_done_from_timed_reports(self):
        self.assertEqual(serve.progress_share('out_time_us=500000\n', 2), 0.25)
        self.assertEqual(serve.progress_share('out_time_us=3000000\n', 2), 1)

    def test_skips_untimed_reports_and_other_lines(self):
        lines = ['out_time_us=N/A\n', 'out_time_us=\n', 'out_time_ms=500000\n',
                 'progress=continue\n', 'bitrate=N/A\n']
        for line in lines:
            self.assertIsNone(serve.progress_share(line, 2), line)
        self.assertIsNone(serve.progress_share('out_time_us=500000\n', 0))


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

    def test_cuts_the_trimmed_part_to_the_frame(self):
        trim = {'start': 0.4, 'end': 1.6}
        out = self.export('clip.mp4', {**GOOD, 'trim': trim}, lut())
        source = thumbnails(FIXTURES / 'clip.mp4')
        cut = thumbnails(out)
        self.assertEqual(len(cut), 30)
        self.assertEqual(nearest(cut[0], source), 10)
        self.assertEqual(nearest(cut[-1], source), 39)
        lengths = subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_entries', 'stream=duration',
            '-of', 'csv=p=0', str(out)]).decode().split()
        for length in lengths:
            self.assertAlmostEqual(float(length), 1.2, delta=0.05)

    def test_encodes_two_passes_near_the_asked_bitrate(self):
        rate = {'kbps': 400, 'passes': 2}
        settings = {**GOOD, 'shortSide': 0, 'rate': rate}
        out = self.export('clip.mp4', settings, lut())
        args = ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0',
                str(out)]
        bitrate = int(subprocess.check_output(args).decode().strip())
        self.assertAlmostEqual(bitrate / 1000, 400, delta=120)
        source = thumbnails(FIXTURES / 'clip.mp4')
        self.assertEqual(len(thumbnails(out)), len(source))

    def test_counts_progress_against_the_trimmed_length(self):
        shares = []
        lut_path = self.dir / 'lut.cube'
        lut_path.write_text(lut())
        settings = {**GOOD, 'trim': {'start': 0.4, 'end': 1.6}}
        serve.export_video(FIXTURES / 'clip.mp4', self.dir / 'out.mp4',
                           settings, lut_path, shares.append)
        self.assertGreater(max(shares), 0.99)

    def test_keeps_phone_rotation_and_sound_without_upscaling(self):
        out = self.export('VID_20240108_093000.mp4', GOOD, lut())
        streams = probe(out)
        video = [s for s in streams if s['codec_type'] == 'video'][0]
        self.assertEqual((video['width'], video['height']), (240, 320))
        self.assertIn('audio', [s['codec_type'] for s in streams])


# export_video with a Python script in place of ffmpeg, writing what
# ffmpeg wrote for slow and damaged clips. ffprobe still measures the
# fixture.
@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg missing')
class FfmpegOutput(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)

    # Runs the export in a thread, so a stall fails the test instead of
    # hanging the suite. Returns the shares reported and the error.
    def export(self, *scripts):
        shares, outcome = [], []
        commands = [[sys.executable, '-c', script] for script in scripts]

        def run():
            try:
                serve.export_video(FIXTURES / 'clip.mp4', self.dir / 'out.mp4',
                                   GOOD, self.dir / 'lut.cube', shares.append)
                outcome.append(None)
            except Exception as error:
                outcome.append(error)

        with mock.patch.object(serve, 'ffmpeg_commands',
                               return_value=commands):
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            worker.join(20)
        self.assertFalse(worker.is_alive(), 'the export stalled')
        return shares, outcome[0]

    def test_keeps_the_last_share_over_untimed_reports(self):
        times = ['N/A', '500000', 'N/A', '1500000', '2000000']
        reports = ''.join(f'out_time_us={t}\nprogress=continue\n'
                          for t in times)
        shares, error = self.export(f'print({reports!r})')
        self.assertIsNone(error)
        self.assertEqual(shares, [0.25, 0.75, 1.0])

    def test_counts_each_of_two_passes_as_half(self):
        reports = ''.join(f'out_time_us={t}\nprogress=continue\n'
                          for t in ('1000000', '2000000'))
        shares, error = self.export(f'print({reports!r})',
                                    f'print({reports!r})')
        self.assertIsNone(error)
        self.assertEqual(shares, [0.25, 0.5, 0.75, 1.0])

    def test_reports_the_failing_pass_alone(self):
        script = '\n'.join([
            'import sys',
            "sys.stderr.write('pass one warning\\n')",
        ])
        failing = '\n'.join([
            'import sys',
            "sys.stderr.write('pass two broke\\n')",
            'sys.exit(1)'
        ])
        _, error = self.export(script, failing)
        self.assertEqual(str(error), 'pass two broke')

    def test_reads_more_errors_than_a_pipe_holds(self):
        script = '\n'.join([
            'import sys',
            "sys.stderr.write('[h264] error while decoding MB\\n' * 40000)",
            "sys.stderr.write('Conversion failed!\\n')",
            "print('out_time_us=N/A\\nprogress=end')",
            'sys.exit(1)'
        ])
        _, error = self.export(script)
        self.assertIsInstance(error, RuntimeError)
        last = str(error).splitlines()[-1]
        self.assertEqual(last, 'Conversion failed!')


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg missing')
class Job(unittest.TestCase):
    def test_removes_a_failed_jobs_files_and_keeps_its_error(self):
        folder = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        (folder / 'input').write_bytes(b'not a video')
        (folder / 'lut.cube').write_text(lut())

        job = serve.Jobs().start(folder, GOOD)
        for _ in range(200):
            if job['state'] != 'running':
                break
            time.sleep(0.05)
        self.assertEqual(job['state'], 'failed')
        self.assertIn('Invalid data', job['error'])
        self.assertFalse(folder.exists())

    def test_cancel_stops_ffmpeg_and_removes_the_job(self):
        folder = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        shutil.copy(FIXTURES / 'clip.mp4', folder / 'input')
        endless = '\n'.join([
            'import time',
            'while True:',
            "    print('out_time_us=N/A', flush=True)",
            '    time.sleep(0.05)'
        ])
        jobs = serve.Jobs()
        commands = [[sys.executable, '-c', endless]] * 2
        with mock.patch.object(serve, 'ffmpeg_commands',
                               return_value=commands):
            job = jobs.start(folder, GOOD)
            runner = job['runner']
            self.assertTrue(wait(lambda: runner.process is not None))
            process = runner.process

            self.assertTrue(jobs.cancel(job['id']))
            self.assertTrue(wait(lambda: jobs.get(job['id']) is None))
        self.assertIsNotNone(process.poll())
        self.assertIs(runner.process, process, 'a second pass started')
        self.assertFalse(folder.exists())

    def test_cancel_removes_a_finished_job(self):
        folder = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        shutil.copy(FIXTURES / 'clip.mp4', folder / 'input')
        jobs = serve.Jobs()
        with mock.patch.object(serve, 'ffmpeg_commands',
                               return_value=[[sys.executable, '-c', '']]):
            job = jobs.start(folder, GOOD)
            self.assertTrue(wait(lambda: job['state'] == 'done'))
        self.assertTrue(folder.exists())

        self.assertTrue(jobs.cancel(job['id']))
        self.assertIsNone(jobs.get(job['id']))
        self.assertFalse(folder.exists())
        self.assertFalse(jobs.cancel(job['id']))


class Runner(unittest.TestCase):
    def test_starts_nothing_once_stopped(self):
        runner = serve.Runner()
        runner.stop()
        with tempfile.TemporaryFile() as log:
            with self.assertRaises(RuntimeError):
                runner.start([sys.executable, '-c', ''], log)
        self.assertIsNone(runner.process)


def wait(condition, seconds=10):
    end = time.time() + seconds
    while time.time() < end:
        if condition():
            return True
        time.sleep(0.02)
    return False


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg missing')
class Api(unittest.TestCase):
    def setUp(self):
        self.server = serve.make_server(0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def call(self, path, data=None, headers=None, method=None):
        url = f'http://127.0.0.1:{self.port}{path}'
        request = urllib.request.Request(url, data=data, headers=headers or {},
                                         method=method)
        with urllib.request.urlopen(request) as response:
            return response.read()

    # The HTTP status a request ends with.
    def code(self, path, headers, method=None):
        try:
            self.call(path, None, headers, method)
        except urllib.error.HTTPError as error:
            error.close()
            return error.code
        return 200

    # Starts an export the way the page does; returns the job and the
    # headers that reach it.
    def start(self, settings):
        token = json.loads(self.call('/api/token'))['token']
        table = lut().encode()
        body = table + (FIXTURES / 'clip.mp4').read_bytes()
        headers = {
            'X-Photoloft-Token': token,
            'X-Photoloft-Settings': settings,
            'X-Photoloft-Lut-Length': str(len(table))
        }
        job = json.loads(self.call('/api/videos', body, headers))['job']
        return job, headers

    # Runs an export the way the page does and returns the result file.
    def export(self, settings):
        job, headers = self.start(settings)

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

    def test_exports_two_passes_through_the_api(self):
        rate = {'kbps': 500, 'passes': 2}
        out = self.export(json.dumps({**GOOD, 'rate': rate}))
        self.assertEqual(probe(out)[0]['codec_type'], 'video')

    def test_cancels_a_job_through_the_api(self):
        job, headers = self.start(json.dumps(GOOD))
        path = f'/api/videos/{job}'
        self.assertEqual(self.call(path, None, headers, 'DELETE'), b'{}')
        self.assertTrue(wait(lambda: self.code(path, headers) == 404))
        self.assertEqual(self.code(path, headers, 'DELETE'), 404)

    def test_refuses_requests_without_the_token(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.call('/api/videos', b'x', {'X-Photoloft-Token': 'wrong'})
        caught.exception.close()
        self.assertEqual(caught.exception.code, 403)

    # A cancelled upload ends the request: the server removes the upload
    # and sends no answer, which would only meet a closed connection.
    def test_drops_an_upload_the_page_stops_quietly(self):
        token = json.loads(self.call('/api/token'))['token']
        table = lut().encode()
        head = '\r\n'.join([
            'POST /api/videos HTTP/1.1',
            f'Host: 127.0.0.1:{self.port}',
            f'X-Photoloft-Token: {token}',
            f'X-Photoloft-Settings: {json.dumps(GOOD)}',
            f'X-Photoloft-Lut-Length: {len(table)}',
            f'Content-Length: {len(table) + 50_000_000}',
            '', ''
        ])

        made, raised, done = [], [], threading.Event()
        mkdtemp, post = tempfile.mkdtemp, serve.Handler.do_POST

        def making(**kwargs):
            made.append(mkdtemp(**kwargs))
            return made[-1]

        def posting(handler):
            try:
                post(handler)
            except Exception as error:
                raised.append(error)
            finally:
                done.set()

        with (mock.patch.object(serve.tempfile, 'mkdtemp', making),
              mock.patch.object(serve.Handler, 'do_POST', posting)):
            with socket.create_connection(('127.0.0.1', self.port)) as page:
                page.sendall(head.encode() + table + b'x' * 1_000_000)
            self.assertTrue(done.wait(10))
        self.assertEqual(raised, [])
        self.assertEqual(len(made), 1)
        self.assertFalse(pathlib.Path(made[0]).exists())

    def test_refuses_a_cancel_without_the_token(self):
        job, headers = self.start(json.dumps(GOOD))
        path = f'/api/videos/{job}'
        wrong = {'X-Photoloft-Token': 'wrong'}
        self.assertEqual(self.code(path, wrong, 'DELETE'), 403)
        self.assertEqual(self.code(path, headers), 200)


# ─── Drives ──────────────────────────────────────────────────────────

# A media folder with one drive, CARD, holding a camera's folders, a
# hidden folder, a cache folder and a file of another kind.
def media_folder(test):
    media = pathlib.Path(tempfile.mkdtemp())
    test.addCleanup(shutil.rmtree, media, ignore_errors=True)
    card = media / 'CARD'
    (card / 'DCIM' / '100TEST').mkdir(parents=True)
    (card / 'DCIM' / 'thumbs').mkdir()
    (card / '.Trashes').mkdir()
    (card / 'System Volume Information').mkdir()
    shutil.copy(FIXTURES / 'e2e-a.jpg', card / 'DCIM' / '100TEST' / 'P2.JPG')
    shutil.copy(FIXTURES / 'e2e-b.jpg', card / 'DCIM' / '100TEST' / 'P10.jpg')
    shutil.copy(FIXTURES / 'clip.mp4', card / 'DCIM' / '100TEST' / 'C1.MOV')
    shutil.copy(FIXTURES / 'e2e-c.jpg', card / 'DCIM' / 'thumbs' / 'T.jpg')
    shutil.copy(FIXTURES / 'e2e-d.jpg', card / '.Trashes' / 'D.jpg')
    (card / 'DCIM' / '100TEST' / 'notes.txt').write_text('mine')
    (card / 'DCIM' / '100TEST' / '._P2.JPG').write_text('mac')
    (media / '.hidden').mkdir()
    return media


class Drives(unittest.TestCase):
    def test_lists_the_folders_mounted_under_the_media_folder(self):
        media = media_folder(self)
        (media / 'STICK').mkdir()
        (media / 'stray.txt').write_text('x')
        self.assertEqual(serve.drives(media), ['CARD', 'STICK'])

    def test_lists_none_without_a_media_folder(self):
        self.assertEqual(serve.drives(pathlib.Path('/no/such/media')), [])


class DrivePath(unittest.TestCase):
    def setUp(self):
        self.media = media_folder(self)
        self.card = os.path.realpath(self.media / 'CARD')

    def test_finds_a_file_or_folder_on_the_drive(self):
        found = serve.drive_path(self.media, 'CARD', 'DCIM/100TEST/P2.JPG')
        self.assertEqual(found, f'{self.card}/DCIM/100TEST/P2.JPG')
        self.assertEqual(serve.drive_path(self.media, 'CARD', ''), self.card)

    def test_refuses_paths_that_leave_the_drive_or_go_nowhere(self):
        outside = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside)
        (self.media / 'CARD' / 'link').symlink_to(outside)
        (self.media / 'LINK').symlink_to(outside)
        refused = [
            ('CARD', '../CARD/DCIM'), ('CARD', 'DCIM/../../CARD'),
            ('CARD', '.Trashes/D.jpg'), ('CARD', 'link'),
            ('CARD', 'DCIM/missing.jpg'), ('..', ''), ('.hidden', ''),
            ('CARD/DCIM', ''), ('LINK', ''), ('', ''), ('NONE', '')
        ]
        for drive, path in refused:
            with self.subTest(drive=drive, path=path):
                self.assertIsNone(serve.drive_path(self.media, drive, path))


class Listing(unittest.TestCase):
    def test_lists_folders_and_media_files_with_their_paths(self):
        media = media_folder(self)
        root = serve.listing(serve.drive_path(media, 'CARD', ''), '')
        self.assertEqual(root, {'folders': ['DCIM'], 'files': []})

        folder = serve.drive_path(media, 'CARD', 'DCIM/100TEST')
        found = serve.listing(folder, 'DCIM/100TEST')
        names = [f['name'] for f in found['files']]
        self.assertEqual(names, ['C1.MOV', 'P10.jpg', 'P2.JPG'])
        first = found['files'][0]
        self.assertEqual(first['path'], 'DCIM/100TEST/C1.MOV')
        self.assertEqual(first['size'], (FIXTURES / 'clip.mp4').stat().st_size)
        self.assertGreater(first['modified'], 1_000_000_000_000)

    def test_walks_media_below_a_folder(self):
        media = media_folder(self)
        found = serve.walk(serve.drive_path(media, 'CARD', ''), '')
        paths = [f['path'] for f in found['files']]
        self.assertEqual(paths, [
            'DCIM/100TEST/C1.MOV', 'DCIM/100TEST/P10.jpg',
            'DCIM/100TEST/P2.JPG'
        ])
        self.assertEqual(found['skipped'], 1)

        folder = serve.drive_path(media, 'CARD', 'DCIM/100TEST')
        found = serve.walk(folder, 'DCIM/100TEST')
        self.assertEqual(found['files'][2]['path'], 'DCIM/100TEST/P2.JPG')


class ByteRange(unittest.TestCase):
    def test_reads_the_ranges_a_page_asks_for(self):
        self.assertEqual(serve.byte_range('bytes=0-99', 1000), (0, 100))
        self.assertEqual(serve.byte_range('bytes=900-', 1000), (900, 1000))
        self.assertEqual(serve.byte_range('bytes=-100', 1000), (900, 1000))
        self.assertEqual(serve.byte_range('bytes=990-2000', 1000), (990, 1000))

    def test_serves_the_whole_file_without_a_usable_range(self):
        for header in (None, '', 'items=0-1', 'bytes=0-1,5-6', 'bytes=x-'):
            with self.subTest(header=header):
                self.assertIsNone(serve.byte_range(header, 1000))

    def test_refuses_ranges_outside_the_file(self):
        for header in ('bytes=1000-', 'bytes=5-2', 'bytes=-0'):
            with self.subTest(header=header):
                with self.assertRaises(ValueError):
                    serve.byte_range(header, 1000)


@unittest.skipUnless(HAS_EXIFTOOL, 'exiftool missing')
class ExifThumbnail(unittest.TestCase):
    def setUp(self):
        self.folder = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.folder)

    def photo(self, orientation):
        thumb = self.folder / 'thumb.jpg'
        shutil.copy(FIXTURES / 'e2e-a.jpg', thumb)
        subprocess.run(['exiftool', '-q', '-all=', '-overwrite_original',
                        str(thumb)], check=True)
        photo = self.folder / f'photo-{orientation}.jpg'
        shutil.copy(FIXTURES / 'e2e-b.jpg', photo)
        subprocess.run(['exiftool', '-q', '-overwrite_original', '-n',
                        f'-Orientation={orientation}',
                        f'-ThumbnailImage<={thumb}', str(photo)], check=True)
        return photo, thumb.read_bytes()

    def test_takes_the_cameras_thumbnail_with_the_photos_orientation(self):
        photo, thumb = self.photo(6)
        found = serve.exif_thumbnail(photo)
        self.assertEqual(found[:2], b'\xff\xd8')
        self.assertTrue(found.endswith(thumb[2:]))
        path = self.folder / 'found.jpg'
        path.write_bytes(found)
        args = ['exiftool', '-s3', '-n', '-Orientation', str(path)]
        self.assertEqual(subprocess.check_output(args).strip(), b'6')

    def test_leaves_an_upright_thumbnail_as_it_is(self):
        photo, thumb = self.photo(1)
        self.assertEqual(serve.exif_thumbnail(photo), thumb)

    def test_finds_none_in_a_photo_without_one(self):
        self.assertIsNone(serve.exif_thumbnail(FIXTURES / 'e2e-a.jpg'))
        self.assertIsNone(serve.exif_thumbnail(FIXTURES / 'clip.mp4'))


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg missing')
class Thumbnail(unittest.TestCase):
    def size(self, data):
        folder = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder)
        (folder / 't.jpg').write_bytes(data)
        return probe(folder / 't.jpg')[0]

    def test_draws_photos_upright_and_videos_from_their_first_frame(self):
        portrait = serve.thumbnail(str(FIXTURES / 'e2e-portrait.jpg'))
        self.assertEqual(self.size(portrait),
                         {'codec_type': 'video', 'width': 320, 'height': 240})
        clip = self.size(serve.thumbnail(str(FIXTURES / 'clip.mp4')))
        self.assertLessEqual(max(clip['width'], clip['height']),
                             serve.THUMB_SIZE)

    def test_gives_none_for_a_file_ffmpeg_cannot_read(self):
        self.assertIsNone(serve.thumbnail(str(FIXTURES / 'broken.mp4')))


@unittest.skipUnless(HAS_FFMPEG, 'ffmpeg missing')
class DriveApi(unittest.TestCase):
    call = Api.call
    code = Api.code
    tearDown = Api.tearDown

    def setUp(self):
        self.media = media_folder(self)
        self.server = serve.make_server(0, self.media)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        token = json.loads(self.call('/api/token'))['token']
        self.headers = {'X-Photoloft-Token': token}
        self.token = token

    def get(self, path, headers=None):
        return self.call(path, None, {**self.headers, **(headers or {})})

    def test_lists_drives_and_folders(self):
        self.assertEqual(json.loads(self.get('/api/drives')),
                         {'drives': ['CARD']})
        found = json.loads(self.get('/api/drive/list?drive=CARD&path=DCIM'))
        self.assertEqual(found['folders'], ['100TEST', 'thumbs'])
        walk = json.loads(self.get('/api/drive/walk?drive=CARD&path='))
        self.assertEqual(len(walk['files']), 3)

    def test_serves_a_file_whole_or_in_part(self):
        path = '/api/drive/file?drive=CARD&path=DCIM/100TEST/C1.MOV'
        whole = (FIXTURES / 'clip.mp4').read_bytes()
        self.assertEqual(self.get(path), whole)

        url = f'http://127.0.0.1:{self.port}{path}'
        headers = {**self.headers, 'Range': 'bytes=-100'}
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers['Content-Range'],
                             f'bytes {len(whole) - 100}-{len(whole) - 1}/'
                             f'{len(whole)}')
            self.assertEqual(response.read(), whole[-100:])

    def test_draws_a_thumbnail_with_the_token_in_the_address(self):
        path = '/api/drive/thumb?drive=CARD&path=DCIM/100TEST/P2.JPG'
        data = self.call(f'{path}&token={self.token}')
        self.assertEqual(data[:2], b'\xff\xd8')
        self.assertEqual(self.code(path, {}), 403)
        self.assertEqual(self.code(f'{path}&token=wrong', {}), 403)

    # Other files on a drive stay unread, also behind a photo's name.
    def test_serves_only_photos_and_videos(self):
        folder = self.media / 'CARD' / 'DCIM' / '100TEST'
        (folder / 'P3.jpg').symlink_to(folder / 'notes.txt')
        for kind in ('file', 'thumb'):
            for name in ('notes.txt', 'P3.jpg'):
                with self.subTest(kind=kind, name=name):
                    url = f'/api/drive/{kind}?drive=CARD&' \
                        f'path=DCIM/100TEST/{name}&token={self.token}'
                    self.assertEqual(self.code(url, self.headers), 404)

    # A page leaving a folder stops reading its thumbnails and files: the
    # server sends nothing more and raises nothing.
    def test_stops_quietly_when_the_page_stops_reading(self):
        (self.media / 'CARD' / 'big.mp4').write_bytes(os.urandom(8 << 20))
        head = '\r\n'.join([
            'GET /api/drive/file?drive=CARD&path=big.mp4 HTTP/1.1',
            f'Host: 127.0.0.1:{self.port}',
            f'X-Photoloft-Token: {self.token}',
            '', ''
        ])

        raised, done = [], threading.Event()
        get = serve.Handler.do_GET

        def getting(handler):
            try:
                get(handler)
            except Exception as error:
                raised.append(error)
            finally:
                done.set()

        with mock.patch.object(serve.Handler, 'do_GET', getting):
            with socket.create_connection(('127.0.0.1', self.port)) as page:
                page.sendall(head.encode())
                page.recv(1024)
                linger = struct.pack('ii', 1, 0)
                page.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
            self.assertTrue(done.wait(10))
        self.assertEqual(raised, [])

    def test_refuses_requests_without_the_token_or_off_the_drive(self):
        file = '/api/drive/file?drive=CARD&path=DCIM/100TEST/P2.JPG'
        self.assertEqual(self.code('/api/drives', {}), 403)
        self.assertEqual(self.code(f'{file}&token={self.token}', {}), 403)
        for path in ('../CARD/DCIM/100TEST/P2.JPG', '.Trashes/D.jpg'):
            with self.subTest(path=path):
                url = f'/api/drive/file?drive=CARD&path={path}'
                self.assertEqual(self.code(url, self.headers), 404)
        missing = '/api/drive/list?drive=NONE&path='
        self.assertEqual(self.code(missing, self.headers), 404)
        self.assertEqual(self.code('/api/drive/nothing', self.headers), 404)
        ranged = {**self.headers, 'Range': 'bytes=99999999-'}
        self.assertEqual(self.code(file, ranged), 416)


if __name__ == '__main__':
    unittest.main()
