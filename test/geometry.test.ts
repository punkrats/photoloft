import { describe, expect, it } from 'vitest'
import {
  applyMatrix, aspectCrop, autoCrop, bboxRegion, clampCrop, cropFits,
  effectiveCrop, fitCrop, horizonAngle, orientedSize, outputSize,
  resizeCrop, sourceMatrix, swapCrop
} from '../src/geometry'
import { NEUTRAL_EDIT, type Crop, type Edit } from '../src/schema'

const size = { w: 400, h: 300 }
const full: Crop = { x: 0, y: 0, w: 1, h: 1 }

function edit(extra: Partial<Edit>): Edit {
  return { ...NEUTRAL_EDIT, ...extra }
}

function close(actual: number[], expected: number[], digits = 6) {
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], digits))
}

function pixelRatio(crop: Crop, s = size) {
  return (crop.w * s.w) / (crop.h * s.h)
}

describe('orientedSize', () => {
  it('swaps for quarter turns', () => {
    expect(orientedSize(400, 300, 90)).toEqual({ w: 300, h: 400 })
    expect(orientedSize(400, 300, 180)).toEqual({ w: 400, h: 300 })
  })
})

describe('sourceMatrix', () => {
  const corners = (m: number[]) =>
    [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => applyMatrix(m, u, v))

  it('is the identity for a neutral edit', () => {
    const m = sourceMatrix(NEUTRAL_EDIT, size, full)
    close(corners(m).flat(), [0, 0, 1, 0, 0, 1, 1, 1])
  })

  it('maps the output top left to the source bottom left at 90', () => {
    const e = edit({ rotate: 90 })
    const m = sourceMatrix(e, size, full)
    close(applyMatrix(m, 0, 0), [0, 1])
    close(applyMatrix(m, 1, 0), [0, 0])
  })

  it('handles 180 and 270', () => {
    close(applyMatrix(sourceMatrix(edit({ rotate: 180 }), size, full), 0, 0),
      [1, 1])
    close(applyMatrix(sourceMatrix(edit({ rotate: 270 }), size, full), 0, 0),
      [1, 0])
  })

  it('mirrors horizontally when flipped', () => {
    const m = sourceMatrix(edit({ flip: true }), size, full)
    close(applyMatrix(m, 0, 0), [1, 0])
    close(applyMatrix(m, 0.25, 0.5), [0.75, 0.5])
  })

  it('maps the crop region', () => {
    const crop = { x: 0.25, y: 0.1, w: 0.5, h: 0.5 }
    const m = sourceMatrix(NEUTRAL_EDIT, size, crop)
    close(applyMatrix(m, 0, 0), [0.25, 0.1])
    close(applyMatrix(m, 1, 1), [0.75, 0.6])
  })

  it('keeps the centre and stays inside the image when straightened', () => {
    const e = edit({ angle: 12 })
    const region = autoCrop(size, 12, 4 / 3)
    const m = sourceMatrix(e, size, region)
    close(applyMatrix(m, 0.5, 0.5), [0.5, 0.5])
    for (const [x, y] of corners(m)) {
      expect(x).toBeGreaterThanOrEqual(-1e-9)
      expect(x).toBeLessThanOrEqual(1 + 1e-9)
      expect(y).toBeGreaterThanOrEqual(-1e-9)
      expect(y).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('rotates clockwise for positive angles', () => {

    // Clockwise on screen means the output top centre samples a source
    // point to the left of the source top centre.
    const m = sourceMatrix(edit({ angle: 10 }), size, full)
    const [x] = applyMatrix(m, 0.5, 0)
    expect(x).toBeLessThan(0.5)
  })
})

describe('autoCrop', () => {
  it('is the full image without an angle', () => {
    close(Object.values(autoCrop(size, 0, 4 / 3)), [0, 0, 1, 1])
  })

  it('fits and is maximal when straightened', () => {
    const crop = autoCrop(size, 8, 4 / 3)
    expect(cropFits(crop, size, 8)).toBe(true)
    expect(pixelRatio(crop)).toBeCloseTo(4 / 3, 6)

    const grown = { ...crop, w: crop.w * 1.01, h: crop.h * 1.01 }
    grown.x = 0.5 - grown.w / 2
    grown.y = 0.5 - grown.h / 2
    expect(cropFits(grown, size, 8)).toBe(false)
  })

  it('works for negative angles and other ratios', () => {
    const crop = autoCrop(size, -30, 1)
    expect(cropFits(crop, size, -30)).toBe(true)
    expect(pixelRatio(crop)).toBeCloseTo(1, 6)
  })
})

describe('cropFits / clampCrop / fitCrop', () => {
  it('rejects a crop outside the image', () => {
    expect(cropFits({ x: 0.5, y: 0, w: 0.6, h: 1 }, size, 0)).toBe(false)
  })

  it('stops a moved crop at the edge', () => {
    const valid = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }
    const wanted = { x: 0.8, y: 0.2, w: 0.5, h: 0.5 }
    const result = clampCrop(valid, wanted, size, 0)
    expect(result.x).toBeCloseTo(0.5, 3)
    expect(cropFits(result, size, 0)).toBe(true)
  })

  it('shrinks a crop that no longer fits after straightening', () => {
    const fitted = fitCrop(full, size, 15)
    expect(cropFits(fitted, size, 15)).toBe(true)
    expect(pixelRatio(fitted)).toBeCloseTo(4 / 3, 6)
  })
})

describe('effectiveCrop', () => {
  it('uses the auto crop when none is set', () => {
    const crop = effectiveCrop(edit({ angle: 5 }), size)
    expect(crop).toEqual(autoCrop(size, 5, 4 / 3))
  })

  it('uses the oriented size for quarter turns', () => {
    const crop = effectiveCrop(edit({ rotate: 90 }), size)
    close(Object.values(crop), [0, 0, 1, 1])
  })
})

describe('bboxRegion / outputSize', () => {
  it('equals the image at angle 0', () => {
    close(Object.values(bboxRegion(size, 0)), [0, 0, 1, 1])
  })

  it('grows to hold the rotated image', () => {
    const r = bboxRegion(size, 90)
    const px = outputSize(r, size)
    expect(px.w).toBe(300)
    expect(px.h).toBe(400)
  })

  it('rounds output pixels', () => {
    expect(outputSize({ x: 0, y: 0, w: 0.5, h: 0.5 }, size)).
      toEqual({ w: 200, h: 150 })
  })
})

describe('horizonAngle', () => {
  it('levels a line that falls to the right', () => {
    expect(horizonAngle(0, 100, 10)).toBeCloseTo(-5.71, 2)
  })

  it('treats the line direction as irrelevant', () => {
    expect(horizonAngle(0, -100, -10)).toBeCloseTo(-5.71, 2)
  })

  it('adds to the current angle', () => {
    expect(horizonAngle(3, 100, 10)).toBeCloseTo(-2.71, 2)
  })

  it('uses near-vertical lines as verticals', () => {
    expect(horizonAngle(0, 10, 100)).toBeCloseTo(5.71, 2)
  })

  it('clamps to the slider range', () => {
    expect(horizonAngle(40, 100, -30)).toBe(45)
  })
})

describe('resizeCrop', () => {
  const crop = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }

  it('moves', () => {
    close(Object.values(resizeCrop(crop, 'move', 0.1, -0.1, null, size)),
      [0.3, 0.1, 0.4, 0.4])
  })

  it('drags a free edge', () => {
    close(Object.values(resizeCrop(crop, 'e', 0.1, 0.3, null, size)),
      [0.2, 0.2, 0.5, 0.4])
    close(Object.values(resizeCrop(crop, 'n', 0, -0.1, null, size)),
      [0.2, 0.1, 0.4, 0.5])
  })

  it('keeps the ratio on a corner, anchored at the opposite corner', () => {
    const r = resizeCrop(crop, 'se', 0.2, 0, 4 / 3, size)
    expect(pixelRatio(r)).toBeCloseTo(4 / 3, 6)
    expect(r.x).toBeCloseTo(0.2, 6)
    expect(r.y).toBeCloseTo(0.2, 6)
    expect(r.w).toBeCloseTo(0.6, 6)
  })

  it('keeps the ratio on the nw corner', () => {
    const r = resizeCrop(crop, 'nw', -0.1, 0, 1, size)
    expect(pixelRatio(r)).toBeCloseTo(1, 6)
    expect(r.x + r.w).toBeCloseTo(0.6, 6)
    expect(r.y + r.h).toBeCloseTo(0.6, 6)
  })

  it('never collapses below the minimum size', () => {
    const r = resizeCrop(crop, 'w', 0.5, 0, null, size)
    expect(r.w).toBeCloseTo(0.02, 6)
  })
})

describe('aspectCrop / swapCrop', () => {
  it('fits the largest rect of the ratio inside the current crop', () => {
    const r = aspectCrop(full, '1:1', size, 0)
    expect(pixelRatio(r)).toBeCloseTo(1, 6)
    expect(r.h).toBeCloseTo(1, 6)
    expect(r.x + r.w / 2).toBeCloseTo(0.5, 6)
  })

  it('follows the crop orientation', () => {
    const tall = { x: 0.3, y: 0, w: 0.3, h: 1 }
    const r = aspectCrop(tall, '3:2', size, 0)
    expect(pixelRatio(r)).toBeCloseTo(2 / 3, 6)
  })

  it('returns free crops unchanged', () => {
    const c = { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }
    expect(aspectCrop(c, 'free', size, 0)).toBe(c)
  })

  it('swaps orientation and still fits', () => {
    const r = swapCrop(full, size, 0)
    expect(pixelRatio(r)).toBeCloseTo(3 / 4, 6)
    expect(cropFits(r, size, 0)).toBe(true)
  })
})
