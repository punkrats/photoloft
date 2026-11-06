import {
  emptyLibrary, originalName, pickLibrary, VIDEO_EXTS, type Library,
  type Photo
} from './library'
import type { Progress } from './state'

// `seq` numbers the saves and `repairs` names the one-time repairs the
// library has had. Both are saved beside the library, outside the
// snapshots undo restores. `folders` holds the folder picked for each
// album's exports, by album id; handles cannot go into the library
// file, so they are kept in IndexedDB (`saveAlbumFolders`).
export type Dirs = {
  root: FileSystemDirectoryHandle
  data: FileSystemDirectoryHandle
  originals: FileSystemDirectoryHandle
  thumbs: FileSystemDirectoryHandle
  backups: FileSystemDirectoryHandle
  seq: number
  repairs: string[]
  folders: Record<string, FileSystemDirectoryHandle>
}

// These keep the app's former name on purpose: existing installs find
// their library folder and the pickers start where they last were.
const DB_NAME = 'lightbox'
const LIBRARY_PICKER = 'lightbox-library'
const IMPORT_PICKER = 'lightbox-import'

const EXPORT_PICKER = 'photoloft-export'

const STORE = 'handles'
const HANDLE_KEY = 'library'
const FOLDERS_KEY = 'export-folders'
const SLOTS = ['library-a.json', 'library-b.json']
const LEGACY_FILE = 'library.json'
const BACKUPS_KEPT = 10
const WRITE = { mode: 'readwrite' } as const

// ─── Remembered library folder ───────────────────────────────────────

export async function rememberedLibrary() {
  try {
    const db = await openDb()
    const handle = await request<FileSystemDirectoryHandle | undefined>(
      db.transaction(STORE).objectStore(STORE).get(HANDLE_KEY)
    )
    return handle ?? null
  } catch {
    return null
  }
}

export async function rememberLibrary(handle: FileSystemDirectoryHandle) {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  await request(tx.objectStore(STORE).put(handle, HANDLE_KEY))
}

export async function chooseLibrary() {
  const options = { id: LIBRARY_PICKER, startIn: 'pictures', ...WRITE }
  return window.showDirectoryPicker(options as DirectoryPickerOptions)
}

export async function chooseImportFolder() {
  const options = { id: IMPORT_PICKER, startIn: 'pictures', mode: 'read' }
  return window.showDirectoryPicker(options as DirectoryPickerOptions)
}

export async function hasAccess(handle: FileSystemDirectoryHandle) {
  return (await handle.queryPermission(WRITE)) === 'granted'
}

// Needs a user gesture when the browser has to ask again.
export async function grantAccess(handle: FileSystemDirectoryHandle) {
  if ((await handle.queryPermission(WRITE)) === 'granted') return true
  return (await handle.requestPermission(WRITE)) === 'granted'
}

function openDb() {
  const open = indexedDB.open(DB_NAME, 1)
  open.onupgradeneeded = () => open.result.createObjectStore(STORE)
  return request(open)
}

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// ─── Album export folders ────────────────────────────────────────────

// What IndexedDB keeps of the album folders: one entry per library
// folder, told apart with `isSameEntry`, so a library never sees the
// folders of another, a copy of it with the same album ids included.
type FolderEntry = {
  library: FileSystemDirectoryHandle
  folders: Record<string, FileSystemDirectoryHandle>
}

export async function chooseExportFolder() {
  const options = { id: EXPORT_PICKER, startIn: 'pictures', ...WRITE }
  return window.showDirectoryPicker(options as DirectoryPickerOptions)
}

async function rememberedFolders(root: FileSystemDirectoryHandle) {
  try {
    for (const entry of await folderEntries()) {
      if (await entry.library.isSameEntry(root)) return entry.folders
    }
  } catch {
    // Unreadable; albums with a picked folder ask for it again.
  }
  return {}
}

