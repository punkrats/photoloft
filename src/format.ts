import { realTaken } from './taken'

export function formatBytes(bytes: number) {
  if (!bytes) return 'Size unknown'
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`

  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

// Capture dates carry no time zone; they show as the camera clock read.
export function formatTaken(
  takenAt: string | null, locale?: string, seconds = false
) {
  const taken = realTaken(takenAt)
  if (!taken) return 'No date'

  const timeStyle = seconds ? 'medium' : 'short'
  const options = { dateStyle: 'medium', timeStyle } as const
  return new Intl.DateTimeFormat(locale, options).format(new Date(taken))
}

export function formatDuration(seconds: number) {
  const total = Number.isFinite(seconds) ? Math.round(seconds) : 0
  const two = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = total % 60
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

export function formatShift(ms: number) {
  if (ms === 0) return 'no change'

  const seconds = Math.round(Math.abs(ms) / 1000)
  const days = Math.floor(seconds / 86400)
  const parts = [
    days ? `${days} ${days === 1 ? 'day' : 'days'}` : '',
    unit(Math.floor(seconds / 3600) % 24, 'h'),
    unit(Math.floor(seconds / 60) % 60, 'min'),
    unit(seconds % 60, 's')
  ]
  return `${ms < 0 ? '-' : '+'}${parts.filter(Boolean).join(' ')}`
}

// "A", "A and B", "A, B and C".
export function formatList(names: string[]) {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function unit(value: number, name: string) {
  return value ? `${value} ${name}` : ''
}
