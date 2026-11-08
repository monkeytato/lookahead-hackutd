import { Brand } from '../components/Brand';
import { EVIDENCE_FIGURES } from './evidenceFigures';
/**
 * CenterGuard landing page. Everything shown is an illustration built from the
 * simulated DAL-1 / Hall A fixture — no customer, uptime, savings or accuracy claims.
 */
import type { MouseEvent, ReactNode } from 'react';
import '../styles/tokens.css';
import './landing.css';

const DEMO = '#/app';

/* Evidence section: headline numbers and chart order. The charts themselves are generated (evidenceFigures.ts). */
const EVIDENCE_STATS = [
  { value: '2,048', label: 'physics trials per response option' },
  { value: '0', label: 'numbers written by Nemotron' },
  { value: '< 1 °C', label: 'error on an independent published restart' },
  { value: '82 % · 52 %', label: 'p10–p90 coverage, own vs widened priors (target 80 %)' },
];
const EVIDENCE_ORDER: { n: number; title: string; takeaway: string }[] = [
  { n: 3, title: 'Real failure, or a bad sensor?', takeaway: 'A portable reading turns an alarm into a probability. Near the baseline points to the sensor; near the alarm confirms a real condition; the middle asks for another scan.' },
  { n: 2, title: 'Minutes to each temperature limit', takeaway: 'Losing a CRAH pair’s fans is a matter of minutes. Losing the chillers while fans run takes several times longer, because the chilled-water loop holds cold.' },
  { n: 1, title: 'How one forecast is made', takeaway: 'Nemotron chooses which what-ifs to run and which rack to scan next. The physics engine computes and re-weights every number, and a validator removes any figure it did not produce.' },
  { n: 6, title: 'Backtest against published outages', takeaway: 'Tuned to Schneider Electric’s 12-minute case. The independent 5-minute restart lands within 1 °C; the 4-minute restart is over-predicted, a known miss.' },
  { n: 7, title: 'Consistency check: CFD room', takeaway: 'The source’s IT load is illegible, so it was inferred from the curve. A consistency check, not an independent validation.' },
  { n: 4, title: 'Failure odds from fleet data', takeaway: 'Per-demand failure probabilities from Idaho National Laboratory component reliability data, on a log scale.' },
  { n: 5, title: 'Texas heat stress', takeaway: 'Hours per year at or above 35 °C and 40 °C in Dallas–Fort Worth. Air-cooled chillers are rated at 35 °C and lose capacity above it.' },
  { n: 8, title: 'How often the range is right', takeaway: 'Share of simulated losses inside the predicted p10–p90 range: 82 % against the model’s own priors, 52 % against widened priors, versus an 80 % target.' },
];

/* ------------------------------------------------------------------ helpers */

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** In-page anchors scroll without changing the hash, so the app's hash router is not confused. */
function jump(e: MouseEvent<HTMLAnchorElement>, id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
}

