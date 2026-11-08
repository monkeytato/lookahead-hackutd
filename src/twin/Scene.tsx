import { useCallback, useEffect, useMemo, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import type { TwinDerived, TwinProps } from './Twin';
import { COLORS, OVERVIEW, assetCenter, zoneElevation } from './constants';
import { Floors } from './Floors';
import { Racks } from './Racks';
import { Equipment } from './Equipment';
import { WaterLayer } from './WaterLayer';
import { HeatSlice } from './HeatSlice';
import { DependencyPath } from './DependencyPath';
import { People, type PlacedPerson } from './People';
import { RouteLine } from './RouteLine';
import { SelectionOutline } from './Markers';
import { AnchorProjector } from './AnchorProjector';
import type { AnchorRegistry } from './overlay';
import { CameraRig, overviewDistance, type FocusTarget } from './CameraRig';
import { AnimContext, type TwinAnim } from './anim';
import { AnimDriver } from './AnimDriver';
import { GhostHazards, HazardLayer } from './HazardLayer';
import { BuildFade, EventEffects, GhostAssets, HeatBloom } from './Effects';

/** Pixels the pointer may travel between down and up and still count as a click (not an orbit). */
export const CLICK_SLOP_PX = 5;

export function Scene(props: TwinProps & { derived: TwinDerived; anim: TwinAnim; registry: AnchorRegistry; placed: PlacedPerson[] }) {
  const { facility, water, t, selectedId, onSelect, route, highlightPath, layers, resetViewKey, registry, placed, run, derived, anim } = props;
  const { visual, presenter } = derived;
  const { zones, assets } = facility;
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);

  const racks = useMemo(() => assets.filter((a) => a.type === 'rack'), [assets]);
  const equipment = useMemo(() => assets.filter((a) => a.type !== 'rack'), [assets]);
  const hall = useMemo(() => zones.find((z) => z.kind === 'hall'), [zones]);
  const rackElev = useMemo(() => (racks[0] ? zoneElevation(zones, racks[0].zoneId) : 0), [racks, zones]);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  useEffect(() => { gl.domElement.style.cursor = hoveredId ? 'pointer' : ''; }, [hoveredId, gl]);

  const pick = useCallback((id: string, e: ThreeEvent<MouseEvent>) => {
    if (e.delta > CLICK_SLOP_PX) return;
    onSelect(id);
  }, [onSelect]);
  const floorClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    if (e.delta > CLICK_SLOP_PX) return;
    onSelect(null);
  }, [onSelect]);

  const toFocus = useCallback((id: string | null | undefined): FocusTarget | null => {
    const a = id ? assets.find((x) => x.id === id) : undefined;
    if (!a) return null;
    const c = assetCenter(a, zoneElevation(zones, a.zoneId));
    return { x: c[0], y: Math.min(c[1], 1.4), z: c[2], size: Math.max(a.size.w, a.size.d, a.size.h) };
  }, [assets, zones]);

  const selected = useMemo(() => assets.find((a) => a.id === selectedId) ?? null, [assets, selectedId]);
  // a person's pick wins; otherwise the presenter's stage focus
  const focusId = selected?.id ?? derived.focusId ?? null;
  const focus = useMemo(() => toFocus(focusId), [toFocus, focusId]);

  // newest critical event (presenter camera swings to it)
  const [event, setEvent] = useState<{ id: string; n: number } | null>(null);
  const onCritical = useCallback((id: string) => setEvent((e) => ({ id, n: (e?.n ?? 0) + 1 })), []);
  const eventFocus = useMemo(() => toFocus(event?.id), [toFocus, event]);

  // fog scales with the overview distance so the far side of the building stays legible
  const d = overviewDistance(size.width / Math.max(1, size.height));
  const fogNear = Math.max(45, d * 0.85);
  const fogFar = Math.max(110, d * 2.1);

  const ghostWater = derived.ghostT !== null && layers.water ? (water ?? run?.water) : undefined;

  return (
    <AnimContext.Provider value={anim}>
      <AnimDriver anim={anim} t={t} buildKey={derived.buildKey} />
      <color attach="background" args={[COLORS.bg]} />
      <fog attach="fog" args={[COLORS.bg, fogNear, fogFar]} />

      <hemisphereLight args={['#ffffff', '#c6c6c6', 1.65]} />
      <directionalLight
        position={[OVERVIEW.target[0] - 18, 42, OVERVIEW.target[2] + 26]}
        intensity={2.1}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-radius={3}
        shadow-camera-left={-34}
        shadow-camera-right={34}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-camera-near={5}
        shadow-camera-far={110}
      >
        <object3D attach="target" position={[...OVERVIEW.target]} />
      </directionalLight>

      {/* ground: shadow catcher that blends into the page background */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[22, -0.121, 9]} receiveShadow>
        <planeGeometry args={[220, 220]} />
        <shadowMaterial transparent opacity={0.07} />
      </mesh>

      <BuildFade>
        <Floors zones={zones} assets={assets} onFloorClick={floorClick} />
      </BuildFade>
      <Racks racks={racks} elevation={rackElev} visual={visual} hoveredId={hoveredId} onHover={setHoveredId} onPick={pick} />
      <Equipment assets={equipment} zones={zones} waypoints={facility.waypoints} visual={visual} hoveredId={hoveredId} onHover={setHoveredId} onPick={pick} />
      <HeatBloom racks={racks} elevation={rackElev} visual={visual} />
      <EventEffects assets={assets} zones={zones} visual={visual} onCritical={presenter ? onCritical : undefined} />

      {selected && <SelectionOutline asset={selected} zones={zones} />}

      {layers.water && water && water.frames.length > 0 && <WaterLayer grid={water} zones={zones} t={t} />}
      {run && <HazardLayer hazardAt={run.hazardAt} t={t} zones={zones} />}
      {layers.heat && hall && <HeatSlice hall={hall} racks={racks} visual={visual} />}

      {/* prediction ghost: hatched future water, dashed future fronts, dashed outlines on future losses */}
      {derived.ghostT !== null && ghostWater && ghostWater.frames.length > 0 && <WaterLayer grid={ghostWater} zones={zones} t={derived.ghostT} ghost />}
      {derived.ghostT !== null && run && <GhostHazards hazardAt={run.hazardAt} t={derived.ghostT} zones={zones} />}
      {derived.ghostT !== null && <GhostAssets assets={assets} zones={zones} ids={derived.ghostIds} />}

      {layers.deps && highlightPath && highlightPath.length > 1 && (
        <DependencyPath path={highlightPath} assets={assets} zones={zones} edges={facility.edges} />
      )}
      {layers.people && !presenter && <People placed={placed} />}
      {route && route.length > 1 && <RouteLine route={route} zones={zones} />}

      <AnchorProjector registry={registry} />

      <CameraRig
        focus={focus} focusKey={focusId} resetViewKey={resetViewKey}
        presenter={presenter} eventFocus={eventFocus} eventKey={event ? `${event.id}#${event.n}` : null}
      />
    </AnimContext.Provider>
  );
}
