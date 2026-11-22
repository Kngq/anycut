/**
 * Preview side of Filters: grades a clip's frame on the GPU with the same 3D LUT export feeds to
 * ffmpeg's lut3d (shared/filters.ts buildLut), so the look matches. The LUT is a WebGL2
 * TEXTURE_3D sampled with hardware trilinear filtering (lut3d uses interp=trilinear). Sharpen /
 * soften / grain / vignette mirror export's unsharp / gblur / noise / vignette.
 *
 * One shared offscreen canvas: renderFiltered() draws into it and the caller immediately
 * drawImage()s it onto the preview canvas.
 */
import { buildLut, filterFinish, LUT_SIZE, vignetteAngle, type FilterDef } from '@shared/filters'

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform sampler3D uLut;
uniform vec4 uRect;      // source sub-rect (crop) in 0..1 UVs: x, y, w, h
uniform vec2 uTexel;     // one output pixel in source UVs
uniform float uSharpen;
uniform float uSoften;   // blur radius in output pixels
uniform float uGrain;
uniform float uVignette; // ffmpeg vignette angle
uniform float uSeed;
uniform float uLutSize;
uniform float uAspect;  // output width / height

vec3 grade(vec3 c) {
  float n = uLutSize;
  vec3 uvw = c * ((n - 1.0) / n) + 0.5 / n;
  return texture(uLut, uvw).rgb;
}
vec4 tap(vec2 uv) {
  vec4 s = texture(uSrc, uv);
  return vec4(grade(s.rgb), s.a);
}
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21) + uSeed);
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
void main() {
  // The 2D canvas uploads top-down; flip so the output isn't upside down.
  vec2 uv = uRect.xy + vec2(vUv.x, 1.0 - vUv.y) * uRect.zw;
  vec4 c = tap(uv);
  if (uSoften > 0.0) {
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        vec2 o = vec2(float(x), float(y)) * uSoften * 0.5;
        float w = exp(-dot(vec2(x, y), vec2(x, y)) / 4.0);
        acc += tap(uv + o * uTexel) * w;
        wsum += w;
      }
    }
    c = acc / wsum;
  }
  if (uSharpen > 0.0) {
    vec4 blur = (tap(uv + vec2(uTexel.x, 0.0)) + tap(uv - vec2(uTexel.x, 0.0)) + tap(uv + vec2(0.0, uTexel.y)) + tap(uv - vec2(0.0, uTexel.y))) * 0.25;
    c.rgb = c.rgb + (c.rgb - blur.rgb) * uSharpen;
  }
  if (uVignette > 0.0) {
    vec2 d = (vUv - 0.5);
    // Pixel distance over the half-diagonal, as ffmpeg's vignette measures it.
    float dist = length(d * vec2(uAspect, 1.0)) / length(vec2(uAspect * 0.5, 0.5));
    float f = cos(uVignette * dist);
    c.rgb *= f * f * f * f;
  }
  if (uGrain > 0.0) {
    c.rgb += (hash(gl_FragCoord.xy) - 0.5) * uGrain;
  }
  outColor = vec4(clamp(c.rgb, 0.0, 1.0) * c.a, c.a);
}`

interface Gl {
  canvas: OffscreenCanvas | HTMLCanvasElement
  gl: WebGL2RenderingContext
  prog: WebGLProgram
  srcTex: WebGLTexture
  luts: Map<string, WebGLTexture>
  u: Record<string, WebGLUniformLocation | null>
}

let state: Gl | null | undefined

function init(): Gl | null {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true })
  if (!gl) return null
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error')
    return sh
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error')
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const srcTex = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, srcTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const u: Gl['u'] = {}
  for (const name of ['uSrc', 'uLut', 'uRect', 'uTexel', 'uSharpen', 'uSoften', 'uGrain', 'uVignette', 'uSeed', 'uLutSize', 'uAspect']) u[name] = gl.getUniformLocation(prog, name)
  gl.uniform1i(u.uSrc, 0)
  gl.uniform1i(u.uLut, 1)
  gl.uniform1f(u.uLutSize, LUT_SIZE)
  return { canvas, gl, prog, srcTex, luts: new Map(), u }
}

function lutTexture(s: Gl, def: FilterDef, intensity: number): WebGLTexture {
  const key = `${def.id}@${Math.round(intensity * 100)}`
  let tex = s.luts.get(key)
  if (tex) return tex
  const { gl } = s
  const lut = buildLut(def, Math.round(intensity * 100) / 100)
  tex = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_3D, tex)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE)
  // RGB32F isn't filterable everywhere; RGBA16F is, and is plenty for a colour LUT.
  const rgba = new Float32Array((lut.length / 3) * 4)
  for (let i = 0, j = 0; i < lut.length; i += 3, j += 4) {
    rgba[j] = lut[i]
    rgba[j + 1] = lut[i + 1]
    rgba[j + 2] = lut[i + 2]
    rgba[j + 3] = 1
  }
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, LUT_SIZE, LUT_SIZE, LUT_SIZE, 0, gl.RGBA, gl.FLOAT, rgba)
  gl.activeTexture(gl.TEXTURE0)
  if (s.luts.size > 24) {
    const [oldKey, old] = s.luts.entries().next().value as [string, WebGLTexture]
    gl.deleteTexture(old)
    s.luts.delete(oldKey)
  }
  s.luts.set(key, tex)
  return tex
}

/**
 * Grades `src` (its sub-rect sx,sy,sw,sh in source pixels) into an outW×outH canvas. Returns
 * null when WebGL2 isn't available (the caller then draws the ungraded frame).
 */
export function renderFiltered(
  src: TexImageSource & { width?: number; height?: number },
  srcW: number,
  srcH: number,
  rect: { sx: number; sy: number; sw: number; sh: number },
  outW: number,
  outH: number,
  def: FilterDef,
  intensity: number,
  timeSec: number
): HTMLCanvasElement | null {
  if (state === undefined) {
    try {
      state = init()
    } catch (err) {
      console.warn('[filters] WebGL2 unavailable, filters show ungraded in preview', err)
      state = null
    }
  }
  if (!state) return null
  const s = state
  const { gl } = s
  const w = Math.max(1, Math.round(outW))
  const h = Math.max(1, Math.round(outH))
  const canvas = s.canvas as HTMLCanvasElement
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  gl.viewport(0, 0, w, h)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_3D, lutTexture(s, def, intensity))
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, s.srcTex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
  const fin = filterFinish(def, intensity)
  gl.uniform4f(s.u.uRect, rect.sx / srcW, rect.sy / srcH, rect.sw / srcW, rect.sh / srcH)
  gl.uniform2f(s.u.uTexel, rect.sw / srcW / w, rect.sh / srcH / h)
  gl.uniform1f(s.u.uSharpen, fin.sharpen * 1.6)
  // Export blurs with sigma = soften·0.4 % of the source height; same fraction of the output.
  gl.uniform1f(s.u.uSoften, fin.soften * 0.004 * h)
  gl.uniform1f(s.u.uGrain, (fin.grain * 22) / 255)
  gl.uniform1f(s.u.uVignette, fin.vignette > 0 ? vignetteAngle(fin.vignette) : 0)
  gl.uniform1f(s.u.uAspect, w / h)
  gl.uniform1f(s.u.uSeed, (Math.floor(timeSec * 30) % 997) / 997)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  return canvas
}
