import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Canvas } from '@react-three/fiber';
import type { Employee, Facility, AssetVisualState, HazardFrame, ImpactClock, WaterGrid, Waypoint } from '../domain/types';
import { useStageOptional } from '../stage/StageProvider';
import { OVERVIEW } from './constants';
import { CLICK_SLOP_PX, Scene } from './Scene';
import { AnchorRegistry } from './overlay';
import { MarkerOverlay } from './Markers';
import { PeopleOverlay, usePlacedPeople } from './People';
import { BUILD_S, TwinAnim } from './anim';
import './twin.css';

export interface TwinLayers { heat: boolean; water: boolean; deps: boolean; people: boolean }

/** The parts of a ScenarioRun the twin animates from (structural, so tests can pass a stub). */
export interface TwinRun {
  clocks: Record<string, ImpactClock>;
  water?: WaterGrid;
  hazardAt(t: number): HazardFrame[];
  restoredAt: Record<string, number>;
}

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
  /** Assets outlined as sensor marks (Operations key) */
  markIds?: string[];
  layers: TwinLayers;
  resetViewKey?: number;
  className?: string;
  // ---- live twin (all optional; without them the twin behaves as before) ----
  /** The scenario run: enables fire/smoke, the prediction ghost, lost/restored derivation */
  run?: TwinRun;
  /** Prediction overlay at t + lookaheadMin. Defaults to the stage's "Show prediction". */
  lookaheadMin?: number;
  /** Projector mode: bigger labels, fewer of them, idle orbit, swings to new critical events */
  presenter?: boolean;
  /** Camera focus requested by the presenter. Defaults to the stage's focus. */
  focusAssetId?: string | null;
  /** Changing this replays the build-in. Defaults to the stage's scenario id. */
  buildKey?: string;
}

export interface TwinDerived {
  visual: Record<string, AssetVisualState>;
  ghostT: number | null;
  ghostIds: string[];
  ghostRacks: number;
  focusId: string | null;
  buildKey: string;
  presenter: boolean;
}

/** Fill lost / restored / burning from the run when the incoming visual does not carry them yet. */
function enrich(visual: Record<string, AssetVisualState>, run: TwinRun | undefined, t: number, facility: Facility): Record<string, AssetVisualState> {
  if (!run) return visual;
  const fires = run.hazardAt(t).filter((h) => h.kind === 'fire' && !h.contained);
  const out: Record<string, AssetVisualState> = {};
  for (const a of facility.assets) {
    const v = visual[a.id];
    if (!v) continue;
    const restored = v.restored ?? (run.restoredAt[a.id] !== undefined && run.restoredAt[a.id] <= t);
    const p50 = run.clocks[a.id]?.p50;
    const lost = (v.lost ?? (p50 != null && p50 <= t)) && !restored;
    const burning = v.burning ?? fires.some((h) => Math.hypot(a.pos.x - h.x, a.pos.z - h.z) <= h.radiusM);
    out[a.id] = lost === v.lost && restored === v.restored && burning === v.burning ? v : { ...v, lost, restored, burning };
  }
  for (const id of Object.keys(visual)) if (!out[id]) out[id] = visual[id];
  return out;
}

/**
 * 3D digital twin viewport. Fills its parent. Renders on demand: frames run while the camera,
 * the clock glide, the build-in or a live effect (fire, pulses, ripples) is moving.
 */
