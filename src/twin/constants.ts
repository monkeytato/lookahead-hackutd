/**
 * Twin palette + tuning. Carbon light shell, ISA-101 HMI: grayscale baseline,
 * color reserved for abnormal state (severity) and interaction (Blue 60).
 */
import type { Asset, AssetVisualState, Severity } from '../domain/types';

export const COLORS = {
  bg: '#f5f3ee',
  interactive: '#007e73',
  water: '#0f62fe',
  waterShallow: '#4589ff',
  rack: '#6f6f6f',
  rackGpu: '#525252',
  rackHover: '#8d8d8d',
  rackStale: '#c6c6c6',
  stripNormal: '#8d8d8d',
  stripStale: '#c6c6c6',
  wall: '#c6c6c6',
  label: '#8d8d8d',
  people: '#262626',
  peopleStale: '#a8a8a8',
  heatCold: '#1192e8',
  heatMid: '#f4f4f4',
  heatHot: '#da1e28',
} as const;

export const SEVERITY_COLOR: Record<Severity, string> = {
  normal: COLORS.stripNormal,
  advisory: '#f1c21b',
  warning: '#ff832b',
  critical: '#da1e28',
};

export const SEVERITY_WORD: Record<Severity, string> = {
  normal: 'Normal',
  advisory: 'Advisory',
  warning: 'Warning',
  critical: 'Critical',
};

export const SEVERITY_PRIORITY: Record<Severity, number> = { normal: 0, advisory: 3, warning: 2, critical: 1 };

/** Floor colours per zone kind — very light, subtly different. */
export const ZONE_FLOOR: Record<string, string> = {
  hall: '#e6e6e6',
  corridor: '#dcdcdc',
  ups: '#e1e1e1',
  battery: '#dedede',
  mechanical: '#e3e3e3',
  electrical: '#d6d6d6',
};

/** troika (drei Text) needs a font file; IBM Plex Sans 500 from fontsource. */
export const FONT_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans@5.0.8/files/ibm-plex-sans-latin-500-normal.woff';

export const WALL = { height: 0.6, thick: 0.15 };

/** Building overview framing. */
export const OVERVIEW = {
  target: [22, 0, 8.5] as const,
  elevationDeg: 35,
  azimuthDeg: 45,
  fov: 35,
  /** Radius (m) of the footprint the overview must contain. */
  radius: 25,
};

export const DEP_Y = 2.6;

export const isAbnormal = (v?: AssetVisualState) => !!v && v.severity !== 'normal';

export function zoneElevation(zones: { id: string; elevation: number }[], zoneId: string) {
  return zones.find((z) => z.id === zoneId)?.elevation ?? 0;
}

/** Top-centre of an asset in world space (pipe floats at ~3.2 m). */
export function assetTop(a: Asset, elev: number): [number, number, number] {
  if (a.type === 'pipe') return [a.pos.x, PIPE_Y + 0.3, a.pos.z];
  return [a.pos.x, elev + a.size.h, a.pos.z];
}

export function assetCenter(a: Asset, elev: number): [number, number, number] {
  if (a.type === 'pipe') return [a.pos.x, PIPE_Y, a.pos.z];
  return [a.pos.x, elev + a.size.h / 2, a.pos.z];
}

export const PIPE_Y = 3.2;

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
