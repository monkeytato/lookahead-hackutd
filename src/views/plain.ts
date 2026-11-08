/**
 * Plain-language names for the dashboard. The engine's incident titles are precise but jargon;
 * what a person reads first should be short and human. Numbers stay in the evidence views.
 */
import type { Incident } from '../domain/types';

export const URGENCY_WORD: Record<Incident['severity'], string> = {
  critical: 'Critical',
  warning: 'Watch',
  advisory: 'Low',
  normal: 'OK',
};

/** Short title for an issue, chosen by what it is rather than by its alert text. */
export function plainIssue(inc: Incident): string {
  const t = inc.title.toLowerCase();
  if (t.includes('leak') || t.includes('make-up')) return 'Leaking cooling pipe';
  if (t.includes('vibration')) return 'Cooling fan vibrating';
  if (t.includes('batt') || t.includes('ups')) return 'Water near batteries';
  if (t.includes('inlet') || t.includes('temperature')) return 'Rack running hot';
  if (t.includes('power') || t.includes('feed')) return 'Power feed unstable';
  return inc.title.split(' — ')[0];
}

/**
 * Readable equipment name: Rack-2 / Pipe-2 instead of CRAH-2 / PIPE-L2. The equipment ids stay as
 * they are everywhere in the data; only what people read changes.
 */
export function plainAsset(id: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^CRAH-?(\d+)$/i.exec(id))) return `Rack-${m[1]}`;
  if ((m = /^A-?(\d+)$/i.exec(id))) return `Rack-${m[1]}`;
  if ((m = /^PIPE-[A-Z]?(\d+)$/i.exec(id))) return `Pipe-${m[1]}`;
  if ((m = /^BATT-([A-Z])$/i.exec(id))) return `Battery-${m[1].toUpperCase()}`;
  if ((m = /^UPS-([A-Z])$/i.exec(id))) return `Power-${m[1].toUpperCase()}`;
  if ((m = /^RACK-([A-Z]?\d+)$/i.exec(id))) return `Rack-${m[1].replace(/^A/i, '')}`;
  return id;
}

/** Replace equipment ids inside engine-provided sentences (task titles, runbook steps). */
export function plainText(s: string): string {
  return s.replace(/\b(CRAH-\d+|A-\d+|PIPE-[A-Z]?\d+|BATT-[A-Z]|UPS-[A-Z]|RACK-[A-Z]?\d+)\b/g, (m) => plainAsset(m));
}

/** Where it is, in as few words as possible. */
export function plainPlace(zone: string | undefined, assetId: string | undefined): string {
  if (!zone) return assetId ? plainAsset(assetId) : '';
  return assetId ? `${zone} · ${plainAsset(assetId)}` : zone;
}

export function plainEvidence(word: 'unverified' | 'inconclusive' | 'corroborated_abnormal' | string): string {
  switch (word) {
    case 'unverified': return 'Unconfirmed';
    case 'corroborated_abnormal': return 'Confirmed';
    case 'inconclusive': return 'Inconclusive';
    case 'measurement_disagreement': return 'Sensors disagree';
    case 'not_corroborated_in_session': return 'Not confirmed';
    default: return 'Checking';
  }
}
