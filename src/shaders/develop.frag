#version 300 es
precision highp float;

// Mirrors src/colour.ts step for step.

in vec2 v_uv;
uniform sampler2D u_image;
uniform vec3 u_gains;
uniform float u_exposure;
uniform float u_shoulder;
uniform float u_lo;
uniform float u_hi;
uniform float u_shadows;
uniform float u_highlights;
uniform float u_contrast;
uniform float u_vibrance;
uniform float u_saturation;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float EDGE = 0.001;

vec3 toLinear(vec3 c) {
  vec3 low = c / 12.92;
  vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(low, high, step(vec3(0.04045), c));
}

vec3 toSrgb(vec3 c) {
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}

float shoulder(float x) {
  if (u_shoulder >= 1.0 || x <= u_shoulder) return x;

  float room = 1.0 - u_shoulder;
  return u_shoulder + room * (1.0 - exp(-(x - u_shoulder) / room));
}

float shadowHighlight(float y) {
  float ks = u_shadows > 0.0 ? 2.0 : 1.0;
  float kh = u_highlights < 0.0 ? 2.0 : 1.0;
  float lifted = y + u_shadows * ks * y * (1.0 - y) * (1.0 - y);
  return lifted + u_highlights * kh * lifted * lifted * (1.0 - lifted);
}

float toneRatio(float y) {
  float clamped = clamp(y, 0.0, 1.0);
  if (clamped < 1e-5) return 1.0 + u_shadows * (u_shadows > 0.0 ? 2.0 : 1.0);

  return shadowHighlight(clamped) / clamped;
}

float contrast(float x) {
  if (u_contrast < 0.0) return 0.5 + (x - 0.5) * (1.0 + 0.5 * u_contrast);

  float g = 1.0 + 1.2 * u_contrast;
  if (x < 0.5) return 0.5 * pow(2.0 * x, g);
  return 1.0 - 0.5 * pow(2.0 * (1.0 - x), g);
}

vec3 scaleChroma(vec3 c, float factor) {
  float y = dot(c, LUMA);
  return vec3(y) + (c - vec3(y)) * factor;
}

float skin(vec3 c) {
  if (!(c.r >= c.g && c.g >= c.b) || c.r - c.b < 0.05) return 0.0;

  float hue = 60.0 * (c.g - c.b) / (c.r - c.b);
  return 1.0 - smoothstep(0.0, 1.0, abs(hue - 25.0) / 20.0);
}

vec3 vibrance(vec3 c) {
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float weight = u_vibrance > 0.0
    ? (1.0 - sat) * (1.0 - sat) * (1.0 - 0.6 * skin(c))
    : 1.0 - sat;
  return scaleChroma(c, 1.0 + u_vibrance * weight);
}

void main() {
  bool outside = any(lessThan(v_uv, vec2(-EDGE))) ||
    any(greaterThan(v_uv, vec2(1.0 + EDGE)));
  if (outside) {
    outColor = vec4(0.0);
    return;
  }

  vec3 linear = toLinear(texture(u_image, v_uv).rgb) * u_gains * u_exposure;
  vec3 c = toSrgb(linear);
  c = vec3(shoulder(c.r), shoulder(c.g), shoulder(c.b));
  c = clamp((c - u_lo) / (u_hi - u_lo), 0.0, 1.0);

  c = clamp(c * toneRatio(dot(c, LUMA)), 0.0, 1.0);
  c = vec3(contrast(c.r), contrast(c.g), contrast(c.b));

  c = scaleChroma(vibrance(c), 1.0 + u_saturation);
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
