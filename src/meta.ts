export type Location = { lat: number, lon: number }

export type Meta = {
  title?: string
  description?: string
  keywords?: string[]
  author?: string
  copyright?: string
  location?: Location | null
}
