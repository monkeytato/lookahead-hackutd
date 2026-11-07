/**
 * Low-poly equipment silhouettes. Each asset becomes ONE merged BufferGeometry with
 * vertex colours (grayscale only), so the whole plant costs one draw call per asset.
 * Builders model the service front at local +z; the result is turned to face the
 * asset's access waypoint.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Asset, Waypoint } from '../domain/types';
import { PIPE_Y } from './constants';

const SHADE = {
  body: '#b9b9b9',
  panel: '#a4a4a4',
  detail: '#7a7a7a',
  dark: '#3d3d3d',
  light: '#d6d6d6',
};
type Shade = keyof typeof SHADE;

const tmpColor = new THREE.Color();

function paint(g: THREE.BufferGeometry, shade: Shade) {
  tmpColor.set(SHADE[shade]);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = tmpColor.r; arr[i * 3 + 1] = tmpColor.g; arr[i * 3 + 2] = tmpColor.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Box with its BOTTOM at y. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, shade: Shade) {
  return paint(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), shade);
}

/** Cylinder; axis 'y' (bottom at y), or 'x'/'z' (centred at y). */
function cyl(r: number, len: number, x: number, y: number, z: number, shade: Shade, axis: 'x' | 'y' | 'z' = 'y', seg = 18) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === 'y') g.translate(x, y + len / 2, z);
  else if (axis === 'x') { g.rotateZ(Math.PI / 2); g.translate(x, y, z); }
  else { g.rotateX(Math.PI / 2); g.translate(x, y, z); }
  return paint(g, shade);
}

type Parts = THREE.BufferGeometry[];

function cabinetRow(w: number, d: number, h: number, n: number, p: Parts, front: 'display' | 'shelves') {
  const cw = w / n;
  for (let i = 0; i < n; i++) {
    const cx = -w / 2 + cw * (i + 0.5);
    p.push(box(cw - 0.03, h, d, cx, 0, 0, 'body'));
    p.push(box(cw - 0.14, h - 0.25, 0.02, cx, 0.12, d / 2, 'panel'));
    if (front === 'display' && i === 0) p.push(box(0.22, 0.14, 0.03, cx, h * 0.72, d / 2 + 0.01, 'dark'));
    if (front === 'shelves') for (let s = 1; s < 4; s++) p.push(box(cw - 0.18, 0.025, 0.03, cx, (h * s) / 4, d / 2 + 0.01, 'detail'));
  }
  p.push(box(w, 0.04, d * 0.6, 0, h, 0, 'detail'));
}

