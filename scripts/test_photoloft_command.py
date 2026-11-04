#!/usr/bin/env python3

# Tests for packaging/photoloft, the command the package installs. Run
# with: python3 -m unittest scripts/test_photoloft_command.py
#
# The launcher runs with nothing but stand-ins on PATH (systemctl, stat,
# curl, sleep and the browsers), which log their calls. The session bus
# variables are left out, so not even a missing stand-in could reach the
# real user services.

import pathlib
import shutil
import subprocess
import tempfile
import unittest

PROJECT = pathlib.Path(__file__).resolve().parent.parent
LAUNCHER = PROJECT / 'packaging' / 'photoloft'
URL = 'http://127.0.0.1:47321'
LOG = 'echo "${0##*/} $*" >>"$CALLS"\n'

# systemctl answers is-active and the start time from the environment;
# curl fails FAILS times before the page answers.
STUBS = {
    'systemctl': LOG + '''case $* in
*is-active*) exit "$ACTIVE" ;;
*show*) echo "@$STARTED" ;;
esac
''',
    'stat': LOG + 'echo "$CHANGED"\n',
    'curl': LOG + '''tries=$(($(<"$TRIES") + 1))
echo "$tries" >"$TRIES"
((tries > FAILS))
''',
    'sleep': LOG,
    'chromium': LOG
}


class PhotoloftCommand(unittest.TestCase):
    def setUp(self):
        self.base = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base)
        self.bin = self.base / 'bin'
        self.calls = self.base / 'calls'
        self.tries = self.base / 'tries'
        for name, body in STUBS.items():
            write(self.bin / name, '#!/bin/bash\n' + body).chmod(0o755)
        self.omarchy = write(self.bin / 'omarchy-launch-webapp',
                             '#!/bin/bash\n' + LOG)
        self.omarchy.chmod(0o755)
        self.calls.touch()
        self.tries.write_text('0')

    def launch(self, active=False, started=0, changed=0, fails=0):
        env = {
            'HOME': str(self.base),
            'PATH': str(self.bin),
            'CALLS': str(self.calls),
            'TRIES': str(self.tries),
            'FAILS': str(fails),
            'ACTIVE': '0' if active else '3',
            'STARTED': str(started),
            'CHANGED': str(changed)
        }
        run = subprocess.run([LAUNCHER], env=env, capture_output=True,
                             text=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        return self.calls.read_text().splitlines(), run.stderr

    def test_starts_the_service_and_opens_the_page_once_it_answers(self):
        calls, _ = self.launch(fails=2)

        start = calls.index('systemctl --user start photoloft.service')
        polls = [i for i, c in enumerate(calls)
                 if c.startswith('curl ') and c.endswith(URL)]
        self.assertEqual(len(polls), 3)
        self.assertLess(start, polls[0])
        self.assertEqual(calls[-1], f'omarchy-launch-webapp {URL}')
        self.assertFalse([c for c in calls if c.startswith('chromium')])

    def test_opens_a_chromium_app_window_without_omarchy(self):
        self.omarchy.unlink()
        calls, _ = self.launch()

        self.assertEqual(calls[-1], f'chromium --app={URL}')

    def test_restarts_a_service_older_than_the_installed_server(self):
        calls, _ = self.launch(active=True, started=100, changed=200)

        self.assertIn('stat -c %Z /usr/lib/photoloft/scripts/serve.py',
                      calls)
        self.assertIn('systemctl --user restart photoloft.service', calls)
        self.assertNotIn('systemctl --user start photoloft.service', calls)

    def test_leaves_a_current_service_running(self):
        calls, _ = self.launch(active=True, started=300, changed=200)

        self.assertFalse([c for c in calls if 'restart' in c])

    def test_opens_the_page_after_ten_seconds_without_an_answer(self):
        calls, stderr = self.launch(fails=1000)

        polls = [c for c in calls if c.startswith('curl ')]
        self.assertEqual(len(polls), 100)
        self.assertIn('journalctl --user -u photoloft', stderr)
        self.assertEqual(calls[-1], f'omarchy-launch-webapp {URL}')


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


if __name__ == '__main__':
    unittest.main()