function Anchor({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  return (
    <a href={`#${to}`} className={className} onClick={(e) => jump(e, to)}>
      {children}
    </a>
  );
}

/** ISA-101 priority symbol: shape + number, always paired with a word nearby. */
function Pri({ p, label }: { p: 1 | 2 | 3; label?: string }) {
  const word = label ?? (p === 1 ? 'Priority 1' : p === 2 ? 'Priority 2' : 'Priority 3');
  return (
    <span className={`lp-pri lp-pri-${p}`} role="img" aria-label={word}>
      {p === 2 ? (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M8 1.5 15 14.5H1z" className="lp-pri-tri" />
          <text x="8" y="13" textAnchor="middle">2</text>
        </svg>
      ) : (
        <span aria-hidden="true">{p}</span>
      )}
    </span>
  );
}

/* ------------------------------------------------------- isometric hall SVG */

const S = 7;
const COS = 0.866;
const H = 0.75; // vertical exaggeration for readability
type Pt = [number, number];
const iso = (x: number, z: number, y = 0): Pt => [(x - z) * COS * S, (x + z) * 0.5 * S - y * H * S];
const pts = (p: Pt[]) => p.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
const quad = (x: number, z: number, w: number, d: number, y = 0) =>
  pts([iso(x, z, y), iso(x + w, z, y), iso(x + w, z + d, y), iso(x, z + d, y)]);

interface Block { id: string; x: number; z: number; w: number; d: number; h: number; tone?: 'rack' | 'equip' }

const ROW_Z: Record<string, number> = { A: 4.6, B: 8.4, C: 14.6, D: 18.4 };
const rackX = (i: number) => 20 - (11 * 0.62) / 2 + i * 0.62;
const RACKS: Block[] = Object.entries(ROW_Z).flatMap(([row, z]) =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `${row}-${String(i + 1).padStart(2, '0')}`,
    x: rackX(i) - 0.3, z: z - 0.6, w: 0.6, d: 1.2, h: 2.2, tone: 'rack' as const,
  })),
);
const centred = (id: string, cx: number, cz: number, w: number, d: number, h: number): Block =>
  ({ id, x: cx - w / 2, z: cz - d / 2, w, d, h, tone: 'equip' });
const EQUIP: Block[] = [
  centred('CRAH-1', 9.2, 6.5, 1, 2.6, 2), centred('CRAH-2', 9.2, 16.5, 1, 2.6, 2),
  centred('CRAH-3', 29.2, 6.5, 1, 2.6, 2), centred('CRAH-4', 29.2, 16.5, 1, 2.6, 2),
  centred('UPS-A', 38.2, 3.2, 3.2, 1, 2), centred('UPS-B', 38.2, 8.6, 3.2, 1, 2),
  centred('BATT-A', 38.5, 15.2, 5, 0.8, 2), centred('BATT-B', 38.5, 20.4, 5, 0.8, 2),
  centred('CH-1', 3.4, 4, 4, 2.2, 2.2), centred('CH-2', 3.4, 20, 4, 2.2, 2.2),
];
const BLOCKS = [...RACKS, ...EQUIP].sort((a, b) => a.x + a.z + a.w + a.d - (b.x + b.z + b.w + b.d));

const ROOMS = [
  { x: 0, z: 0, w: 8, d: 24, label: 'Plant' },
  { x: 8, z: 0, w: 24, d: 24, label: 'Data Hall A' },
  { x: 32, z: 0, w: 2, d: 24, label: '' },
  { x: 34, z: 0, w: 10, d: 12, label: 'UPS room' },
  { x: 34, z: 12, w: 10, d: 12, label: 'Battery room' },
];

/** Water front from the PIPE-L2 riser, running south down the corridor and under the battery-room door. */
const WATER = pts([
  iso(32.4, 9.2), iso(33.9, 9.0), iso(34.0, 17.2), iso(36.6, 17.6), iso(37.2, 19.0),
  iso(34.0, 19.4), iso(33.6, 21.6), iso(32.2, 19.8),
]);

