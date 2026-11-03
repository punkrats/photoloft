#version 300 es

// a_pos runs 0..1 across the output region, origin top left.
in vec2 a_pos;
uniform mat3 u_transform;
out vec2 v_uv;

void main() {
  v_uv = (u_transform * vec3(a_pos, 1.0)).xy;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}
