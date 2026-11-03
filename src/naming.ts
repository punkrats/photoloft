const UNSAFE = /[/\\:*?"<>|\u0000-\u001f]/g
const MAX_LENGTH = 120

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
  const digits = Math.max(3, String(start + count - 1).length)

  return Array.from({ length: count }, (_, i) => {
    const number = String(start + i).padStart(digits, '0')
    return `${name}-${number}.jpg`
  })
}

export function originalFileNames(names: string[]) {
  const seen = new Map<string, number>()

  return names.map(raw => {
    const file = /\.(jpe?g|mp4)$/i.test(raw) ? raw : `${raw}.jpg`
    const key = file.toLowerCase()
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count === 1) return file

    const dot = file.lastIndexOf('.')
    return `${file.slice(0, dot)}-${count}${file.slice(dot)}`
  })
}

export function previewNames(names: string[]) {
  return { first: names[0] ?? null, last: names.at(-1) ?? null }
}

export function withExtension(name: string, ext: string) {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${stem}.${ext}`
}