// Replaces this library's entry.
export async function saveAlbumFolders(dirs: Dirs) {
  try {
    const others: FolderEntry[] = []
    for (const entry of await folderEntries()) {
      if (!(await entry.library.isSameEntry(dirs.root))) others.push(entry)
    }
    const entries = [...others, { library: dirs.root, folders: dirs.folders }]
    const db = await openDb()
    const tx = db.transaction(STORE, 'readwrite')
    await request(tx.objectStore(STORE).put(entries, FOLDERS_KEY))
  } catch {
    // Only the next session misses it: its albums with a picked folder
    // ask for it again.
  }
}

async function folderEntries() {
  const db = await openDb()
  const get = db.transaction(STORE).objectStore(STORE).get(FOLDERS_KEY)
  return (await request<FolderEntry[] | undefined>(get)) ?? []
}

// Whether an export can go into the folder: access granted, asked for
// when the browser has to (which needs a user gesture), and the folder
// still there. A removed folder keeps its grant, so one step through
// its entries tells.
export async function openFolder(handle: FileSystemDirectoryHandle) {
  try {
    if (!(await grantAccess(handle))) return false
    await handle.values().next()
    return true
  } catch {
    return false
  }
}

// ─── Library file ────────────────────────────────────────────────────

export async function openLibrary(root: FileSystemDirectoryHandle) {
  const data = await root.getDirectoryHandle('.library', { create: true })
  const dirs: Dirs = {
    root,
    data,
    originals: await data.getDirectoryHandle('originals', { create: true }),
    thumbs: await data.getDirectoryHandle('thumbs', { create: true }),
    backups: await data.getDirectoryHandle('backups', { create: true }),
    seq: 0,
    repairs: [],
    folders: await rememberedFolders(root)
  }

  const files = await readAll(data, [...SLOTS, LEGACY_FILE])
  const current = pickLibrary(files)
  const picked = current ?? (files.length ? await newestBackup(dirs) : null)
  if (!picked && files.length) {
    throw new Error('The library file is damaged and no backup is readable')
  }
  if (!picked) return { dirs, library: emptyLibrary(), restored: null }

  dirs.seq = picked.seq
  dirs.repairs = picked.repairs
  await backup(dirs, picked.text)
  const restored = current ? null : picked.name
  return { dirs, library: picked.library, restored }
}

// Writes the slot the previous save did not use, so the other one keeps
// the last good state if this write is interrupted.
export async function saveLibrary(dirs: Dirs, library: Library) {
  const seq = dirs.seq + 1
  const text = JSON.stringify({ ...library, seq, repairs: dirs.repairs })
  await writeFile(dirs.data, SLOTS[seq % 2], text)
  dirs.seq = seq
}

async function backup(dirs: Dirs, text: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await writeFile(dirs.backups, `library-${stamp}.json`, text)

  const names = (await fileNames(dirs.backups)).sort()
  const old = names.slice(0, Math.max(0, names.length - BACKUPS_KEPT))
  await removeFiles(dirs.backups, old)
}

async function newestBackup(dirs: Dirs) {
  const names = (await fileNames(dirs.backups)).sort().reverse()
  for (const name of names) {
    const [file] = await readAll(dirs.backups, [name])
    const picked = file ? pickLibrary([file]) : null
    if (picked) return picked
  }
  return null
}

// Empty files count as missing: an interrupted first save leaves one
// behind before any content is written.
async function readAll(dir: FileSystemDirectoryHandle, names: string[]) {
  const texts = await Promise.all(names.map(name => readText(dir, name)))
  return names
    .map((name, i) => ({ name, text: texts[i] }))
    .filter((f): f is { name: string, text: string } => Boolean(f.text))
}

// ─── Photos and thumbnails ───────────────────────────────────────────

export async function readOriginal(dirs: Dirs, photo: Photo) {
  const handle = await dirs.originals.getFileHandle(originalName(photo))
  return handle.getFile()
}

