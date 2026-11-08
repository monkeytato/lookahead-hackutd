/**
 * Sensor coverage for the whole facility. The demo assumes every asset is instrumented: each one
 * reports the metrics that make physical sense for its type, at a normal value. This is the clean
 * starting state the Operations dashboard shows — it is not a live feed.
 */
import type { Asset, AssetType, Facility, ID, Metric } from './types';
import type { Reading } from './types';

/** The temperature sensor each type carries: rack inlet, battery cell, or supply water. */
const TEMP: Record<AssetType, Metric> = {
  rack: 'inlet_temp_c', battery: 'battery_temp_c', ups: 'battery_temp_c',
  crah: 'supply_temp_c', cdu: 'supply_temp_c', chiller: 'supply_temp_c', pump: 'supply_temp_c', pipe: 'supply_temp_c',
  drain: 'inlet_temp_c', pdu: 'inlet_temp_c', ats: 'inlet_temp_c', generator: 'inlet_temp_c', utility: 'inlet_temp_c',
};

/** Extra sensors beyond temperature, humidity and vibration. */
const EXTRA: Record<AssetType, Metric[]> = {
  rack: ['load_kw'],
  crah: ['flow_lpm', 'pressure_kpa'],
  cdu: ['flow_lpm', 'pressure_kpa'],
  chiller: ['flow_lpm', 'pressure_kpa'],
  pump: ['flow_lpm', 'pressure_kpa'],
  pipe: ['pressure_kpa', 'flow_lpm', 'leak'],
  drain: ['leak'],
  ups: ['load_kw', 'ups_autonomy_min'],
  battery: ['ups_autonomy_min'],
  pdu: ['load_kw'],
  ats: ['load_kw'],
  generator: ['load_kw'],
  utility: ['load_kw', 'pressure_kpa', 'flow_lpm'],
};

/** Short names for the sensor key, one row per metric. */
export const SENSOR_KEY: { metric: Metric; label: string; unit: string }[] = [
  { metric: 'inlet_temp_c', label: 'Rack inlet temp', unit: '°C' },
  { metric: 'supply_temp_c', label: 'Supply temp', unit: '°C' },
  { metric: 'battery_temp_c', label: 'Battery temp', unit: '°C' },
  { metric: 'dew_point_c', label: 'Dew point', unit: '°C' },
  { metric: 'humidity_rh', label: 'Humidity', unit: '%' },
  { metric: 'vibration_mm_s', label: 'Vibration', unit: 'mm/s' },
  { metric: 'pressure_kpa', label: 'Pressure', unit: 'kPa' },
  { metric: 'flow_lpm', label: 'Flow', unit: 'L/min' },
  { metric: 'load_kw', label: 'Load', unit: 'kW' },
  { metric: 'ups_autonomy_min', label: 'UPS runtime', unit: 'min' },
  { metric: 'leak', label: 'Liquid', unit: '' },
];

const NOMINAL: Record<Metric, number> = {
  inlet_temp_c: 22, supply_temp_c: 18, battery_temp_c: 24, dew_point_c: 10,
  humidity_rh: 45, vibration_mm_s: 1.2, pressure_kpa: 280, flow_lpm: 40,
  ups_autonomy_min: 30, load_kw: 5, leak: 0,
};

const UNIT: Record<Metric, string> = {
  inlet_temp_c: '°C', supply_temp_c: '°C', battery_temp_c: '°C', dew_point_c: '°C',
  humidity_rh: '%', vibration_mm_s: 'mm/s', pressure_kpa: 'kPa', flow_lpm: 'L/min',
  ups_autonomy_min: 'min', load_kw: 'kW', leak: '',
};

export function sensorsFor(asset: Asset): Metric[] {
  const core: Metric[] = [TEMP[asset.type], 'humidity_rh', 'vibration_mm_s'];
  return [...new Set([...core, ...(EXTRA[asset.type] ?? [])])];
}

/** One fresh, normal reading per sensor on every asset in the facility. */
export function sensorBaseline(facility: Facility): Reading[] {
  const out: Reading[] = [];
  for (const asset of facility.assets) {
    for (const metric of sensorsFor(asset)) {
      out.push({
        id: `BASE-${asset.id}-${metric}`,
        assetId: asset.id,
        metric,
        value: metric === 'load_kw' ? asset.loadKw ?? NOMINAL.load_kw : NOMINAL[metric],
        unit: UNIT[metric],
        t: 0,
        source: 'simulated',
        expectedIntervalMin: 5,
      });
    }
  }
  return out;
}

/** Sensor rows with the assets that report each one. */
export function sensorInventory(facility: Facility): { metric: Metric; label: string; unit: string; assetIds: ID[] }[] {
  return SENSOR_KEY.map((s) => ({
    ...s,
    assetIds: facility.assets.filter((a) => sensorsFor(a).includes(s.metric)).map((a) => a.id),
  })).filter((s) => s.assetIds.length > 0);
}
