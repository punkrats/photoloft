import { realTaken } from './taken'

type Box = { start: number, end: number }

const EPOCH_1904 = 2082844800
const FILE_NAME_TIME = /(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)/

// Creation time from the movie header (mvhd): seconds since 1904, meant
// as UTC. Null when missing or obviously unset.
export function movieTime(bytes: Uint8Array): Date | null {
  const moov = findBox(bytes, 0, bytes.length, 'moov')
  const mvhd = moov ? findBox(bytes, moov.start, moov.end, 'mvhd') : null
  if (!mvhd || mvhd.end - mvhd.start < 12) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const version = bytes[mvhd.start]
  const seconds = version === 1
    ? Number(view.getBigUint64(mvhd.start + 4))
    : view.getUint32(mvhd.start + 4)
  const date = new Date((seconds - EPOCH_1904) * 1000)
  return date.getUTCFullYear() >= 1990 ? date : null
}

// Local capture time phones write into file names, such as
// VID_20240108_093000 or PXL_20231224_181512345.
export function nameTime(name: string) {
  const match = FILE_NAME_TIME.exec(name)
  if (!match) return null

  const [, y, mo, d, h, mi, s] = match
  return realTaken(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
}

export function localIso(date: Date) {
  const two = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-` +
    two(date.getDate())
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:` +
    two(date.getSeconds())
  return `${day}T${time}`
}

// The top-level `moov` box of a video file, read in pieces so large
// files never load whole.
export async function readMoov(file: Blob) {
  const read = async (from: number, to: number) =>
    new Uint8Array(await file.slice(from, to).arrayBuffer())

  let offset = 0
  while (offset + 8 <= file.size) {
    const head = await read(offset, offset + 16)
    const box = boxAt(head, 0, head.length)
    if (!box) return null

    const length = box.size || file.size - offset
    if (box.type === 'moov') return read(offset, offset + length)
    offset += length
  }
  return null
}

function findBox(bytes: Uint8Array, from: number, to: number, type: string) {
  let offset = from
  while (offset + 8 <= to) {
    const box = boxAt(bytes, offset, to)
    if (!box) return null
    const end = box.size ? offset + box.size : to
    if (box.type === type) return { start: offset + box.header, end } as Box
    offset = end
  }
  return null
}

function boxAt(bytes: Uint8Array, offset: number, to: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  let size = view.getUint32(offset)
  const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
  let header = 8
  if (size === 1) {
    if (offset + 16 > to) return null
    size = Number(view.getBigUint64(offset + 8))
    header = 16
  }
  if (size !== 0 && size < header) return null
  return { size, type, header }
}
