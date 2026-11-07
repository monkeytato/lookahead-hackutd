import { scenarios } from '../domain/fixture';
import { useOps, wallClock, type Persona } from '../state/store';
import { Operations } from '../views/Operations';
import { TasksView } from '../views/Tasks';
import { TeamView } from '../views/Team';
import { HandoffView } from '../views/Handoff';
import { DependenciesView } from '../views/Dependencies';
import { LogView } from '../views/Log';
import { FieldView } from '../views/Field';

const NAV = [
  { id: '', label: 'Operations' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'team', label: 'Team' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'log', label: 'Log' },
  { id: 'handoff', label: 'Handoff' },
];

export function AppShell({ route }: { route: string }) {
  const { state, dispatch, scenario, visibleIncidents } = useOps();
  const [section, param] = route.split('/');
  const openCount = visibleIncidents.filter((i) => i.status !== 'resolved').length;

  if (section === 'field') return <FieldView taskId={param} />;

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
          <label className="tb-field">
            <span className="sr-only">Scenario</span>
            <select value={state.scenarioId} onChange={(e) => dispatch({ type: 'reset', scenarioId: e.target.value })}>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <span className="tb-clock mono" title="Scenario clock (simulated)">
            {wallClock(state.t)}<small> T+{Math.floor(state.t)}</small>
          </span>
          <span className="tb-sim" title={scenario.basis}>SIMULATED</span>
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
      <main className="main">
        {!section && <Operations />}
        {section === 'tasks' && <TasksView />}
        {section === 'team' && <TeamView />}
        {section === 'dependencies' && <DependenciesView />}
        {section === 'log' && <LogView />}
        {section === 'handoff' && <HandoffView />}
      </main>
    </div>
  );
}
