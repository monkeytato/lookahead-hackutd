import { plainAsset } from '../views/plain';
import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { Asset, AssetVisualState, Severity, Zone } from '../domain/types';
import { COLORS, PIPE_Y, SEVERITY_COLOR, SEVERITY_PRIORITY, SEVERITY_WORD, assetTop, zoneElevation } from './constants';
import { useAnchor, type AnchorRegistry } from './overlay';

/** ISA-101 redundant coding: shape + number + word, colour last. */
export function SeverityGlyph({ severity }: { severity: Exclude<Severity, 'normal'> }) {
  const n = SEVERITY_PRIORITY[severity];
  const fill = SEVERITY_COLOR[severity];
  const text = severity === 'critical' ? '#ffffff' : '#161616';
  return (
    <svg className="twin-glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {severity === 'critical' && <rect x="1" y="1" width="14" height="14" fill={fill} />}
      {severity === 'warning' && <path d="M8 0.8 L15.4 14.6 L0.6 14.6 Z" fill={fill} />}
      {severity === 'advisory' && <circle cx="8" cy="8" r="7.2" fill={fill} />}
      <text x="8" y={severity === 'warning' ? 12.6 : 11.6} textAnchor="middle" fontSize="9.5" fontWeight="600" fill={text} fontFamily="IBM Plex Sans, sans-serif">{n}</text>
    </svg>
  );
}

const fmtClock = (m: number) => `T−${Math.max(0, Math.round(m))} min`;

function MarkerChip({ asset: a, v, zones, selected, registry, onSelect }: {
  asset: Asset;
  v?: AssetVisualState;
  zones: Zone[];
  selected: boolean;
  registry: AnchorRegistry;
  onSelect: (id: string) => void;
}) {
  const top = assetTop(a, zoneElevation(zones, a.zoneId));
  const sev = v?.severity ?? 'normal';
  // critical first, then warning, advisory; selection always on top
  const boost = selected ? 9 : 4 - SEVERITY_PRIORITY[sev] % 4;
  const ref = useAnchor(registry, `m:${a.id}`, [top[0], top[1] + 0.35, top[2]], boost);
  return (
    <div ref={ref} className="twin-anchor">
      <button
        type="button"
        className={`twin-marker twin-marker--${sev}${selected ? ' is-selected' : ''}`}
        onClick={(e) => { e.stopPropagation(); onSelect(a.id); }}
        aria-label={`${plainAsset(a.id)} ${SEVERITY_WORD[sev]}${v?.clockMin != null ? `, ${fmtClock(v.clockMin)}` : ''}`}
      >
        {sev !== 'normal' && <SeverityGlyph severity={sev} />}
        <span className="twin-marker__id">{plainAsset(a.id)}</span>
        <span className="twin-marker__word">
          {v?.lost ? 'Offline' : sev !== 'normal' ? SEVERITY_WORD[sev] : plainAsset(a.id)}
        </span>
        {v?.lost ? <span className="twin-marker__clock">LOST</span> : v?.clockMin != null && <span className="twin-marker__clock">{fmtClock(v.clockMin)}</span>}
        {v?.restored && !v.lost && <span className="twin-marker__fixed">fixed</span>}
      </button>
    </div>
  );
}

const SEV_SCORE: Record<Severity, number> = { normal: 0, advisory: 1, warning: 2, critical: 3 };

/** Urgency for label ranking: severity first, then least time left; lost assets sink below live clocks. */
function urgency(v: AssetVisualState): number {
  const clock = v.clockMin != null ? Math.max(0, 60 - v.clockMin) : 0;
  return SEV_SCORE[v.severity] * 1000 + clock * 10 - (v.lost ? 500 : 0);
}

/** DOM labels: only the most urgent few (plus selection / presenter focus) get one — no label soup. */
export function MarkerOverlay({ assets, zones, visual, selectedId, focusId, onSelect, registry, max = 5 }: {
  assets: Asset[];
  zones: Zone[];
  visual: Record<string, AssetVisualState>;
  selectedId?: string | null;
  focusId?: string | null;
  onSelect: (id: string) => void;
  registry: AnchorRegistry;
  max?: number;
}) {
  const list = useMemo(() => {
    const ranked = assets
      .filter((a) => { const v = visual[a.id]; return v && v.severity !== 'normal' && !v.quiet; })
      .sort((a, b) => urgency(visual[b.id]) - urgency(visual[a.id]) || a.id.localeCompare(b.id))
      .slice(0, max);
    for (const id of [selectedId, focusId]) {
      const a = id ? assets.find((x) => x.id === id) : undefined;
      if (a && !ranked.includes(a)) ranked.push(a);
    }
    return ranked;
  }, [assets, visual, selectedId, focusId, max]);

  return (
    <>
      {list.map((a) => (
        <MarkerChip key={a.id} asset={a} v={visual[a.id]} zones={zones} selected={a.id === selectedId} registry={registry} onSelect={onSelect} />
      ))}
    </>
  );
}

/** Blue box edges + footprint wash around the selected asset. */
export function SelectionOutline({ asset, zones }: { asset: Asset; zones: Zone[] }) {
  const { points, y, foot, cx, cz } = useMemo(() => {
    const elev = zoneElevation(zones, asset.zoneId);
    const pad = 0.06;
    const pipe = asset.type === 'pipe';
    const w = asset.size.w + pad * 2, d = asset.size.d + pad * 2, h = asset.size.h + pad;
    const quarter = asset.rot && Math.abs(Math.abs(asset.rot) - Math.PI / 2) < 1e-3;
    const ww = quarter ? d : w, dd = quarter ? w : d;
    const y0 = pipe ? PIPE_Y - asset.size.h / 2 - pad : elev, y1 = pipe ? PIPE_Y + asset.size.h / 2 + pad : elev + h;
    const x0 = -ww / 2, x1 = ww / 2, z0 = -dd / 2, z1 = dd / 2;
    const c = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const pts = E.flatMap(([a, b]) => [new THREE.Vector3(...c[a] as [number, number, number]), new THREE.Vector3(...c[b] as [number, number, number])]);
    return { points: pts, y: elev, foot: [ww + 0.3, dd + 0.3] as const, cx: asset.pos.x, cz: asset.pos.z };
  }, [asset, zones]);

  return (
    <group position={[cx, 0, cz]}>
      <Line points={points} segments color={COLORS.interactive} lineWidth={2} toneMapped={false} />
      <mesh position={[0, y + 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <planeGeometry args={[foot[0], foot[1]]} />
        <meshBasicMaterial color={COLORS.interactive} transparent opacity={0.12} depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
    </group>
  );
}
