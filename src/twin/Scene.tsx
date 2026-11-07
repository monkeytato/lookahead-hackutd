import { useCallback, useEffect, useMemo, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import type { TwinProps } from './Twin';
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

/** Pixels the pointer may travel between down and up and still count as a click (not an orbit). */
export const CLICK_SLOP_PX = 5;

export function Scene(props: TwinProps & { registry: AnchorRegistry; placed: PlacedPerson[] }) {
  const { facility, visual, water, t, selectedId, onSelect, route, highlightPath, layers, resetViewKey, registry, placed } = props;
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

  const selected = useMemo(() => assets.find((a) => a.id === selectedId) ?? null, [assets, selectedId]);
  const focus = useMemo<FocusTarget | null>(() => {
    if (!selected) return null;
    const c = assetCenter(selected, zoneElevation(zones, selected.zoneId));
    return { x: c[0], y: Math.min(c[1], 1.4), z: c[2], size: Math.max(selected.size.w, selected.size.d, selected.size.h) };
  }, [selected, zones]);

  // fog scales with the overview distance so the far side of the building stays legible
  const d = overviewDistance(size.width / Math.max(1, size.height));
  const fogNear = Math.max(45, d * 0.85);
  const fogFar = Math.max(110, d * 2.1);

  return (
    <>
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

      <Floors zones={zones} assets={assets} onFloorClick={floorClick} />
      <Racks racks={racks} elevation={rackElev} visual={visual} hoveredId={hoveredId} onHover={setHoveredId} onPick={pick} />
      <Equipment assets={equipment} zones={zones} waypoints={facility.waypoints} visual={visual} hoveredId={hoveredId} onHover={setHoveredId} onPick={pick} />

      {selected && <SelectionOutline asset={selected} zones={zones} />}

      {layers.water && water && water.frames.length > 0 && <WaterLayer grid={water} zones={zones} t={t} />}
      {layers.heat && hall && <HeatSlice hall={hall} racks={racks} visual={visual} />}
      {layers.deps && highlightPath && highlightPath.length > 1 && (
        <DependencyPath path={highlightPath} assets={assets} zones={zones} edges={facility.edges} />
      )}
      {layers.people && <People placed={placed} />}
      {route && route.length > 1 && <RouteLine route={route} zones={zones} />}

      <AnchorProjector registry={registry} />

      <CameraRig focus={focus} focusKey={selected?.id ?? null} resetViewKey={resetViewKey} />
    </>
  );
}
