import { useOps, type Persona } from '../state/store';
import { ControlBar } from './ControlBar';
import { Operations } from '../views/Operations';
import { TasksView } from '../views/Tasks';
import { TeamView } from '../views/Team';
import { HandoffView } from '../views/Handoff';
import { DependenciesView } from '../views/Dependencies';
import { LogView } from '../views/Log';
import { FieldView } from '../views/Field';
import { RigView } from '../views/Rig';
import { ScanIngest } from '../views/ScanIngest';
import { deviceLabel, useBridge, useFrameAge } from '../state/bridge';

const NAV = [
  { id: '', label: 'Operations' },
  { id: 'rig', label: 'Rack node' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'team', label: 'Team' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'log', label: 'Log' },
  { id: 'handoff', label: 'Handoff' },
];

export function AppShell({ route }: { route: string }) {
  const { state, dispatch, scenario, visibleIncidents } = useOps();
  const [section, param] = route.split('/');
  const bridge = useBridge();
  const age = useFrameAge(bridge.latest);
  const dev = deviceLabel(bridge.status, bridge.online);
  const openCount = visibleIncidents.filter((i) => i.status !== 'resolved').length;

  if (section === 'field') return <><ScanIngest /><FieldView taskId={param} /></>;

  return (
    <div className="shell">
      <header className="topbar" role="banner">
        <a className="brand" href="#/">Lookahead</a>
        <span className="site mono">DAL-1 · Hall A</span>
        <nav className="nav" aria-label="Workspace">
          {NAV.map((n) => (
            <a key={n.id} href={`#/app${n.id ? '/' + n.id : ''}`} className={section === n.id || (!section && !n.id) ? 'is-active' : ''} aria-current={section === n.id ? 'page' : undefined}>
              {n.label}{n.id === '' && openCount > 0 && <span className="nav-count mono">{openCount}</span>}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="tb-sim" title={scenario.basis}>SIMULATED</span>
          <a className={`tb-dev tb-dev-${dev.kind}`} href="#/app/rig" title={dev.text}><i aria-hidden="true" />{dev.kind === 'live' ? 'Rig live' : dev.kind === 'sim' ? 'Rig sim' : 'Rig offline'}{age != null && dev.kind !== 'off' && age > 3 ? <em> {Math.round(age)}s</em> : null}</a>
          <a className="tb-scan" href="#/scan" target="_blank" rel="noopener">Scanner ↗</a>
          <a className="tb-phone" href="#/m" target="_blank" rel="noopener" title="Supervisor dashboard for a phone (#/m)">Phone ↗</a>
          <a className="tb-phone" href="#/present" target="_blank" rel="noopener" title="Full-screen presenter view for a projector (#/present)">Present ↗</a>
          <label className="tb-field">
            <span className="sr-only">Demo persona</span>
            <select value={state.persona} onChange={(e) => dispatch({ type: 'persona', persona: e.target.value as Persona })} title="Demo persona — not authentication">
              <option value="supervisor">Priya R. · Supervisor</option>
              <option value="shift_lead">Reza H. · Incoming lead</option>
              <option value="technician">Marcus L. · Technician</option>
            </select>
          </label>
        </div>
      </header>
      <ControlBar />
      <ScanIngest />
      <main className="main">
        {!section && <Operations />}
        {section === 'rig' && <RigView />}
        {section === 'tasks' && <TasksView />}
        {section === 'team' && <TeamView />}
        {section === 'dependencies' && <DependenciesView />}
        {section === 'log' && <LogView />}
        {section === 'handoff' && <HandoffView />}
      </main>
    </div>
  );
}
