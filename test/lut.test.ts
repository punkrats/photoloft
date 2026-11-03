import { describe, expect, it } from 'vitest'
import { colourParams, develop } from '../src/colour'
import { cubeLut } from '../src/lut'
import { colourOf, NEUTRAL_EDIT } from '../src/schema'

const neutral = colourOf(NEUTRAL_EDIT)

function rows(text: string) {
  const lines = text.trim().split('\n').slice(1)
  return lines.map(line => line.split(' ').map(Number))
}

describe('cubeLut', () => {
  it('writes a 33 point table, red changing fastest', () => {
    const text = cubeLut(neutral)
    expect(text.split('\n')[0]).toBe('LUT_3D_SIZE 33')
    const table = rows(text)
    expect(table).toHaveLength(33 ** 3)
    expect(table[1]).toEqual([1 / 32, 0, 0].map(v => Number(v.toFixed(6))))
    expect(table[33]).toEqual([0, Number((1 / 32).toFixed(6)), 0])
  })

  it('maps every point through the develop maths', () => {
    const colour = { ...neutral, exposure: 1, temperature: 40, vibrance: 30 }
    const params = colourParams(colour)
    const table = rows(cubeLut(colour))
    const at = (r: number, g: number, b: number) =>
      table[b * 33 * 33 + g * 33 + r]
    const expected = develop([10 / 32, 20 / 32, 5 / 32], params)
    at(10, 20, 5).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5))
  })
})
