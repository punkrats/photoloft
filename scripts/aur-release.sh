#!/bin/bash

# Prepares the AUR recipe in packaging/aur for the version in
# package.json, once its tag v<version> is on GitHub: sets pkgver,
# starts pkgrel at 1 for a new version, writes the checksum of the tag's
# tarball and regenerates .SRCINFO. The recipe changes only when all of
# that succeeds. Creates no tag and pushes nothing.

set -euo pipefail

root=$(realpath "$(dirname "$(realpath "$0")")/..")
recipe=$root/packaging/aur
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

version_of() {
  python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])'
}

version=$(version_of <"$root/package.json")
tag=v$version
if [[ ! $version =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "pkgver takes digits and dots only; package.json has $version" >&2
  exit 1
fi

cp "$recipe/PKGBUILD" "$work/PKGBUILD"
if ! grep -qxF "pkgver=$version" "$work/PKGBUILD"; then
  sed -i -e "s/^pkgver=.*/pkgver=$version/" -e 's/^pkgrel=.*/pkgrel=1/' \
    "$work/PKGBUILD"
fi

# The download address is the PKGBUILD's source, as makepkg reads it.
address=$(makepkg -D "$work" --printsrcinfo |
  sed -n 's/^\tsource = .*::\(.*\)$/\1/p')
if ! curl -fsSL -o "$work/tarball" "$address"; then
  echo "No tarball at $address; push the tag: git push origin $tag" >&2
  exit 1
fi

tagged=$(tar -xOzf "$work/tarball" "photoloft-$version/package.json" |
  version_of)
if [[ $tagged != "$version" ]]; then
  echo "Tag $tag holds version $tagged, package.json $version" >&2
  exit 1
fi

sum=$(sha256sum "$work/tarball" | cut -d' ' -f1)
sed -i "s/^sha256sums=.*/sha256sums=('$sum')/" "$work/PKGBUILD"
makepkg -D "$work" --printsrcinfo >"$work/.SRCINFO"
cp "$work/PKGBUILD" "$work/.SRCINFO" "$recipe/"
pkgrel=$(sed -n 's/^pkgrel=//p' "$recipe/PKGBUILD")

cat <<EOF
packaging/aur now builds photoloft $version-$pkgrel from tag $tag.
Next, in your clone of ssh://aur@aur.archlinux.org/photoloft.git:
  cp $recipe/PKGBUILD $recipe/.SRCINFO .
  git add PKGBUILD .SRCINFO
  git commit -m "Update to $version"
  git push
Then commit packaging/aur here, so the repository keeps the recipe the
AUR has.
EOF
