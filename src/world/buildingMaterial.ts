import * as THREE from 'three';

/**
 * MeshStandardMaterial patched to draw procedural facades on the instanced building chunks.
 * Per-instance attribute `aStyle` = (style id, random seed, soot 0..1, lit-window ratio).
 * Box face UVs (0..1) are used to lay out windows; top faces become roofs.
 */
export function createBuildingMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aStyle;
varying vec4 vStyle;
varying vec2 vFaceUv;
varying vec3 vObjNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vStyle = aStyle;
vFaceUv = uv;
vObjNormal = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec4 vStyle;
varying vec2 vFaceUv;
varying vec3 vObjNormal;
float bHash(vec2 p) { return fract(sin(dot(p, vec2(41.37, 289.13))) * 43758.5453); }
float bBox(vec2 uv, vec2 lo, vec2 hi) { return step(lo.x, uv.x) * step(uv.x, hi.x) * step(lo.y, uv.y) * step(uv.y, hi.y); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float gWin = 0.0;
vec3 gEmis = vec3(0.0);
{
  float style = floor(vStyle.x + 0.5);
  float seed = vStyle.y;
  float soot = clamp(vStyle.z, 0.0, 1.0);
  float litRatio = vStyle.w;
  vec3 an = abs(vObjNormal);
  vec2 uv = clamp(vFaceUv, 0.0, 1.0);
  float faceId = dot(step(vec3(0.5), an) * sign(vObjNormal), vec3(1.0, 2.0, 3.0));
  vec3 base = diffuseColor.rgb;
  vec3 col = base;
  if (an.y < 0.5) {
    float win = 0.0;
    float cellX = 0.0;
    float floorLine = 1.0 - step(0.045, uv.y);
    if (style < 0.5) {
      float gx = fract(uv.x * 3.0); cellX = floor(uv.x * 3.0);
      win = step(0.13, gx) * step(gx, 0.87) * step(0.3, uv.y) * step(uv.y, 0.86);
    } else if (style < 1.5) {
      float gx = fract(uv.x * 2.0); cellX = floor(uv.x * 2.0);
      win = step(0.16, gx) * step(gx, 0.84) * step(0.36, uv.y) * step(uv.y, 0.84);
      col = mix(col, base * 1.18, bBox(uv, vec2(0.0, 0.06), vec2(1.0, 0.17)));
    } else if (style < 2.5) {
      float gx = fract(uv.x * 2.0); cellX = floor(uv.x * 2.0);
      win = step(0.035, gx) * step(gx, 0.965) * step(0.08, uv.y) * step(uv.y, 0.97);
    } else if (style < 3.5) {
      win = bBox(uv, vec2(0.07, 0.07), vec2(0.93, 0.64));
      vec3 awn = 0.45 + 0.4 * cos(6.2831 * (seed * 3.7 + vec3(0.0, 0.33, 0.67)));
      col = mix(col, awn, bBox(uv, vec2(0.0, 0.68), vec2(1.0, 0.83)));
      litRatio = max(litRatio, 0.6);
    } else if (style < 4.5) {
      col *= 0.84 + 0.16 * step(0.5, fract(uv.y * 7.0));
    } else if (style < 5.5) {
      float d1 = abs(uv.x - uv.y);
      float d2 = abs(uv.x + uv.y - 1.0);
      float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
      float frame = 1.0 - step(0.085, min(min(d1, d2), edge));
      col = mix(base * 0.16, base, frame);
    } else if (style < 6.5) {
      col *= 0.8 + 0.2 * step(0.5, fract(uv.x * 9.0));
      float edge = 1.0 - step(0.035, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
      col = mix(col, base * 0.55, edge);
    } else if (style < 7.5) {
      float gx = fract(uv.x * 2.0); cellX = floor(uv.x * 2.0);
      win = step(0.27, gx) * step(gx, 0.73) * step(0.36, uv.y) * step(uv.y, 0.76);
    }
    col *= 1.0 - floorLine * 0.35 * step(style, 3.5);
    if (win > 0.5) {
      float h = bHash(vec2(seed * 91.7 + cellX * 7.13 + faceId * 3.1, seed * 13.3 + faceId * 1.7));
      float lit = step(h, litRatio) * (1.0 - step(0.25, soot));
      vec3 glass = mix(vec3(0.045, 0.06, 0.09), vec3(0.15, 0.19, 0.27), uv.y);
      if (style > 1.5 && style < 2.5) glass = mix(base * 0.4, vec3(0.16, 0.24, 0.34), 0.45) * (0.8 + 0.4 * uv.y);
      vec3 warm = mix(vec3(1.0, 0.66, 0.32), vec3(1.0, 0.88, 0.66), bHash(vec2(h, seed)));
      col = mix(glass, warm * 0.3, lit);
      gEmis = warm * lit * (0.45 + 0.6 * bHash(vec2(seed, h)));
      gWin = 1.0 - lit;
    }
  } else if (vObjNormal.y > 0.5) {
    float edge = 1.0 - step(0.07, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    col = mix(base * 0.58, base * 0.85, edge);
  } else {
    col = base * 0.3;
  }
  col = mix(col, vec3(0.03, 0.026, 0.024), soot * 0.9);
  gEmis *= 1.0 - soot;
  diffuseColor.rgb = max(col, vec3(0.0));
}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.14, gWin);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.35, gWin);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmis;');
  };
  return mat;
}
