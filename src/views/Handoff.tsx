import { useMemo, useState } from 'react';
import { facility } from '../domain/fixture';
import { buildHandoff, handoffToMarkdown } from '../domain/engine';
import { makeEvent, useOps, wallClock } from '../state/store';
import { visibleClocks } from '../state/selectors';
import { Btn, Src } from '../components/primitives';
import type { OpEvent } from '../domain/types';

/** What is happening · verified · uncertain · done · who owns the next action · don't repeat. */
export function HandoffView() {
  const { state, dispatch, run, scenario, visibleIncidents } = useOps();
  const t = state.t;
  const [note, setNote] = useState('');
  const clocks = useMemo(() => Object.fromEntries(visibleClocks(run.clocks, scenario, t).map((c) => [c.assetId, c])), [run, scenario, t]);
  const vis = run.visualAt(t);
  const staleAssetIds = Object.entries(vis).filter(([, v]) => v.freshness === 'stale').map(([k]) => k);
  const events = useMemo(() => {
    const derived: OpEvent[] = run.stepsUntil(t).map((s, i) => ({ id: `SIM-${i}`, t: s.t, ingestedAt: '', kind: s.kind === 'alert' ? 'alert' : 'telemetry', actor: 'simulator', summary: s.summary, links: { assetId: s.assetId }, source: 'simulated' }));
    return [...derived, ...state.events.filter((e) => e.t <= t)].sort((a, b) => a.t - b.t);
  }, [run, state.events, t]);
  const h = useMemo(() => buildHandoff({ now: t, incidents: visibleIncidents, tasks: state.tasks, employees: state.employees, events, verifications: state.verifications, clocks, staleAssetIds, facility }), [t, visibleIncidents, state.tasks, state.employees, events, state.verifications, clocks, staleAssetIds]);

  const download = (name: string, body: string, type: string) => {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click(); URL.revokeObjectURL(url);
  };
  // fold per-asset stale lines into one line ("C-06, C-07 … 7 assets") — a handoff is read, not scanned
  const staleRe = /^(\S+): telemetry stale/;
  const staleIds = h.uncertain.map((u) => staleRe.exec(u)?.[1]).filter(Boolean) as string[];
  if (staleIds.length > 2) {
    h.uncertain = [...h.uncertain.filter((u) => !staleRe.test(u)), `Telemetry stale on ${staleIds.length} assets (${staleIds.join(', ')}) — last values may not reflect current state; do not read them as calm.`];
  }
  const md = handoffToMarkdown(h, wallClock);

  const Block = ({ title, items }: { title: string; items: string[] }) => (
    <section className="ho-block"><h2>{title}</h2>{items.length ? <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">Nothing recorded.</p>}</section>
  );

  return (
    <div className="page handoff">
      <header className="page-h">
        <div>
          <h1>Shift handoff · {wallClock(t)}</h1>
          <p className="muted">Generated from the stored record. <Src s={h.source} /> A person confirms it; the system never sends it alone.</p>
        </div>
        <div className="page-h-actions">
          <Btn onClick={() => download(`handoff-${wallClock(t).replace(':', '')}.md`, md, 'text/markdown')}>Export Markdown</Btn>
          <Btn onClick={() => download(`handoff-${wallClock(t).replace(':', '')}.json`, JSON.stringify({ ...h, dataSources: ['simulated facility', 'fixture reference probe', 'operator records'] }, null, 2), 'application/json')}>Export JSON</Btn>
        </div>
      </header>
      <div className="ho-grid">
        <Block title="What is happening" items={h.happening} />
        <Block title="What is verified" items={h.verified} />
        <Block title="What is uncertain" items={h.uncertain} />
        <Block title="What we did" items={h.done} />
        <section className="ho-block">
          <h2>Who owns the next action</h2>
          {h.owners.length ? <table className="table"><tbody>{h.owners.map((o, i) => <tr key={i}><td>{o.item}</td><td>{o.owner}</td></tr>)}</tbody></table> : <p className="muted">No open items.</p>}
        </section>
        <Block title="Do not repeat without checking" items={h.doNotRepeat} />
        <section className="ho-block ho-watch">
          <h2>Watch next</h2>
          {h.watch.length ? <ul>{h.watch.map((w) => <li key={w.assetId}><span className="mono">{wallClock(w.atMin)}</span> <span className="mono">{w.assetId}</span> — {w.why}</li>)}</ul> : <p className="muted">No running clocks.</p>}
        </section>
      </div>
      <section className="ho-ack">
        <h2>Acknowledge</h2>
        {state.handoffAcks.map((a, i) => <p key={i} className="small"><span className="mono">{wallClock(a.t)}</span> acknowledged by {state.employees.find((e) => e.id === a.by)?.name}{a.note ? ` — “${a.note}”` : ''}</p>)}
        <label className="override">Note for the record (optional)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Taking INC-1044; will recheck DRAIN-1 at 03:15" /></label>
        <Btn kind="primary" onClick={() => { dispatch({ type: 'ack_handoff', by: 'emp-reza', note: note || undefined, event: makeEvent(t, { kind: 'handoff', actor: 'Reza Haddad', summary: `Handoff acknowledged by incoming lead${note ? `: ${note}` : ''}`, links: {}, source: 'operator' }) }); setNote(''); }}>
          Acknowledge as Reza Haddad (incoming lead)
        </Btn>
      </section>
    </div>
  );
}
