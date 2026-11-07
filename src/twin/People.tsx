import { useMemo, useState } from 'react';
import * as THREE from 'three';
import type { Employee, Waypoint, Zone } from '../domain/types';
import { CHECKIN_STALE_MIN } from '../domain/fixture';
import { COLORS, zoneElevation } from './constants';
import { useAnchor, type AnchorRegistry } from './overlay';

const POLE_H = 1.5;

export interface PlacedPerson { e: Employee; x: number; y: number; z: number; age: number; stale: boolean }

/** Last check-in positions; people sharing a waypoint are spread so chips don't stack. */
export function usePlacedPeople(employees: Employee[], waypoints: Waypoint[], zones: Zone[], now: number): PlacedPerson[] {
  return useMemo(() => {
    const wpById = new Map(waypoints.map((w) => [w.id, w]));
    const groups = new Map<string, Employee[]>();
    for (const e of employees) {
      if (!e.location) continue;
      const k = e.location.waypointId;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    const out: PlacedPerson[] = [];
    for (const [wpId, list] of groups) {
      const wp = wpById.get(wpId);
      if (!wp) continue;
      const y = zoneElevation(zones, wp.zoneId);
      list.forEach((e, i) => {
        const age = Math.max(0, Math.round(now - e.location!.t));
        out.push({ e, x: wp.x + (i - (list.length - 1) / 2) * 0.7, y, z: wp.z, age, stale: age > CHECKIN_STALE_MIN });
      });
    }
    return out;
  }, [employees, waypoints, zones, now]);
}

/**
 * Static markers at the last check-in. NEVER animated as if tracked live; a stale check-in
 * renders hollow and grey.
 */
export function People({ placed }: { placed: PlacedPerson[] }) {
  const geo = useMemo(() => ({
    disc: new THREE.CylinderGeometry(0.18, 0.18, 0.04, 28).translate(0, 0.02, 0),
    ring: new THREE.RingGeometry(0.13, 0.18, 28).rotateX(-Math.PI / 2).translate(0, 0.025, 0),
    pole: new THREE.CylinderGeometry(0.02, 0.02, POLE_H, 8).translate(0, POLE_H / 2, 0),
  }), []);
  const mat = useMemo(() => ({
    fresh: new THREE.MeshStandardMaterial({ color: COLORS.people, roughness: 0.7 }),
    stale: new THREE.MeshBasicMaterial({ color: COLORS.peopleStale, side: THREE.DoubleSide }),
  }), []);

  return (
    <group>
      {placed.map(({ e, x, y, z, stale }) => (
        <group key={e.id} position={[x, y, z]}>
          <mesh geometry={stale ? geo.ring : geo.disc} material={stale ? mat.stale : mat.fresh} />
          <mesh geometry={geo.pole} material={stale ? mat.stale : mat.fresh} />
        </group>
      ))}
    </group>
  );
}

function PersonChip({ p, open, registry, onHover, onToggle }: {
  p: PlacedPerson;
  open: boolean;
  registry: AnchorRegistry;
  onHover: (id: string | null) => void;
  onToggle: (id: string) => void;
}) {
  const ref = useAnchor(registry, `p:${p.e.id}`, [p.x, p.y + POLE_H + 0.05, p.z], open ? 8 : 0);
  return (
    <div ref={ref} className="twin-anchor">
      <div
        className={`twin-person${p.stale ? ' is-stale' : ''}${open ? ' is-open' : ''}`}
        onPointerEnter={() => onHover(p.e.id)}
        onPointerLeave={() => onHover(null)}
        onClick={(ev) => { ev.stopPropagation(); onToggle(p.e.id); }}
        title={`${p.e.name} — last check-in ${p.age} min ago`}
      >
        <span className="twin-person__initials">{p.e.initials}</span>
        {p.stale && <span className="twin-person__stale">stale</span>}
        {open && <span className="twin-person__age">{p.e.name.split(' ')[0]} · checked in {p.age} min ago</span>}
      </div>
    </div>
  );
}

/** Initials chips; "checked in N min ago" only on hover / click / selection. */
export function PeopleOverlay({ placed, selectedId, registry }: { placed: PlacedPerson[]; selectedId?: string | null; registry: AnchorRegistry }) {
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  return (
    <>
      {placed.map((p) => (
        <PersonChip
          key={p.e.id}
          p={p}
          open={hover === p.e.id || pinned === p.e.id || selectedId === p.e.id}
          registry={registry}
          onHover={(id) => setHover((h) => (id ?? (h === p.e.id ? null : h)))}
          onToggle={(id) => setPinned((x) => (x === id ? null : id))}
        />
      ))}
    </>
  );
}