function build(type: Asset['type'], w: number, d: number, h: number): Parts {
  const p: Parts = [];
  switch (type) {
    case 'crah': {
      p.push(box(w, h * 0.92, d, 0, 0, 0, 'body'));
      p.push(box(w * 0.94, h * 0.08, d * 0.94, 0, h * 0.92, 0, 'detail'));
      const slats = 9;
      for (let i = 0; i < slats; i++) {
        const sx = -w * 0.4 + (w * 0.8 * i) / (slats - 1);
        p.push(box(0.05, 0.03, d * 0.8, sx, h, 0, 'dark'));
      }
      p.push(box(w * 0.82, h * 0.7, 0.02, 0, 0.15, d / 2, 'panel'));
      p.push(box(0.04, 0.3, 0.04, w * 0.3, h * 0.45, d / 2 + 0.02, 'dark'));
      break;
    }
    case 'chiller': {
      p.push(box(w, 0.16, d, 0, 0, 0, 'dark'));
      const bodyH = h - 0.16 - 0.24;
      p.push(box(w * 0.98, bodyH, d * 0.96, 0, 0.16, 0, 'body'));
      // coil panels on the long sides
      const longX = w >= d;
      if (longX) for (const s of [-1, 1]) p.push(box(w * 0.9, bodyH * 0.6, 0.02, 0, 0.35, (s * d * 0.96) / 2, 'panel'));
      else for (const s of [-1, 1]) p.push(box(0.02, bodyH * 0.6, d * 0.9, (s * w * 0.96) / 2, 0.35, 0, 'panel'));
      const top = 0.16 + bodyH;
      p.push(box(w, 0.04, d, 0, top, 0, 'detail'));
      const L = Math.max(w, d), S = Math.min(w, d);
      const n = Math.max(2, Math.round(L / (S * 0.9)));
      const r = Math.min(S * 0.4, (L / n) * 0.42);
      for (let i = 0; i < n; i++) {
        const t = -L / 2 + (L * (i + 0.5)) / n;
        const fx = longX ? t : 0, fz = longX ? 0 : t;
        p.push(cyl(r, 0.2, fx, top + 0.04, fz, 'light', 'y', 24));
        p.push(cyl(r * 0.82, 0.21, fx, top + 0.04, fz, 'dark', 'y', 24));
        p.push(cyl(r * 0.16, 0.22, fx, top + 0.04, fz, 'detail', 'y', 12));
      }
      break;
    }
    case 'generator': {
      p.push(box(w, 0.2, d, 0, 0, 0, 'dark'));
      p.push(box(w * 0.82, h - 0.2, d * 0.92, -w * 0.06, 0.2, 0, 'body'));
      p.push(box(w * 0.14, (h - 0.2) * 0.9, d * 0.92, w * 0.42, 0.2, 0, 'detail'));
      for (let i = 0; i < 5; i++) p.push(box(w * 0.08, 0.5, 0.02, -w * 0.38 + i * w * 0.12, h * 0.45, (d * 0.92) / 2, 'dark'));
      p.push(cyl(0.13, 1.2, -w * 0.32, h - 0.05, 0, 'detail', 'y', 14));
      p.push(cyl(0.16, 0.1, -w * 0.32, h + 1.1, 0, 'dark', 'y', 14));
      break;
    }
    case 'ups':
      cabinetRow(w, d, h, Math.max(3, Math.round(w / 0.8)), p, 'display');
      break;
    case 'battery':
      cabinetRow(w, d, h, Math.max(4, Math.round(w / 0.62)), p, 'shelves');
      break;
    case 'pdu':
    case 'ats':
      p.push(box(w, h, d, 0, 0, 0, 'body'));
      p.push(box(w * 0.8, h * 0.8, 0.02, 0, h * 0.08, d / 2, 'panel'));
      p.push(box(w * 0.3, 0.12, 0.03, 0, h * 0.72, d / 2 + 0.01, 'dark'));
      p.push(box(w * 0.7, 0.04, d * 0.6, 0, h, 0, 'dark'));
      if (type === 'ats') p.push(box(0.05, 0.25, 0.05, w * 0.3, h * 0.42, d / 2 + 0.02, 'dark'));
      break;
    case 'cdu':
      p.push(box(w, h, d, 0, 0, 0, 'body'));
      p.push(box(w * 0.8, h * 0.75, 0.02, 0, h * 0.1, d / 2, 'panel'));
      p.push(cyl(0.07, 0.45, -w * 0.22, h, -d * 0.15, 'detail', 'y', 12));
      p.push(cyl(0.07, 0.45, w * 0.22, h, -d * 0.15, 'detail', 'y', 12));
      break;
    case 'utility': {
      p.push(box(w * 0.92, 0.12, d * 0.92, 0, 0, 0, 'dark'));
      p.push(box(w * 0.62, h * 0.72, d * 0.7, 0, 0.12, 0, 'body'));
      for (let i = 0; i < 6; i++) {
        const fz = -d * 0.3 + (d * 0.6 * i) / 5;
        for (const s of [-1, 1]) p.push(box(w * 0.14, h * 0.6, 0.03, s * w * 0.38, 0.18, fz, 'detail'));
      }
      for (let i = 0; i < 3; i++) {
        const bx = -w * 0.18 + i * w * 0.18;
        p.push(cyl(0.06, h * 0.22, bx, 0.12 + h * 0.72, 0, 'light', 'y', 10));
        p.push(cyl(0.09, 0.05, bx, 0.12 + h * 0.72 + h * 0.22, 0, 'dark', 'y', 10));
      }
      break;
    }
    case 'pump': {
      p.push(box(w, 0.12, d, 0, 0, 0, 'dark'));
      const mr = d * 0.26;
      p.push(cyl(mr, w * 0.5, -w * 0.18, 0.12 + mr + 0.06, 0, 'body', 'x'));
      p.push(cyl(d * 0.34, d * 0.32, w * 0.24, 0.12 + d * 0.34 + 0.02, 0, 'detail', 'z'));
      p.push(cyl(0.07, h - 0.12, w * 0.24, 0.12, -d * 0.1, 'detail', 'y', 12));
      p.push(cyl(0.07, w * 0.32, w * 0.42, 0.12 + d * 0.34, 0, 'detail', 'x', 12));
      break;
    }
    case 'drain':
      p.push(box(w, 0.015, d, 0, 0, 0, 'dark'));
      for (let i = 0; i < 4; i++) p.push(box(w * 0.85, 0.02, 0.025, 0, 0, -d * 0.3 + (i * d * 0.6) / 3, 'detail'));
      break;
    default:
      p.push(box(w, h, d, 0, 0, 0, 'body'));
  }
  return p;
}

/** The overhead riser: horizontal run along z at PIPE_Y with flanges, hangers and a riser stub. */
function buildPipe(len: number, r: number): Parts {
  const p: Parts = [];
  p.push(cyl(r / 2, len, 0, PIPE_Y, 0, 'detail', 'z', 20));
  const n = Math.max(2, Math.round(len / 2));
  for (let i = 0; i <= n; i++) {
    const z = -len / 2 + (len * i) / n;
    p.push(cyl(r / 2 + 0.05, 0.06, 0, PIPE_Y, z, 'dark', 'z', 20));
    if (i > 0 && i < n) {
      p.push(box(0.03, 1.1, 0.03, 0, PIPE_Y, z, 'dark'));
      p.push(box(0.4, 0.03, 0.08, 0, PIPE_Y + 1.1, z, 'dark'));
    }
  }
  // riser leg turning up toward Level 2 at the north end
  p.push(cyl(r / 2, 1.6, 0, PIPE_Y, -len / 2, 'detail', 'y', 20));
  return p;
}

/** Quarter-turn angle so local +z faces the access waypoint. */
export function facingAngle(a: Asset, wp?: Waypoint): number {
  if (!wp) return 0;
  const dx = wp.x - a.pos.x, dz = wp.z - a.pos.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? Math.PI / 2 : -Math.PI / 2;
  return dz >= 0 ? 0 : Math.PI;
}

export function buildAssetGeometry(a: Asset, wp?: Waypoint): THREE.BufferGeometry {
  if (a.type === 'pipe') {
    const g = mergeGeometries(buildPipe(a.size.d, a.size.w))!;
    return g;
  }
  const ang = facingAngle(a, wp);
  const quarter = Math.abs(Math.abs(ang) - Math.PI / 2) < 1e-3;
  // world footprint is (w along x, d along z); a quarter turn swaps the local axes
  const lw = quarter ? a.size.d : a.size.w;
  const ld = quarter ? a.size.w : a.size.d;
  const parts = build(a.type, lw, ld, a.size.h);
  const g = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  if (ang !== 0) g.rotateY(ang);
  g.computeBoundingSphere();
  return g;
}
