import type { Photo } from './library'
import { localIso } from './mp4'

const UNSAFE = /[/\\:*?"<>|\u0000-\u001f]/g
const MAX_LENGTH = 120
const TOKENS = /\{(number|date|time|name)\}/g

type Named = Pick<Photo, 'name' | 'takenAt' | 'importedAt'>

export function sanitizeName(name: string) {
  const clean = name
    .replace(/\s+/g, ' ')
    .replace(UNSAFE, '-')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_LENGTH)

  return clean || 'Untitled'
}

export function albumFileNames(base: string, count: number, start: number) {
  const name = sanitizeName(base)
  return numbered(count, start).map(number => `${name}-${number}.jpg`)
}

export function originalFileNames(names: string[]) {
  const files = names.map(raw => {
    return /\.(jpe?g|mp4)$/i.test(raw) ? raw : `${raw}.jpg`
  })
  return unclashed(files)
}

// The names a rename gives the photos, in the order given: the
// pattern's {number}, {date}, {time} and {name} filled in for each and
// other braces left as typed, cleaned, with the photo's own extension.
export function renamedNames(pattern: string, photos: Named[], start: number) {
  const numbers = numbered(photos.length, start)
  const files = photos.map((photo, i) => {
    const [stem, ext] = splitExtension(photo.name)
    const clock = photoClock(photo)
    const values: Record<string, string> = {
      number: numbers[i],
      date: clock?.slice(0, 10) ?? '',
      time: clock?.slice(11).replaceAll(':', '-') ?? '',
      name: stem
    }
    const filled = pattern.replace(TOKENS, (_, token: string) => values[token])
    return `${sanitizeName(filled)}${ext}`
  })
  return unclashed(files)
}

export function previewNames(names: string[]) {
  return { first: names[0] ?? null, last: names.at(-1) ?? null }
}

export function withExtension(name: string, ext: string) {
  const [stem] = splitExtension(name)
  return `${stem}.${ext}`
}

// The name before its extension, and the extension with its dot; a
// leading dot starts none.
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

// Numbers from `start`, zero-padded to three digits, or more when the
// last one needs them.
function numbered(count: number, start: number) {
  const digits = Math.max(3, String(start + count - 1).length)
  return Array.from({ length: count }, (_, i) => {
    return String(start + i).padStart(digits, '0')
  })
}

// A name given before, case ignored, gets -2, -3 before its extension.
function unclashed(files: string[]) {
  const seen = new Map<string, number>()

  return files.map(file => {
    const key = file.toLowerCase()
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count === 1) return file

    const [stem, ext] = splitExtension(file)
    return `${stem}-${count}${ext}`
  })
}

// The clock reading for {date} and {time}: the capture time, which
// carries no time zone, else the import time in local time.
function photoClock(photo: Named) {
  if (photo.takenAt) return photo.takenAt

  const imported = new Date(photo.importedAt)
  return Number.isNaN(imported.getTime()) ? null : localIso(imported)
}