// Writing a File streams it, so large videos never load whole.
export async function writeOriginal(dirs: Dirs, name: string, data: Blob) {
  await writeFile(dirs.originals, name, data)
}

export async function readThumb(dirs: Dirs, id: string) {
  return readOptional(dirs.thumbs, `${id}.jpg`)
}

export async function writeThumb(dirs: Dirs, id: string, data: Blob) {
  await writeFile(dirs.thumbs, `${id}.jpg`, data)
}

export async function deletePhotoFiles(dirs: Dirs, photos: Photo[]) {
  await removeFiles(dirs.originals, photos.map(originalName))
  await removeFiles(dirs.thumbs, photos.map(p => `${p.id}.jpg`))
}

// ─── Exports ─────────────────────────────────────────────────────────

export async function exportFolder(dirs: Dirs, folder: string) {
  const exports = await dirs.root.getDirectoryHandle('Exports', {
    create: true
  })
  return exports.getDirectoryHandle(folder, { create: true })
}

// Removes the folder only when it is empty, so files added by hand
// keep it alive.
export async function removeExportFolderIfEmpty(dirs: Dirs, folder: string) {
  try {
    const exports = await dirs.root.getDirectoryHandle('Exports')
    await exports.removeEntry(folder)
  } catch {
    // Missing or not empty.
  }
}

// ─── Import sources ──────────────────────────────────────────────────

export function isJpegName(name: string) {
  return /\.jpe?g$/i.test(name)
}

export function videoExt(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  return VIDEO_EXTS.find(e => e === ext) ?? null
}

// Thumbnail and cache folders of other photo programs: their files are
// small copies without capture dates.
const CACHE_FOLDER = /^(thumbs|thumbnails?|previews|cache|@eadir)$|\.lrdata$/i

// Walks dropped or picked entries and all their subfolders; returns
// the JPEG and video files, and how many other files were skipped.
// Hidden files and folders, other programs' thumbnail caches and the
// library folder itself are left out. `progress.done` counts the files
// found so far.
export async function collectFiles(
  entries: (File | FileSystemHandle)[],
  library: FileSystemDirectoryHandle,
  progress: Progress
) {
  const files: File[] = []
  let skipped = 0

  const visit = async (entry: File | FileSystemHandle): Promise<void> => {
    if (progress.cancel.signal.aborted || entry.name.startsWith('.')) return
    if (entry instanceof File) {
      if (isJpegName(entry.name) || videoExt(entry.name)) files.push(entry)
      else skipped++
      progress.done = files.length
      return
    }
    if (entry.kind === 'file') {
      return visit(await (entry as FileSystemFileHandle).getFile())
    }
    if (CACHE_FOLDER.test(entry.name)) return
    if (await entry.isSameEntry(library)) return

    for await (const child of (entry as FileSystemDirectoryHandle).values()) {
      await visit(child)
    }
  }

  for (const entry of entries) await visit(entry)
  return { files, skipped }
}

// ─── Primitives ──────────────────────────────────────────────────────

export async function writeFile(
  dir: FileSystemDirectoryHandle, name: string, data: Blob | string
) {
  const handle = await dir.getFileHandle(name, { create: true })
  const stream = await handle.createWritable()
  await stream.write(data)
  await stream.close()
}

export async function removeFiles(
  dir: FileSystemDirectoryHandle, names: string[]
) {
  for (const name of names) {
    try {
      await dir.removeEntry(name)
    } catch {
      // Already gone.
    }
  }
}

async function readOptional(dir: FileSystemDirectoryHandle, name: string) {
  try {
    const handle = await dir.getFileHandle(name)
    return await handle.getFile()
  } catch {
    return null
  }
}

async function readText(dir: FileSystemDirectoryHandle, name: string) {
  const file = await readOptional(dir, name)
  return file ? file.text() : null
}

async function fileNames(dir: FileSystemDirectoryHandle) {
  const names: string[] = []
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') names.push(entry.name)
  }
  return names
}
