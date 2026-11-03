export type Rotation = 0 | 90 | 180 | 270
export type Aspect = 'original' | 'free' | '1:1' | '4:3' | '3:2' | '16:9'

// Normalised to the rotated and flipped image: 0..1 of its width and
// height, origin top left.
export type Crop = { x: number, y: number, w: number, h: number }

export type Edit = {
  temperature: number
  tint: number
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  vibrance: number
  saturation: number
  angle: number
  rotate: Rotation
  flip: boolean
  crop: Crop | null
  aspect: Aspect
}

export type ColourKey =
  | 'temperature' | 'tint' | 'exposure' | 'contrast' | 'highlights'
  | 'shadows' | 'whites' | 'blacks' | 'vibrance' | 'saturation'

export type SliderKey = ColourKey | 'angle'
export type Colour = Pick<Edit, ColourKey>

export type Adjustment = {
  key: SliderKey
  label: string
  group: 'White balance' | 'Tone' | 'Presence' | 'Geometry'
  min: number
  max: number
  step: number
}

export const ADJUSTMENTS: Adjustment[] = [
  slider('temperature', 'Temperature', 'White balance'),
  slider('tint', 'Tint', 'White balance'),
  { ...slider('exposure', 'Exposure', 'Tone'), min: -4, max: 4, step: 0.05 },
  slider('contrast', 'Contrast', 'Tone'),
  slider('highlights', 'Highlights', 'Tone'),
  slider('shadows', 'Shadows', 'Tone'),
  slider('whites', 'Whites', 'Tone'),
  slider('blacks', 'Blacks', 'Tone'),
  slider('vibrance', 'Vibrance', 'Presence'),
  slider('saturation', 'Saturation', 'Presence'),
  { ...slider('angle', 'Angle', 'Geometry'), min: -45, max: 45, step: 0.1 }
]

export const COLOUR_KEYS = ADJUSTMENTS
  .map(a => a.key)
  .filter((key): key is ColourKey => key !== 'angle')

export const NEUTRAL_EDIT: Edit = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
  angle: 0,
  rotate: 0,
  flip: false,
  crop: null,
  aspect: 'original'
}

export function colourOf(edit: Edit): Colour {
  const entries = COLOUR_KEYS.map(key => [key, edit[key]])
  return Object.fromEntries(entries) as Colour
}

export function isEdited(edit: Edit) {
  const colour = COLOUR_KEYS.some(key => edit[key] !== 0)
  const geometry = edit.angle !== 0 || edit.rotate !== 0 || edit.flip
  return colour || geometry || edit.crop !== null
}

function slider(
  key: SliderKey, label: string, group: Adjustment['group']
): Adjustment {
  return { key, label, group, min: -100, max: 100, step: 1 }
}