function IsoHall({ compact = false, label }: { compact?: boolean; label: string }) {
  const at = (id: string) => BLOCKS.find((b) => b.id === id)!;
  const a11 = at('A-11');
  const battB = at('BATT-B');
  const [mx, my] = iso(battB.x + battB.w / 2, battB.z + battB.d / 2, battB.h + 1.6);
  const [ax, ay] = iso(a11.x + a11.w / 2, a11.z + a11.d / 2, a11.h);
  const [lx, ly] = iso(33.2, 9.6);
  return (
    <svg className="lp-iso" viewBox={compact ? '-150 -14 422 258' : '-150 -14 422 268'} role="img" aria-label={label}>
      {ROOMS.map((r) => (
        <polygon key={`${r.x}-${r.z}`} points={quad(r.x, r.z, r.w, r.d)} className="lp-iso-floor" />
      ))}
      <polygon points={WATER} className="lp-iso-water" />
      {BLOCKS.map((b) => {
        const top = quad(b.x, b.z, b.w, b.d, b.h);
        const front = pts([iso(b.x, b.z + b.d), iso(b.x + b.w, b.z + b.d), iso(b.x + b.w, b.z + b.d, b.h), iso(b.x, b.z + b.d, b.h)]);
        const side = pts([iso(b.x + b.w, b.z), iso(b.x + b.w, b.z + b.d), iso(b.x + b.w, b.z + b.d, b.h), iso(b.x + b.w, b.z, b.h)]);
        const flag = b.id === 'BATT-B' ? ' lp-iso-p1' : b.id === 'A-11' ? ' lp-iso-disputed' : '';
        return (
          <g key={b.id} className={`lp-iso-block lp-iso-${b.tone}${flag}`}>
            <polygon points={front} className="lp-iso-l" />
            <polygon points={side} className="lp-iso-r" />
            <polygon points={top} className="lp-iso-t" />
          </g>
        );
      })}
      {/* leak origin */}
      <circle cx={lx} cy={ly} r="3" className="lp-iso-leak" />
      {/* P1 marker above BATT-B */}
      <line x1={mx} y1={my + 6} x2={mx} y2={my + 13} className="lp-iso-tick" />
      <rect x={mx - 6} y={my - 6} width="12" height="12" className="lp-iso-p1mark" />
      <text x={mx} y={my + 3.5} textAnchor="middle" className="lp-iso-p1num">1</text>
      {!compact && (
        <g className="lp-iso-labels">
          {ROOMS.filter((r) => r.label).map((r) => {
            const bottom = r.label === 'Battery room';
            const [tx, ty] = bottom ? iso(r.x + r.w, r.z + r.d) : iso(r.x + 0.6, r.z + r.d - 0.6);
            return <text key={r.label} x={tx} y={ty + 12} textAnchor={bottom ? 'middle' : 'start'}>{r.label}</text>;
          })}
          <text x={mx + 10} y={my + 3}>BATT-B</text>
          <text x={lx + 8} y={ly - 6} className="lp-iso-wlabel">PIPE-L2 leak</text>
          <line x1={ax} y1={ay} x2={ax - 18} y2={ay - 22} className="lp-iso-tick" />
          <text x={ax - 20} y={ay - 26} textAnchor="end">A-11 disputed</text>
        </g>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------ hero mini UI */

interface Clock { p: 1 | 2 | null; asset: string; what: string; value: string; range?: [number, number, number]; note: string }
const CLOCKS: Clock[] = [
  { p: 1, asset: 'BATT-B', what: 'wet', value: 'T−22 min', range: [14, 22, 31], note: '14–31 min' },
  { p: 2, asset: 'Rows C–D', what: 'cooling redundancy', value: 'T−34 min', note: 'CRAH-2 fan trip, if not serviced' },
  { p: null, asset: 'A-11', what: 'inlet', value: 'disputed', note: 'installed 34.2 · probe 24.1 °C' },
];

function ClockStrip() {
  return (
    <ol className="lp-clocks" aria-label="Countdown clocks">
      {CLOCKS.map((c) => (
        <li key={c.asset} className={`lp-clock${c.p ? ` lp-clock-p${c.p}` : ' lp-clock-disputed'}`}>
          <div className="lp-clock-head">
            {c.p ? <Pri p={c.p} /> : <span className="lp-pri lp-pri-q" role="img" aria-label="Unverified">?</span>}
            <span className="lp-clock-asset">{c.asset}</span>
            <span className="lp-clock-what">{c.what}</span>
          </div>
          <div className="lp-clock-value lp-mono">{c.value}</div>
          {c.range ? (
            <div className="lp-range" aria-hidden="true">
              <span className="lp-range-band" style={{ left: `${(c.range[0] / 60) * 100}%`, width: `${((c.range[2] - c.range[0]) / 60) * 100}%` }} />
              <span className="lp-range-mode" style={{ left: `${(c.range[1] / 60) * 100}%` }} />
            </div>
          ) : (
            <div className={`lp-range${c.p ? '' : ' lp-range-hatch'}`} aria-hidden="true" />
          )}
          <div className="lp-clock-note lp-mono">{c.note}</div>
        </li>
      ))}
    </ol>
  );
}

function HeroIllustration() {
  return (
    <figure className="lp-hero-fig">
      <div className="lp-screen">
        <div className="lp-screen-bar">
          <span>DAL-1 / Data Hall A</span>
          <span className="lp-mono">02:32 · night shift</span>
        </div>
        <ClockStrip />
        <div className="lp-screen-stage">
          <IsoHall label="Isometric schematic of Data Hall A: rack rows in gray, water spreading from the corridor riser toward the battery room, Priority 1 marker on battery string B, A-11 marked disputed." />
        </div>
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------------ content */

const STEPS: [string, string][] = [
  ['Detect', 'Installed telemetry, alarms and logs raise the first warning, with source and freshness shown.'],
  ['Verify', 'A technician takes an independent reading at the equipment to confirm or dispute the alarm.'],
  ['Assess', 'The dependency model estimates what fails next and when, as a range rather than a single number.'],
  ['Prioritize', 'Competing problems are ordered by service impact, time to consequence and evidence state.'],
  ['Assign', 'A supervisor approves who goes, matched on skills, zone access and availability.'],
  ['Navigate', 'The technician gets a walking route to the correct asset and confirms its ID on arrival.'],
  ['Complete', 'Checklist steps, readings and photos become evidence; the work is reviewed before it closes.'],
  ['Hand off', 'Open risks, decisions and unfinished work carry into a note for the next shift.'],
];

const PROBES = [
  { name: 'Temperature', unit: '°C', measures: 'Air temperature at the point where the probe is held, such as a rack inlet.', limit: 'Ambient air is not CPU or component temperature.' },
  { name: 'Humidity', unit: '% RH', measures: 'Relative humidity of the surrounding air, used with temperature for dew point.', limit: 'Humid air does not mean liquid is present, and dry air does not rule it out.' },
  { name: 'Vibration', unit: 'mm/s RMS', measures: 'Velocity at a fixed mounting point on rotating equipment, compared with that asset’s baseline.', limit: 'One window describes that point at that time, not the whole machine.' },
  { name: 'Liquid', unit: 'wet / dry', measures: 'Whether liquid is touching the probe contacts at floor level or a cable entry.', limit: 'One dry point does not exclude a leak elsewhere.' },
];

const INCIDENTS = [
  {
    title: 'Google Cloud, europe-west9 (Paris), April 2023',
    fact: '3 h 22 min',
    factLabel: 'from water leak to battery-room alert',
    body: 'A cooling-system water leak reached a battery room and led to a fire. The interval between the leak and the battery-room alert is the gap CenterGuard’s leak scenario is built around.',
    source: 'Google Cloud incident report',
  },
  {
    title: 'NaviSite, Silicon Valley',
    fact: '36 min',
    factLabel: 'of UPS before blackout',
    body: 'Utility power was lost and the generator did not start. Batteries carried the load for 36 minutes; the facility was then dark for roughly 40 minutes.',
    source: 'DatacenterDynamics',
  },
  {
    title: 'SK C&C, Pangyo, October 2022',
    fact: 'Li-ion fire',
    factLabel: 'beside UPS equipment',
    body: 'A lithium-ion battery fire next to UPS equipment cut power to the data center and took widely used services offline.',
    source: 'Korea Herald',
  },
];

/* --------------------------------------------------------- platform tiles */

function TwinTile() {
  return (
    <div className="lp-mock lp-mock-twin">
      <IsoHall compact label="Miniature 3D facility twin of Data Hall A at scenario minute 22." />
      <div className="lp-slider" aria-hidden="true">
        <div className="lp-slider-track">
          <span className="lp-slider-fill" style={{ width: '36.7%' }} />
          <span className="lp-slider-thumb" style={{ left: '36.7%' }} />
        </div>
        <div className="lp-slider-ticks lp-mono">
          <span style={{ left: 0 }}>T+0</span>
          <span style={{ left: '36.7%', transform: 'translateX(-50%)' }}>T+22</span>
          <span style={{ right: 0 }}>T+60</span>
        </div>
      </div>
    </div>
  );
}

const FACTORS: [string, number, string][] = [
  ['Service impact', 4, 'Rows C–D: 20 racks lose cooling redundancy'],
  ['Time to consequence', 3, 'Fan trip modeled at T+34 min'],
  ['Evidence', 4, 'Corroborated by reference probe'],
  ['Staff and travel', 2, 'Marcus Lee, plant room, ~2 min walk'],
];

function QueueTile() {
  return (
    <div className="lp-mock lp-mock-queue">
      <ol className="lp-q">
        <li className="lp-q-row lp-q-open">
          <Pri p={2} /><span className="lp-q-title">CRAH-2 fan vibration</span><span className="lp-q-state">corroborated</span>
        </li>
        <li className="lp-q-row"><span className="lp-pri lp-pri-q" aria-hidden="true">?</span><span className="lp-q-title">A-11 inlet</span><span className="lp-q-state">disagreement</span></li>
      </ol>
      <dl className="lp-factors">
        {FACTORS.map(([k, n, why]) => (
          <div key={k} className="lp-factor">
            <dt>{k}</dt>
            <dd>
              <span className="lp-factor-bar" aria-hidden="true">
                {Array.from({ length: 5 }, (_, i) => <span key={i} className={i < n ? 'on' : ''} />)}
              </span>
              <span className="lp-factor-why">{why}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PhoneTile() {
  const steps = ['Confirm asset ID, record fan speed', 'Mount probe on bearing stud', 'Capture 10 s RMS velocity'];
  return (
    <div className="lp-mock lp-mock-phone">
      <div className="lp-phone">
        <div className="lp-phone-top lp-mono">TSK-202 · accepted</div>
        <div className="lp-phone-title">Vibration check on CRAH-2 fan</div>
        <div className="lp-phone-route">
          <span className="lp-mono">Plant room</span><span aria-hidden="true">→</span>
          <span className="lp-mono">Main aisle W</span><span aria-hidden="true">→</span>
          <span className="lp-mono">S cold aisle W</span>
        </div>
        <ul className="lp-phone-steps">
          {steps.map((s, i) => (
            <li key={s} className={i < 1 ? 'done' : ''}>
              <span className="lp-check" aria-hidden="true">{i < 1 ? '✓' : ''}</span>{s}
            </li>
          ))}
        </ul>
        <div className="lp-phone-reading lp-mono">PRB-01 · 6.6 mm/s</div>
        <div className="lp-phone-btn">Attach reading</div>
      </div>
    </div>
  );
}

function HandoffTile() {
  return (
    <div className="lp-mock lp-mock-note">
      <div className="lp-note-head">
        <span>Night → Day handoff</span>
        <span className="lp-mono">06:00</span>
      </div>
      <div className="lp-note-who">Priya Raman → Reza Haddad</div>
      <div className="lp-note-group">Open risks</div>
      <ul className="lp-note-list">
        <li><Pri p={2} /> A-11 inlet sensor disagrees with probe (34.2 vs 24.1 °C). Firmware 4.8.1 suspected; recheck open.</li>
        <li><Pri p={3} /> B-07 is single-corded (side A only) since the October audit.</li>
      </ul>
      <div className="lp-note-group">Completed</div>
      <ul className="lp-note-list">
        <li><span className="lp-ok">Verified</span> CRAH-2 fan vibration, PRB-01 6.6 mm/s. Bearing inspection booked.</li>
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------------- page */

export function Landing() {
  return (
    <div className="lp">
      <a className="lp-skip" href="#lp-main" onClick={(e) => jump(e, 'lp-main')}>Skip to content</a>

      <header className="lp-header">
        <div className="lp-wrap lp-header-in">
          <a className="lp-wordmark" href="#/"><Brand /></a>
          <nav className="lp-nav" aria-label="Page sections">
            <Anchor to="workflow">How it works</Anchor>
            <Anchor to="platform">Platform</Anchor>
            <Anchor to="hardware">Hardware</Anchor>
            <Anchor to="evidence">Evidence</Anchor>
          </nav>
          <a className="lp-btn lp-btn-primary lp-header-cta" href={DEMO}>Open demo</a>
        </div>
      </header>

      <main id="lp-main" tabIndex={-1}>
        {/* 1. Hero */}
        <section className="lp-hero" aria-labelledby="lp-hero-h">
          <div className="lp-wrap lp-hero-grid">
            <div className="lp-hero-copy">
              <p className="lp-eyebrow">Data center operations</p>
              <h1 id="lp-hero-h" className="lp-display">Know which warning to trust—and what to fix first.</h1>
              <p className="lp-lede">
                Verify equipment conditions, compare the consequences of competing incidents, and guide the
                right technician through the next action—all from one shared facility map.
              </p>
              <div className="lp-actions">
                <a className="lp-btn lp-btn-primary" href={DEMO}>Open demo<span aria-hidden="true" className="lp-arrow">→</span></a>
                <Anchor to="workflow" className="lp-btn lp-btn-tertiary">See the workflow</Anchor>
              </div>
            </div>
            <HeroIllustration />
          </div>
        </section>

        {/* 2. Incident example */}
        <section className="lp-section lp-alt" aria-labelledby="lp-incident-h">
          <div className="lp-wrap">
            <p className="lp-eyebrow">Incident example · 02:10, night shift</p>
            <h2 id="lp-incident-h" className="lp-h2">Two warnings at once. One technician free.</h2>
            <p className="lp-body lp-measure">
              An installed sensor reports A-11 inlet at <span className="lp-mono">34.2 °C</span>. A minute later, CRAH-2
              fan vibration reaches <span className="lp-mono">6.4 mm/s</span> against a <span className="lp-mono">2.1 mm/s</span> baseline.
              By alarm severity alone, A-11 goes first.
            </p>

            <div className="lp-compare">
              <div className="lp-compare-col">
                <h3 className="lp-h3">Before verification <span className="lp-mono lp-dim">02:11</span></h3>
                <ol className="lp-rank">
                  <li>
                    <span className="lp-rank-n lp-mono">1</span>
                    <Pri p={1} />
                    <div>
                      <div className="lp-rank-title">A-11 inlet <span className="lp-mono">34.2 °C</span></div>
                      <div className="lp-rank-meta">Installed sensor · above ASHRAE 32 °C allowable</div>
                    </div>
                  </li>
                  <li>
                    <span className="lp-rank-n lp-mono">2</span>
                    <Pri p={2} />
                    <div>
                      <div className="lp-rank-title">CRAH-2 fan vibration <span className="lp-mono">6.4 mm/s</span></div>
                      <div className="lp-rank-meta">Installed sensor · ISO 10816 zone C</div>
                    </div>
                  </li>
                </ol>
              </div>

              <div className="lp-compare-mid">
                <h3 className="lp-h3">Reference probe <span className="lp-mono lp-dim">PRB-01</span></h3>
                <dl className="lp-probe">
                  <div><dt>A-11 front inlet, 1.6 m</dt><dd className="lp-mono">24.1 °C</dd></div>
                  <div><dt>CRAH-2 fan bearing stud</dt><dd className="lp-mono">6.6 mm/s</dd></div>
                </dl>
              </div>

              <div className="lp-compare-col">
                <h3 className="lp-h3">After verification <span className="lp-mono lp-dim">02:19</span></h3>
                <ol className="lp-rank">
                  <li className="lp-rank-moved">
                    <span className="lp-rank-n lp-mono">1</span>
                    <Pri p={2} />
                    <div>
                      <div className="lp-rank-title">CRAH-2 fan vibration</div>
                      <div className="lp-rank-meta"><strong>Corroborated abnormal condition.</strong> Losing CRAH-2 removes cooling redundancy for 20 racks in rows C–D.</div>
                      <div className="lp-rank-task lp-mono">Task: vibration check → Marcus Lee</div>
                    </div>
                  </li>
                  <li>
                    <span className="lp-rank-n lp-mono">2</span>
                    <span className="lp-pri lp-pri-q" role="img" aria-label="Unverified">?</span>
                    <div>
                      <div className="lp-rank-title">A-11 inlet</div>
                      <div className="lp-rank-meta"><strong>Measurement disagreement.</strong> Installed 34.2 °C vs probe 24.1 °C. The alarm stays open as a sensor-verification task, not a dismissal.</div>
                      <div className="lp-rank-task lp-mono">Task: check sensor mounting and firmware</div>
                    </div>
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        {/* 3. Workflow */}
        <section id="workflow" className="lp-section" aria-labelledby="lp-workflow-h" tabIndex={-1}>
          <div className="lp-wrap">
            <p className="lp-eyebrow">How it works</p>
            <h2 id="lp-workflow-h" className="lp-h2">One loop, from first warning to the next shift.</h2>
            <ol className="lp-rail">
              {STEPS.map(([name, text], i) => (
                <li key={name} className="lp-rail-step">
                  <span className="lp-rail-n lp-mono">{String(i + 1).padStart(2, '0')}</span>
                  <h3 className="lp-rail-name">{name}</h3>
                  <p className="lp-rail-text">{text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 4. Platform */}
        <section id="platform" className="lp-section lp-alt" aria-labelledby="lp-platform-h" tabIndex={-1}>
          <div className="lp-wrap">
            <p className="lp-eyebrow">Platform</p>
            <h2 id="lp-platform-h" className="lp-h2">The screens an operations team works in.</h2>
            <div className="lp-tiles">
              <article className="lp-tile">
                <div className="lp-tile-fig"><TwinTile /></div>
                <h3 className="lp-h3">3D facility twin</h3>
                <p className="lp-body">Scrub a time slider to see where water, heat or a power loss is modeled to reach next, and which assets are on the path.</p>
                <a className="lp-link" href={DEMO}>Open the 3D twin<span aria-hidden="true"> →</span></a>
              </article>
              <article className="lp-tile">
                <div className="lp-tile-fig"><QueueTile /></div>
                <h3 className="lp-h3">Priority queue</h3>
                <p className="lp-body">Each item shows the factors behind its position, so a supervisor can see why it ranks where it does and override it.</p>
              </article>
              <article className="lp-tile">
                <div className="lp-tile-fig"><PhoneTile /></div>
                <h3 className="lp-h3">Technician task screen</h3>
                <p className="lp-body">A phone-sized view with the route, the runbook checklist and a place to attach readings and photos as evidence.</p>
              </article>
              <article className="lp-tile">
                <div className="lp-tile-fig"><HandoffTile /></div>
                <h3 className="lp-h3">Shift handoff</h3>
                <p className="lp-body">Open risks, completed work and pending decisions, drawn from the shared log, for the incoming shift lead.</p>
              </article>
            </div>
          </div>
        </section>

        {/* 5. Hardware */}
        <section id="hardware" className="lp-section" aria-labelledby="lp-hardware-h" tabIndex={-1}>
          <div className="lp-wrap">
            <p className="lp-eyebrow">Portable verification</p>
            <h2 id="lp-hardware-h" className="lp-h2">An independent physical cross-check.</h2>
            <p className="lp-body lp-measure">
              Portable probes help teams compare reported conditions with measurements taken at the equipment.
              Disagreement becomes a verification task, not an automatic dismissal of the alarm.
            </p>
            <ul className="lp-probes">
              {PROBES.map((p) => (
                <li key={p.name} className="lp-probe-card">
                  <div className="lp-probe-head">
                    <h3 className="lp-h3">{p.name}</h3>
                    <span className="lp-mono lp-dim">{p.unit}</span>
                  </div>
                  <p className="lp-body">{p.measures}</p>
                  <p className="lp-limit"><span className="lp-limit-k">Limit</span>{p.limit}</p>
                </li>
              ))}
            </ul>
            <div className="lp-verdicts">
              <h3 className="lp-h3">What a verification can conclude</h3>
              <dl className="lp-verdict-list">
                <div><dt>Corroborated abnormal condition</dt><dd>The probe agrees the condition is abnormal.</dd></div>
                <div><dt>Measurement disagreement</dt><dd>The probe and the installed sensor differ. The sensor, its mounting or the equipment needs checking.</dd></div>
                <div><dt>Inconclusive</dt><dd>The reading was taken in the wrong place, too early, or with a probe that cannot answer the question.</dd></div>
                <div><dt>No corroboration observed</dt><dd>Nothing abnormal at that point, at that time. The alarm is not proven false.</dd></div>
              </dl>
            </div>
          </div>
        </section>

        {/* 6. Why the clock matters */}
        <section className="lp-section lp-alt" aria-labelledby="lp-clock-h">
          <div className="lp-wrap">
            <p className="lp-eyebrow">Why the clock matters</p>
            <h2 id="lp-clock-h" className="lp-h2">Small issues become outages on a timeline.</h2>
            <div className="lp-cases">
              {INCIDENTS.map((c) => (
                <article key={c.title} className="lp-case">
                  <h3 className="lp-case-title">{c.title}</h3>
                  <p className="lp-case-fact"><span className="lp-mono">{c.fact}</span> <span className="lp-case-factlabel">{c.factLabel}</span></p>
                  <p className="lp-body">{c.body}</p>
                  <p className="lp-source">Source: {c.source}</p>
                </article>
              ))}
            </div>
            <p className="lp-framing">
              We predict countdowns from known faults, not the date of rare events. Every clock shows a range and the
              assumption it rests on.
            </p>
          </div>
        </section>

        {/* 7. Evidence: every chart from the Prediction Science brief */}
        <section id="evidence" className="lp-section" aria-labelledby="lp-evidence-h" tabIndex={-1}>
          <div className="lp-wrap">
            <h2 id="lp-evidence-h" className="lp-h2">The numbers behind every forecast.</h2>
            <p className="lp-body lp-measure">
              Every chart below comes straight from our Prediction Science brief, built from the engine code, published
              outage data and our validation reports. Where the model misses or rests on an assumption, the chart says so.
            </p>
            <dl className="lp-ev-stats">
              {EVIDENCE_STATS.map((s) => (
                <div key={s.label}>
                  <dt>{s.label}</dt>
                  <dd className="lp-mono">{s.value}</dd>
                </div>
              ))}
            </dl>
            <div className="lp-ev-grid">
              {EVIDENCE_ORDER.map(({ n, title, takeaway }) => {
                const fig = EVIDENCE_FIGURES.find((f) => f.n === n)!;
                return (
                  <figure key={n} className={`lp-ev-card${n === 1 ? ' lp-ev-tall' : ''}`}>
                    <div className="lp-ev-head">
                      <h3 className="lp-h3">{title}</h3>
                    </div>
                    <p className="lp-body">{takeaway}</p>
                    <div className="lp-ev-chart" dangerouslySetInnerHTML={{ __html: fig.svg }} />
                  </figure>
                );
              })}
            </div>
            <p className="lp-framing">
              Coverage is measured against simulated outcomes, because we had no real facility incident data. That is why
              every range in the product is labeled “model range.”
            </p>
          </div>
        </section>

        {/* 8. Final CTA */}
        <section className="lp-cta" aria-labelledby="lp-cta-h">
          <div className="lp-wrap lp-cta-in">
            <h2 id="lp-cta-h" className="lp-h2 lp-on-inverse">Run the night-shift scenario.</h2>
            <div>
              <a className="lp-btn lp-btn-primary" href={DEMO}>Open demo<span aria-hidden="true" className="lp-arrow">→</span></a>
            </div>
          </div>
        </section>
      </main>

    </div>
  );
}

export default Landing;
