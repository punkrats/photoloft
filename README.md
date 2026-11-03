# Lightbox

A small photo tool for Chromium: import JPEGs, sort them into albums,
fix colour, tone and angle, and export each album as consecutively
named, size-limited JPEGs. Everything stays on your disk.

## Use

```
npm install
npm run build
scripts/install-launcher.sh
```

The script adds a small user service that serves the built page at
http://127.0.0.1:47321 and a launcher entry; start Lightbox from the app
launcher (Super+Space). The fixed local address lets Chromium remember
folder access ("Allow on every visit"), which it does not do for pages
opened from disk. The script header lists how to remove both.

On first start, pick an empty folder such as `~/Pictures/Lightbox`.
Lightbox keeps imported photos, edits and albums in its hidden
`.library` folder there and writes exports to `Exports/<album>/`.

- Import folder takes a folder with all its subfolders; Import photos
  takes single files. Dropping files or folders works too.
- Photos already in the library (same content, any file name) are
  skipped. Hidden folders, non-JPEG files and other programs' thumbnail
  and cache folders (`thumbs`, `thumbnails`, `previews`, `cache`,
  `*.lrdata`, `@eaDir`) are left out.
- Star keepers with `S` or the star on a thumbnail; the Starred view
  lists them.
- Auto adjusts exposure, contrast, highlights, shadows, whites, blacks
  and vibrance. White balance has its own Auto button and eyedropper,
  since a guess cannot tell a colour cast from the colour of a scene.
- The Sort control orders any view by date taken, name or file size.
  Albums also have their custom order (drag to reorder) and remember
  their sort; dragging in a sorted album switches it to custom.
  Hovering a thumbnail shows the date taken or file size when sorted by
  them.

- Space shows the selected photo large (arrows step, Space or Esc
  returns, Enter edits).
- Last import lists what the latest import added, with a button that
  moves its photos in no album to the Trash. In albums shows every
  album's photos on one page.
- Adjust date (selection bar) fixes a camera's wrong or missing clock:
  enter the real time of the first selected photo; selected photos with
  a date move by the same amount, those without one follow it one
  second apart in the order shown. Exports carry the corrected time.
- Videos (MP4, MOV) import, play (Space, K) and take the same colour
  and crop settings as photos. Album exports include them at 720p,
  1080p or original size, made by ffmpeg through the Lightbox service
  with a colour table computed from the preview's maths.

Press `?` in the app for keyboard shortcuts.

## Develop

- `npm run dev` serves the app on localhost with hot reload
- `npm test` runs the unit tests (Vitest)
- `npm run test:e2e` builds and runs the browser tests (Playwright,
  system Chromium with software WebGL)
- `npm run typecheck`
- `python3 -m unittest scripts/test_serve.py` tests the server and its
  ffmpeg video export

`test/fixtures/make-fixtures.sh` regenerates the test photos
(ImageMagick and exiftool). `scripts/subset-icons.sh` rebuilds the
icon font after adding an icon to `src/styles/icons.scss`.

## Layout

- `src/colour.ts` and `src/shaders/develop.frag` hold the same colour
  maths; the browser tests compare their output
- `src/library.ts` has the pure album, trash and loading logic
- `src/storage.ts` reads and writes the library folder; saves alternate
  between two files so an interrupted save never loses the last good
  state
- `src/ui/` renders with lit-html, one template module per area, each
  with a matching stylesheet in `src/styles/`
