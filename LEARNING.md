# Learning notes

## Browser platform (Chromium 152)

- `file://` pages are a secure context: `showDirectoryPicker`, IndexedDB
  and inline module scripts work, so a single-file build needs no
  server. All `file://` pages share one origin.
- `getFileHandle(name, { create: true })` creates an empty file at
  once. A save interrupted before `close()` can leave that 0-byte file
  behind, so never trust a single library file; alternate two and
  treat empty files as missing.
- `createImageBitmap(file, { imageOrientation: 'from-image' })` applies
  EXIF orientation; resizing via a second `createImageBitmap(bitmap,
  { resizeQuality: 'high' })` avoids depending on the order of resize
  and orientation.
- Chromium's JPEG encoder never goes below about 760 bytes (full
  Huffman tables), whatever the image size.
- Chromium does not persist File System Access permissions for
  `file://` pages, even after "Allow on every visit". Serve the page
  from a fixed http://127.0.0.1 address to get a persistent grant.
- Automatic white balance from grey-world statistics fails on grass,
  warm pavement and blue-hour scenes; camera JPEGs rarely need it.
  Keep it out of a one-click Auto; offer it separately.
- Levels and highlight decisions need per-channel maxima: a saturated
  sky clips in one channel while its luminance reads as mid grey.
- `data-foo` without a value gives `el.dataset.foo === ''`, which is
  falsy. Test boolean data attributes with `el.matches('[data-foo]')`
  or `'foo' in el.dataset`.

- Chromium applies a video's rotation flag in `videoWidth/Height` and
  in `createImageBitmap(video)`; feeding frames as ImageBitmaps keeps
  rotated phone videos upright everywhere.
- ffmpeg's `color` source generates YUV with BT.601 even when the
  output is tagged BT.709. Generate RGB (`,format=rgb24`) and convert
  with `scale=out_color_matrix=bt709` for exact test colours.
- Python 3.13 removed `cgi`; stream uploads with a simple framing
  (header with lengths, then raw bytes) instead of multipart.

## Testing

- Headless system Chromium renders WebGL2 in software with
  `--disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader`
  (SwiftShader, MAX_TEXTURE_SIZE 8192). Tests then never touch the GPU.
- The native folder picker cannot be driven; stub
  `window.showDirectoryPicker` with an OPFS directory in
  `page.addInitScript`. OPFS handles have the same API.
- `expect(await locator.allTextContents()).toEqual(...)` does not wait
  for the next frame; use `await expect(locator).toHaveText([...])`.
- Wait for the sidebar's `[data-saved="true"]` before reloading in a
  test, otherwise the last changes may still be unsaved.

## Tooling

- Vite's CLI takes the project root as a positional argument
  (`vite build <root>`); there is no `--root` flag.
- TypeScript 7 ships its lib files in
  `node_modules/@typescript/typescript-linux-x64/lib/`.
- Vitest 3 pulled a vulnerable tinypool; Vitest 4.1.12 works with
  Vite 6 on Node 22.11 (Vite 7 needs Node 22.12+).
- `omarchy-webapp-install` refuses anything other than http(s) URLs.

## Metadata

- ffmpeg's MP4 muxer writes `-metadata location=` only as a 3GPP
  `loci` box. Android and Google Photos read the QuickTime `©xyz`
  entry in moov/udta, which ffmpeg writes for MOV output only, so the
  server adds it after ffmpeg and shifts the stco/co64 chunk offsets.
- `-map_metadata 0` copies a phone video's own location into the
  export (as `loci`); an empty `-metadata location=` removes it.
- `exiftool '-UserData:GPSCoordinates=41.9, 12.5'` writes `©xyz` into
  an MP4 (language code 0, three decimals); Android writes language
  0x15c7 and four decimals.
- `exiftool -validate` wants YCbCrPositioning in IFD0 and ExifVersion
  plus ComponentsConfiguration in the EXIF IFD of a JPEG.
- `exiftool -j -validate file` prints only the Validate tag; add
  `-All` to get the values as well.
- `fetch()` throws on header values above U+00FF, so JSON sent in a
  header needs non-ASCII escaped as `\uXXXX` (Python's `json.dumps`
  does that by default).
