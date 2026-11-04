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
- Chromium keeps the last folder of each `showDirectoryPicker` id per
  origin in the profile's `Preferences`
  (`file_system_last_picked_directory`, `custom-id-<id>`), and folder
  grants per origin and path. IndexedDB is per origin too. Renaming
  a picker id loses its start folder; changing the port loses all of
  it.
- `data-foo` without a value gives `el.dataset.foo === ''`, which is
  falsy. Test boolean data attributes with `el.matches('[data-foo]')`
  or `'foo' in el.dataset`.
- `preventDefault()` on a keydown for Enter stops the click a focused
  button would get from it. A window-level shortcut that claims Enter
  takes Enter from every button on screen.
- A click on a `<label>` around a checkbox focuses the checkbox and
  then clicks it; the label's own click finds no `data-action` of its
  own. A `data-action` on the checkbox therefore runs once per click,
  and a field that should keep the keys has to take focus back.
- Focusing a text field from a keydown handler, without
  `preventDefault()`, sends that key's character to the new field.
- `click()` on a disabled button does nothing, so pressing a button
  from a key handler needs no check of its own.
- lit's `map` reuses elements by position. When a list reorders, a
  focused row element keeps focus while it shows another item; give
  rows a key and move focus back after the render.
- Leaflet gives its map container `tabindex="0"` and pans on the arrow
  keys while it has focus.
- A text input keeps its selection while a button it lost focus to is
  pressed, and `focus()` from script brings that selection back. A
  button can therefore type into the field at the cursor with
  `setRangeText(text, start, end, 'end')`, which fires no `input`
  event.

- Chromium applies a video's rotation flag in `videoWidth/Height` and
  in `createImageBitmap(video)`; feeding frames as ImageBitmaps keeps
  rotated phone videos upright everywhere.
- ffmpeg's `color` source generates YUV with BT.601 even when the
  output is tagged BT.709. Generate RGB (`,format=rgb24`) and convert
  with `scale=out_color_matrix=bt709` for exact test colours.
- Python 3.13 removed `cgi`; stream uploads with a simple framing
  (header with lengths, then raw bytes) instead of multipart.
- Range inputs stacked in one grid cell make a bar with several thumbs:
  the upper ones get `pointer-events: none` and their
  `::-webkit-slider-thumb` `pointer-events: auto`, so a press beside a
  thumb reaches the input underneath. A thumb's centre sits half its
  width in from either end: `calc(w / 2 + (100% - w) * share)`.
- Setting a video's `currentTime` always seeks and fires `timeupdate`,
  also to the time it already has.
- ffmpeg: `-ss` and `-t` before `-i` while re-encoding cut to the frame
  (accurate seeking is the default for input seeking); the output starts
  at 0, and `-progress`'s `out_time_us` counts from the cut.

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
  test, otherwise the last changes may still be unsaved. The editor
  hides the sidebar, so there wait with `toHaveAttribute('data-saved',
  'true')` on `.sidebar-folder`; a visibility wait never passes.
- To show that an action saves nothing, wait for `saved` first, then
  read `data-saved` once with `getAttribute` right after the action.
  `toHaveAttribute` retries and passes once a scheduled save ends.
  The same read after an import proves the import saved nothing; to
  prove it recorded no undo step, make a change first and check that
  Ctrl+Z takes back that change. Shortcuts work right after
  `setInputFiles` on the hidden import input.
- `page.keyboard.press` does not wait for a frame, so a second key can
  arrive while a field the state just closed is still in the page and
  focused. To press keys within one frame on purpose, replace
  `window.requestAnimationFrame` from the test and run the held
  callbacks afterwards; Leaflet keeps the reference it took at load
  (`Util.requestFn`), so only the app's render waits.
- An input removed from the page keeps its value: take an
  `elementHandle()` before and read `el.value` with `evaluate` after,
  to check what a closed field received.
- A focused field hidden with `display: none` keeps focus, and takes
  keys, until the next frame; Chromium then moves focus to the body.
  `el.checkVisibility()` is false for a removed field and for a
  hidden one alike.
- Toasts sit over the bottom of the editor, the video's play bar
  included; dismiss them before pointer work there.
- `toHaveCSS('--name', value)` reads custom properties too.
- Playwright checks a `<label>` for actionability through its control:
  clicking a label whose checkbox is disabled waits until the timeout.
  `click({ force: true })` shows what the user's click does.
- Playwright starts headless Chromium with `--hide-scrollbars`, so
  scrollbars take no room in tests. `Emulation.setScrollbarsHidden`
  over CDP can only hide them, and `test.use({ launchOptions })` is
  refused inside a describe. A fixture that launches a second browser
  with `{ ...launchOptions, ignoreDefaultArgs: ['--hide-scrollbars'] }`
  shows classic 15px scrollbars.
- The editor stays in the page while the grid shows, hidden with
  `display: none`; wait for it to be visible before measuring it.
- A scrollbar takes its thickness out of the box's padding box, so a
  strip of fixed height with `overflow-x: auto` loses that height
  below its content, and its `overflow-y` computes to `auto` as well.

## Tooling

- Vite's CLI takes the project root as a positional argument
  (`vite build <root>`); there is no `--root` flag.
- TypeScript 7 ships its lib files in
  `node_modules/@typescript/typescript-linux-x64/lib/`.
- Vitest 3 pulled a vulnerable tinypool; Vitest 4.1.12 works with
  Vite 6 on Node 22.11 (Vite 7 needs Node 22.12+).
- `omarchy-webapp-install` refuses anything other than http(s) URLs.
- `omarchy-webapp-remove <name>` deletes the launcher and its icons,
  succeeds even when there is none, and sends a notification unless
  `OMARCHY_REMOVE_NOTIFY=false`.
- To test a script that calls `systemctl --user`, put stand-ins first
  on `PATH`, use a temporary `HOME` and leave out
  `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`: the real
  systemctl then cannot reach the user manager.

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
