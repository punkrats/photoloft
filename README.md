# Photoloft

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
http://127.0.0.1:47321 and a launcher entry; start Photoloft from the
app launcher (Super+Space). The fixed local address lets Chromium
remember folder access ("Allow on every visit"), which it does not do
for pages opened from disk. Run the script again after moving the
project. Its header lists how to remove both.

On first start, pick an empty folder such as `~/Pictures/Photoloft`.
Photoloft keeps imported photos, edits and albums in its hidden
`.library` folder there and writes exports to `Exports/<album>/`,
unless an album has a folder of its own.

- Import folder takes a folder with all its subfolders; Import photos
  takes single files. Dropping files or folders works too.
- Photos already in the library (same content, any file name) are
  skipped; those in the Trash come back, and with an album open they
  join it. An import that changes nothing leaves no undo step. Hidden
  folders, non-JPEG files and other programs' thumbnail and cache
  folders (`thumbs`, `thumbnails`, `previews`, `cache`, `*.lrdata`,
  `@eaDir`) are left out.
- Star keepers with `S` or the star on a thumbnail; the Starred view
  lists them.
- Add to album (selection bar, editor header, `G`) puts the selection,
  or the photo shown in the editor, into one or more albums. Typing
  filters the list; Down moves into it, and a click or Space ticks an
  album and clears the field. Enter or Add adds to the ticked albums
  and to a new album by the name typed; an existing album's name shows
  an error instead. Albums that already hold all the photos show
  ticked and greyed. Dragging the selection onto an album in the
  sidebar adds it there. An album holds each photo once: the toast
  counts the photos that went in, and an add that finds them all in
  place changes nothing and says so. One Ctrl+Z undoes the whole add.
