import { colourParams, type Params } from './colour'
import { sourceMatrix, toColumnMajor } from './geometry'
import { colourOf, NEUTRAL_EDIT, type Crop, type Edit } from './schema'
import fragmentSource from './shaders/develop.frag?raw'
import vertexSource from './shaders/develop.vert?raw'

export type Target = {
  region: Crop
  width: number
  height: number
  neutral?: boolean
}

type Canvas = HTMLCanvasElement | OffscreenCanvas

const UNIFORMS = [
  'u_transform', 'u_image', 'u_gains', 'u_exposure', 'u_shoulder', 'u_lo',
  'u_hi', 'u_shadows', 'u_highlights', 'u_contrast', 'u_vibrance',
  'u_saturation'
] as const

const NEUTRAL_PARAMS = colourParams(colourOf(NEUTRAL_EDIT))

// One WebGL2 context drawing a source image through the develop
// shader, either onto its canvas or into an offscreen buffer to read
// back. Survives context loss by keeping the source bitmap.
export class Renderer {
  readonly canvas: Canvas
  maxSize = 4096

  private gl: WebGL2RenderingContext
  private program: WebGLProgram | null = null
  private texture: WebGLTexture | null = null
  private uniforms = new Map<string, WebGLUniformLocation | null>()
  private source: ImageBitmap | null = null
  private mipmaps = true

  constructor(canvas: Canvas) {
    this.canvas = canvas
    const options = { alpha: true, antialias: false, premultipliedAlpha: true }
    const gl = canvas.getContext('webgl2', options)
    if (!gl) throw new Error('WebGL2 is not available')

    this.gl = gl as WebGL2RenderingContext
    this.setup()
    canvas.addEventListener('webglcontextlost', e => e.preventDefault())
    canvas.addEventListener('webglcontextrestored', () => this.restore())
  }

  get sourceSize() {
    return this.source
      ? { w: this.source.width, h: this.source.height }
      : null
  }

  // Video frames skip mipmaps: they change every frame and are shown
  // near their own size.
  setSource(bitmap: ImageBitmap, mipmaps = true) {
    this.source = bitmap
    this.mipmaps = mipmaps
    this.upload()
  }

  draw(edit: Edit, target: Target) {
    if (!this.prepare(edit, target)) return

    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (this.canvas.width !== target.width) this.canvas.width = target.width
    if (this.canvas.height !== target.height) {
      this.canvas.height = target.height
    }
    gl.viewport(0, 0, target.width, target.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  // RGBA rows, top first.
  read(edit: Edit, target: Target) {
    if (!this.prepare(edit, target)) return null

    const gl = this.gl
    const { width, height } = target
    const fbo = gl.createFramebuffer()
    const colour = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, colour)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0
    )

    gl.viewport(0, 0, width, height)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(colour)
    return flipRows(pixels, width, height)
  }

  dispose() {
    this.gl.deleteTexture(this.texture)
    this.gl.deleteProgram(this.program)
    this.texture = null
    this.source = null
  }

  private prepare(edit: Edit, target: Target) {
    if (!this.source || !this.program || this.gl.isContextLost()) return false

    const gl = this.gl
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniform1i(this.uniform('u_image'), 0)

    const size = { w: this.source.width, h: this.source.height }
    const matrix = toColumnMajor(sourceMatrix(edit, size, target.region))
    gl.uniformMatrix3fv(this.uniform('u_transform'), false, matrix)

    const params = target.neutral ? NEUTRAL_PARAMS : colourParams(edit)
    this.setColour(params)
    return true
  }

  private setColour(p: Params) {
    const gl = this.gl
    gl.uniform3fv(this.uniform('u_gains'), p.gains)
    gl.uniform1f(this.uniform('u_exposure'), p.exposure)
    gl.uniform1f(this.uniform('u_shoulder'), p.shoulder)
    gl.uniform1f(this.uniform('u_lo'), p.lo)
    gl.uniform1f(this.uniform('u_hi'), p.hi)
    gl.uniform1f(this.uniform('u_shadows'), p.shadows)
    gl.uniform1f(this.uniform('u_highlights'), p.highlights)
    gl.uniform1f(this.uniform('u_contrast'), p.contrast)
    gl.uniform1f(this.uniform('u_vibrance'), p.vibrance)
    gl.uniform1f(this.uniform('u_saturation'), p.saturation)
  }

  private uniform(name: string) {
    return this.uniforms.get(name) ?? null
  }

  private setup() {
    const gl = this.gl
    const program = gl.createProgram()
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
    }

    this.program = program
    for (const name of UNIFORMS) {
      this.uniforms.set(name, gl.getUniformLocation(program, name))
    }

    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])
    gl.bindVertexArray(gl.createVertexArray())
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const textureMax = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    this.maxSize = Math.min(textureMax, viewport[0], viewport[1])
  }

  private upload() {
    const gl = this.gl
    if (!this.source || gl.isContextLost()) return

    gl.deleteTexture(this.texture)
    this.texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.source
    )
    if (this.mipmaps) gl.generateMipmap(gl.TEXTURE_2D)

    const filter = this.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  private restore() {
    this.uniforms.clear()
    this.texture = null
    this.setup()
    this.upload()
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? 'compile failed')
  }
  return shader
}

function flipRows(pixels: Uint8Array, width: number, height: number) {
  const row = width * 4
  const out = new Uint8ClampedArray(pixels.length)
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * row
    out.set(pixels.subarray(from, from + row), y * row)
  }
  return out
}
