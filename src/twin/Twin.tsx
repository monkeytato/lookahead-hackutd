import { useMemo, useRef, type JSX } from 'react';
import { Canvas } from '@react-three/fiber';
import type { Employee, Facility, AssetVisualState, WaterGrid, Waypoint } from '../domain/types';
import { OVERVIEW } from './constants';
import { CLICK_SLOP_PX, Scene } from './Scene';
import { AnchorRegistry } from './overlay';
import { MarkerOverlay } from './Markers';
import { PeopleOverlay, usePlacedPeople } from './People';
import './twin.css';

export interface TwinLayers { heat: boolean; water: boolean; deps: boolean; people: boolean }

export interface TwinProps {
  facility: Facility;
  visual: Record<string, AssetVisualState>;
  water?: WaterGrid;
  /** Scenario minute being displayed */
  t: number;
  /** Same as t usually; used for check-in staleness */
  now: number;
  selectedId?: string | null;
  onSelect: (id: string | null) => void;
  employees: Employee[];
  route?: Waypoint[];
  /** Asset ids, fault → impacted node */
  highlightPath?: string[];
  layers: TwinLayers;
  resetViewKey?: number;
  className?: string;
}

/**
 * 3D digital twin viewport. Fills its parent. Renders on demand: frames run only while the
 * camera moves (orbit damping / fly-to) or props change.
 */
export function Twin(props: TwinProps): JSX.Element {
  const down = useRef<{ x: number; y: number } | null>(null);
  const registry = useMemo(() => new AnchorRegistry(), []);
  const placed = usePlacedPeople(props.employees, props.facility.waypoints, props.facility.zones, props.now);
  return (
    <div
      className={`twin${props.className ? ` ${props.className}` : ''}`}
      onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
    >
      <Canvas
        frameloop="demand"
        shadows="percentage"
        flat
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: OVERVIEW.fov, near: 0.5, far: 400, position: [60, 40, 48] }}
        onPointerMissed={(e) => {
          const d = down.current;
          if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return;
          props.onSelect(null);
        }}
      >
        <Scene {...props} registry={registry} placed={placed} />
      </Canvas>
      <div className="twin__overlay">
        <MarkerOverlay assets={props.facility.assets} zones={props.facility.zones} visual={props.visual} selectedId={props.selectedId} onSelect={props.onSelect} registry={registry} />
        {props.layers.people && <PeopleOverlay placed={placed} selectedId={props.selectedId} registry={registry} />}
      </div>
      <div className="twin__legend" aria-hidden="true">
        {props.layers.water && props.water && <span><i className="twin__sw twin__sw--water" />Water depth (0.5–10 mm)</span>}
        {props.layers.heat && <span><i className="twin__sw twin__sw--heat" />Inlet heat, indicative</span>}
        <span><i className="twin__sw twin__sw--stale" />Stale data</span>
        {props.layers.people && <span><i className="twin__sw twin__sw--person" />Last check-in, not live</span>}
      </div>
    </div>
  );
}
