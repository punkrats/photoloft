const PATTERN = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)$/

// A capture date as `YYYY-MM-DDTHH:MM:SS`, or null when it cannot be a
// real one. Cameras with an unset clock write `0000:00:00 00:00:00`.
export function realTaken(value: string | null) {
  const match = value ? PATTERN.exec(value) : null
  if (!match) return null

  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number)
  const ok = year >= 1800 && month >= 1 && month <= 12 && day >= 1 &&
    day <= 31 && hour < 24 && minute < 60 && second < 61
  return ok && !Number.isNaN(Date.parse(value!)) ? value : null
}

// Capture times are clock readings without a time zone. Shifts treat
// them as plain numbers, so daylight saving never moves a photo.
export function takenDifference(from: string, to: string) {
  return naive(to) - naive(from)
}

export function shiftedTaken(taken: string, ms: number) {
  return new Date(naive(taken) + ms).toISOString().slice(0, 19)
}

function naive(taken: string) {
  return Date.parse(`${taken}Z`)
}