- Rename (`R`) renames the selection, or the photo shown in the
  editor. The name may hold `{number}` (counted in the order shown
  from Start at, three digits or more), `{date}` and `{time}` (when
  taken, else when imported), and `{name}` (the photo's own name); the
  Insert buttons type them at the cursor. Each photo keeps its
  extension, and a preview shows the first and last name. One Ctrl+Z
  undoes it. The toast counts the photos whose name changed, and a
  rename that keeps every name records nothing and says so.
  Double-clicking the name in the editor still renames that photo in
  place.
- Folder in an album's Export dialog: Choose… picks a folder for that
  album, and its exports go straight into it, replacing files of the
  same name; Use library folder goes back to `Exports/<album>/`. The
  choice counts once Export is pressed. Exporting again into the same
  folder replaces the files of the last export there; after a switch,
  they stay where they are. When the folder is gone or access is
  refused, that album is skipped and the toast names the folder to
  choose again. Exporting several albums sends each to its own folder.
- Renames and album exports with photo names give each name once, case
  ignored: the first of equal names keeps it, and each repeat gets the
  lowest free -2, -3, skipping any name already in the list.
- In every dialog Enter presses the main button (the place search keeps
  Enter for its search), Esc cancels, Up / Down and Tab move between
  fields, and Space ticks a tick box or presses a button.
- Auto adjusts exposure, contrast, highlights, shadows, whites, blacks
  and vibrance. White balance has its own Auto button and eyedropper,
  since a guess cannot tell a colour cast from the colour of a scene.
  Auto judges the original under the photo's white balance, so it
  gives a photo the same settings each time, in the editor and the
  selection bar alike; a video is judged by its thumbnail's frame. In
  the editor the Auto button is greyed out while the photo has them;
  moving one of its sliders or the white balance makes it active
  again. In the selection bar the toast counts the photos that
  changed, and a run that changes none records nothing and says so.
- The Sort control orders any view by date taken, name or file size.
  Albums also have their custom order (drag to reorder) and remember
  their sort; dragging in a sorted album switches it to custom.
  Hovering a thumbnail shows the date taken or file size when sorted by
  them.

- Space opens the selected photo in the editor, like Enter or a
  double-click; arrows step, Space again returns to the grid. On a
  video Space plays and pauses, and Esc returns.
- Last import lists what the latest import added, with a button that
  moves its photos in no album to the Trash. In albums shows every
  album's photos on one page.
- Adjust date (selection bar) fixes a camera's wrong or missing clock:
  enter the real time of the first selected photo; selected photos with
  a date move by the same amount, those without one follow it one
  second apart in the order shown. Exports carry the corrected time.
- Info (selection bar, `I`) sets title, description, keywords, author,
  copyright and location for the selected photos and videos. A field
  whose values differ shows "Several values" and keeps each photo's own
  until you type; emptying a shared value removes it. Author and
  copyright are remembered for photos that have none. The location is
  a pin on an OpenStreetMap map: click the map, search a place (Enter
  asks OpenStreetMap's Nominatim) or paste coordinates such as
  `-16.5004, -151.7415` or `16°30'01.4"S 151°44'29.4"W`, which work
  offline. The map and the search are the only parts that go online.
- Exports carry the info as EXIF and XMP; originals stay untouched.
  "Remove camera locations" in the export dialog drops the locations
  cameras recorded; a location added in Photoloft is always written,
  and Remove location in the Info dialog leaves a photo without any.
- Videos (MP4, MOV) import, play (Space, K) and take the same colour
  and crop settings as photos. Album exports include them at 720p,
  1080p or original size, made by ffmpeg through the Photoloft service
  with a colour table computed from the preview's maths.
- An Olympus clip's date comes from the camera's clock text, unless
  another app has changed the clip's own date since. Clips imported
  before Photoloft read that text get the camera's time once, when the
  library opens; a toast says how many, and Ctrl+Z takes it back.
- Trim a video in the editor: drag the grips at the ends of the play bar,
  or press `I` and `O` to mark in and out where it plays; `0` to `9`
  jump to 0 % to 90 % of the clip. Play runs from the in mark to the out
  mark, the grid shows the trimmed length, and the export holds only the
  trimmed part, cut to the frame. The original stays whole; Reset trim
  or Ctrl+Z takes a trim back, and copied settings leave it out.

Press `?` in the app for keyboard shortcuts.

## Develop

- `npm run dev` serves the app on localhost with hot reload
- `npm test` runs the unit tests (Vitest)
- `npm run test:e2e` builds and runs the browser tests (Playwright,
  system Chromium with software WebGL)
- `npm run typecheck`
- `python3 -m unittest scripts/test_serve.py` tests the server and its
  ffmpeg video export
- `python3 -m unittest scripts/test_install_launcher.py` runs the
  install script against stand-in commands in a temporary home

`test/fixtures/make-fixtures.sh` regenerates the test photos
(ImageMagick and exiftool). `scripts/subset-icons.sh` rebuilds the
icon font after adding an icon to `src/styles/icons.scss`.

## Layout

- `src/colour.ts` and `src/shaders/develop.frag` hold the same colour
  maths; the browser tests compare their output
- `src/library.ts` has the pure album, trash, info and loading logic
- `src/geo.ts` reads pasted coordinates and searches places;
  `src/map.ts` holds the Info dialog's Leaflet map, one per app
- `src/storage.ts` reads and writes the library folder; saves alternate
  between two files so an interrupted save never loses the last good
  state
- `src/ui/` renders with lit-html, one template module per area, each
  with a matching stylesheet in `src/styles/`

## License

Photoloft is released under the MIT license; see [LICENSE](LICENSE).

## Credits

The built page bundles three projects under their own licenses;
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) holds their full
license texts.

- [Leaflet](https://leafletjs.com) draws the map in the Info dialog:
  BSD-2-Clause, Copyright (c) 2010-2023 Volodymyr Agafonkin and
  Copyright (c) 2010-2011 CloudMade.
- [lit-html](https://lit.dev) renders the interface: BSD-3-Clause,
  Copyright (c) 2017 Google LLC.
- [Lucide](https://lucide.dev) draws the icons, from the subset font
  `src/assets/icons.woff2` that `scripts/subset-icons.sh` builds: ISC,
  Copyright (c) 2026 Lucide Icons and Contributors. The icons Lucide
  derives from [Feather](https://feathericons.com), several of them in
  the subset, are MIT, Copyright (c) 2013-present Cole Bemis.

The map tiles (`tile.openstreetmap.org`) and the place search
(Nominatim) come from [OpenStreetMap](https://www.openstreetmap.org)
at run time. The map data is © OpenStreetMap contributors under the
[Open Database License](https://opendatacommons.org/licenses/odbl/)
(ODbL), which requires attribution: the map shows "© OpenStreetMap
contributors", linked to <https://www.openstreetmap.org/copyright>.