export function Twin(props: TwinProps): JSX.Element {
  const down = useRef<{ x: number; y: number } | null>(null);
  const registry = useMemo(() => new AnchorRegistry(), []);
  const anim = useMemo(() => new TwinAnim(), []);
  const stage = useStageOptional();
  const placed = usePlacedPeople(props.employees, props.facility.waypoints, props.facility.zones, props.now);

  const presenter = !!props.presenter;
  const lookahead = Math.max(0, props.lookaheadMin ?? stage?.state.lookaheadMin ?? 0);
  const focusId = props.focusAssetId !== undefined ? props.focusAssetId : stage?.state.focusAssetId ?? null;
  const buildKey = props.buildKey ?? stage?.state.scenarioId ?? 'twin';

  // labels wait for the build-in, so chips never float over equipment that is not there yet
  const [building, setBuilding] = useState(!anim.reduced);
  useEffect(() => {
    if (anim.reduced) return;
    setBuilding(true);
    const id = window.setTimeout(() => setBuilding(false), BUILD_S * 1000 * 0.85);
    return () => window.clearTimeout(id);
  }, [buildKey, anim]);

  const visual = useMemo(() => enrich(props.visual, props.run, props.t, props.facility), [props.visual, props.run, props.t, props.facility]);

  const ghost = useMemo(() => {
    const run = props.run;
    if (!run || lookahead <= 0) return { ghostT: null, ghostIds: [] as string[], ghostRacks: 0 };
    const ghostT = props.t + lookahead;
    const rackIds = new Set(props.facility.assets.filter((a) => a.type === 'rack').map((a) => a.id));
    const ids: string[] = [];
    for (const [id, c] of Object.entries(run.clocks)) {
      if (c.p50 == null || c.p50 > ghostT || c.p50 <= props.t) continue;
      const fixedAt = run.restoredAt[id];
      if (fixedAt !== undefined && fixedAt <= c.p50) continue;
      ids.push(id);
    }
    return { ghostT, ghostIds: ids, ghostRacks: ids.filter((id) => rackIds.has(id)).length };
  }, [props.run, props.t, lookahead, props.facility.assets]);

  const derived: TwinDerived = { visual, ...ghost, focusId, buildKey, presenter };

  return (
    <div
      className={`twin${presenter ? ' twin--presenter' : ''}${props.className ? ` ${props.className}` : ''}`}
      onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
    >
      <Canvas
        frameloop="demand"
        shadows="percentage"
        flat
        dpr={[1, presenter ? 1.75 : 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: OVERVIEW.fov, near: 0.5, far: 400, position: [60, 40, 48] }}
        onPointerMissed={(e) => {
          const d = down.current;
          if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return;
          props.onSelect(null);
        }}
      >
        <Scene {...props} derived={derived} anim={anim} registry={registry} placed={placed} />
      </Canvas>
      <div className={building ? 'twin__overlay twin__overlay--building' : 'twin__overlay'}>
        <MarkerOverlay
          assets={props.facility.assets} zones={props.facility.zones} visual={visual}
          selectedId={props.selectedId} focusId={focusId} onSelect={props.onSelect} registry={registry}
          max={presenter ? 4 : 5}
        />
        {props.layers.people && !presenter && <PeopleOverlay placed={placed} selectedId={props.selectedId} registry={registry} />}
      </div>
      {ghost.ghostT !== null && (
        <div className="twin__prediction" role="status">
          <b>PREDICTION +{Math.round(lookahead)} MIN</b>
          <span>
            {ghost.ghostIds.length
              ? `${ghost.ghostIds.length} more asset${ghost.ghostIds.length === 1 ? '' : 's'} lost${ghost.ghostRacks ? ` (${ghost.ghostRacks} rack${ghost.ghostRacks === 1 ? '' : 's'})` : ''}`
              : 'no further losses'}
          </span>
          <i>engine forecast · dashed = not yet real</i>
        </div>
      )}
      <div className="twin__legend" aria-hidden="true">
        {props.layers.water && props.water && <span><i className="twin__sw twin__sw--water" />Water depth (0.5–10 mm)</span>}
        {props.layers.heat && <span><i className="twin__sw twin__sw--heat" />Inlet heat, indicative</span>}
        {ghost.ghostT !== null && <span><i className="twin__sw twin__sw--ghost" />Prediction +{Math.round(lookahead)} min</span>}
        {Object.values(visual).some((v) => v.restored) && <span><i className="twin__sw twin__sw--fixed" />Fix in effect</span>}
        {!presenter && <span><i className="twin__sw twin__sw--stale" />Stale data</span>}
        {props.layers.people && !presenter && <span><i className="twin__sw twin__sw--person" />Last check-in, not live</span>}
      </div>
    </div>
  );
}
