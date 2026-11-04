#!/usr/bin/env python3

# Tests for aur-release.sh. Run with:
# python3 -m unittest scripts/test_aur_release.py
#
# The script runs in a copy of the project around the real AUR recipe.
# A curl stand-in hands out a tarball made here and logs the address
# asked for, so nothing reaches the network; makepkg runs for real, as
# it only reads the recipe.

import hashlib
import io
import json
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import unittest

PROJECT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = PROJECT / 'scripts' / 'aur-release.sh'
RECIPE = PROJECT / 'packaging' / 'aur'
TAGS = 'https://github.com/punkrats/photoloft/archive/refs/tags'
CURL = '''#!/bin/bash
echo "curl $*" >>"$CALLS"
[[ -f $TARBALL ]] || exit 22
while (($#)); do
  [[ $1 == -o ]] && cp "$TARBALL" "$2"
  shift
done
'''


@unittest.skipUnless(shutil.which('makepkg'), 'needs makepkg')
class AurRelease(unittest.TestCase):
    def setUp(self):
        self.base = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base)
        self.root = self.base / 'photoloft'
        self.recipe = self.root / 'packaging' / 'aur'
        self.pkgbuild = self.recipe / 'PKGBUILD'
        self.tarball = self.base / 'tag.tar.gz'
        self.calls = self.base / 'calls'

        (self.root / 'scripts').mkdir(parents=True)
        shutil.copy(SCRIPT, self.root / 'scripts')
        shutil.copytree(RECIPE, self.recipe)
        self.bin = self.base / 'bin'
        write(self.bin / 'curl', CURL).chmod(0o755)
        self.calls.touch()

    def recipe_at(self, pkgver, pkgrel):
        text = self.pkgbuild.read_text()
        text = re.sub(r'(?m)^pkgver=.*', f'pkgver={pkgver}', text)
        text = re.sub(r'(?m)^pkgrel=.*', f'pkgrel={pkgrel}', text)
        self.pkgbuild.write_text(text)

    def release(self, version, tagged=None):
        write(self.root / 'package.json', json.dumps({'version': version}))
        if tagged:
            make_tarball(self.tarball, f'photoloft-{version}',
                         json.dumps({'version': tagged}))
        env = {
            'HOME': str(self.base),
            'PATH': f'{self.bin}:/usr/bin',
            'TMPDIR': str(self.base),
            'CALLS': str(self.calls),
            'TARBALL': str(self.tarball)
        }
        script = self.root / 'scripts' / 'aur-release.sh'
        return subprocess.run([script], env=env, capture_output=True,
                              text=True)

    def test_prepares_the_recipe_for_a_new_version(self):
        self.recipe_at('0.1.0', 3)
        run = self.release('0.2.0', tagged='0.2.0')

        self.assertEqual(run.returncode, 0, run.stderr)
        sha = hashlib.sha256(self.tarball.read_bytes()).hexdigest()
        pkgbuild = self.pkgbuild.read_text()
        self.assertIn('\npkgver=0.2.0\n', pkgbuild)
        self.assertIn('\npkgrel=1\n', pkgbuild)
        self.assertIn(f"\nsha256sums=('{sha}')\n", pkgbuild)

        srcinfo = (self.recipe / '.SRCINFO').read_text()
        source = f'photoloft-0.2.0.tar.gz::{TAGS}/v0.2.0.tar.gz'
        for line in ('pkgver = 0.2.0', 'pkgrel = 1', f'source = {source}',
                     f'sha256sums = {sha}'):
            self.assertIn(f'\t{line}\n', srcinfo)
        calls = self.calls.read_text()
        self.assertIn(f'{TAGS}/v0.2.0.tar.gz', calls)
        self.assertIn('aur.archlinux.org', run.stdout)

    def test_keeps_pkgrel_when_the_version_stays(self):
        self.recipe_at('0.2.0', 2)
        run = self.release('0.2.0', tagged='0.2.0')

        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn('\npkgrel=2\n', self.pkgbuild.read_text())

    def test_refuses_a_tag_that_holds_another_version(self):
        before = self.pkgbuild.read_text()
        run = self.release('0.2.0', tagged='0.1.0')

        self.assertNotEqual(run.returncode, 0)
        self.assertIn('0.1.0', run.stderr)
        self.assertEqual(self.pkgbuild.read_text(), before)

    def test_refuses_a_tag_missing_on_github(self):
        before = self.pkgbuild.read_text()
        run = self.release('0.2.0')

        self.assertNotEqual(run.returncode, 0)
        self.assertIn('git push origin v0.2.0', run.stderr)
        self.assertEqual(self.pkgbuild.read_text(), before)

    def test_refuses_a_version_pkgver_cannot_hold(self):
        run = self.release('0.2.0-rc.1', tagged='0.2.0-rc.1')

        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(self.calls.read_text(), '')

    def test_committed_srcinfo_is_the_one_makepkg_prints(self):
        printed = subprocess.run(
            ['makepkg', '--dir', str(RECIPE), '--printsrcinfo'],
            env={'HOME': str(self.base), 'PATH': '/usr/bin'},
            capture_output=True, text=True, check=True).stdout
        self.assertEqual((RECIPE / '.SRCINFO').read_text(), printed)


def make_tarball(path, folder, package_json):
    data = package_json.encode()
    entry = tarfile.TarInfo(f'{folder}/package.json')
    entry.size = len(data)
    with tarfile.open(path, 'w:gz') as tar:
        tar.addfile(entry, io.BytesIO(data))


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


if __name__ == '__main__':
    unittest.main()
