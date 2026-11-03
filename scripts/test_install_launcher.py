#!/usr/bin/env python3

# Tests for install-launcher.sh. Run with:
# python3 -m unittest scripts/test_install_launcher.py
#
# The script runs in a copy of the project with a temporary home and
# stand-ins for systemctl, magick and the Omarchy commands, which log
# their calls. The session bus variables are left out, so not even a
# missing stand-in could reach the real user services.

import pathlib
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / 'install-launcher.sh'
URL = 'http://127.0.0.1:47321'
STUBS = ('systemctl', 'magick', 'omarchy-webapp-install',
         'omarchy-webapp-remove')
STUB = '''#!/bin/bash
echo "${0##*/} $* notify=${OMARCHY_REMOVE_NOTIFY:-}" >>"$CALLS"
'''
OLD_UNIT = f'''[Unit]
Description=Lightbox photo editor page on {URL}

[Service]
ExecStart=/usr/bin/python3 /old/lightbox/scripts/serve.py 47321
Restart=on-failure

[Install]
WantedBy=default.target
'''
OLD_LAUNCHER = f'''[Desktop Entry]
Name=Lightbox
Exec=omarchy-launch-webapp "{URL}"
Icon=lightbox
'''


class InstallLauncher(unittest.TestCase):
    def setUp(self):
        self.base = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base)
        self.root = self.base / 'photoloft'
        self.home = self.base / 'home'
        self.units = self.home / '.config' / 'systemd' / 'user'
        self.apps = self.home / '.local' / 'share' / 'applications'
        self.calls = self.base / 'calls'

        (self.root / 'scripts').mkdir(parents=True)
        shutil.copy(SCRIPT, self.root / 'scripts')
        write(self.root / 'dist' / 'index.html', '')
        icons = self.root / 'node_modules' / 'lucide-static' / 'icons'
        write(icons / 'images.svg', '<svg stroke="currentColor"/>')

        self.bin = self.base / 'bin'
        for name in STUBS:
            write(self.bin / name, STUB).chmod(0o755)
        self.calls.touch()

    def install(self):
        env = {
            'HOME': str(self.home),
            'PATH': f'{self.bin}:/usr/bin',
            'TMPDIR': str(self.base),
            'CALLS': str(self.calls)
        }
        script = self.root / 'scripts' / 'install-launcher.sh'
        subprocess.run([script], env=env, check=True, capture_output=True)
        return self.calls.read_text().splitlines()

    def test_installs_from_its_own_folder(self):
        calls = self.install()

        unit = (self.units / 'photoloft.service').read_text()
        self.assertIn(f'{self.root}/scripts/serve.py 47321', unit)
        self.assertIn('Description=Photoloft', unit)
        self.assertIn('systemctl --user enable --now photoloft.service '
                      'notify=', calls)
        self.assertTrue(any(c.startswith(f'omarchy-webapp-install '
                                         f'Photoloft {URL} ')
                            for c in calls))
        self.assertFalse([c for c in calls if 'lightbox' in c.lower()])

    def test_replaces_the_install_under_the_former_name(self):
        write(self.units / 'lightbox.service', OLD_UNIT)
        write(self.apps / 'Lightbox.desktop', OLD_LAUNCHER)
        calls = self.install()

        self.assertFalse((self.units / 'lightbox.service').exists())
        stop = calls.index('systemctl --user disable --now '
                           'lightbox.service notify=')
        start = calls.index('systemctl --user enable --now '
                            'photoloft.service notify=')
        self.assertLess(stop, start)

        install = next(i for i, c in enumerate(calls)
                       if c.startswith('omarchy-webapp-install'))
        remove = calls.index('omarchy-webapp-remove Lightbox notify=false')
        self.assertLess(install, remove)

    def test_leaves_other_programs_named_lightbox_alone(self):
        other = OLD_UNIT.replace('/old/lightbox/scripts/serve.py 47321',
                                 '/usr/bin/lightbox --daemon')
        write(self.units / 'lightbox.service', other)
        write(self.apps / 'Lightbox.desktop',
              OLD_LAUNCHER.replace(URL, 'https://lightbox.example'))
        calls = self.install()

        self.assertTrue((self.units / 'lightbox.service').exists())
        self.assertFalse([c for c in calls if 'lightbox' in c.lower()])


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


if __name__ == '__main__':
    unittest.main()
