import { Brand } from '../components/Brand';
import { TopBar } from './TopBar';
import { MonitorWorkspace } from '../views/MonitorWorkspace';
import { Operations } from '../views/Operations';
import { Monitor } from '../views/Monitor';
import { Facility } from '../views/Facility';
import { Simulation } from '../views/Simulation';
import { TasksView } from '../views/Tasks';
import { DependenciesView } from '../views/Dependencies';
import { LogView } from '../views/Log';
import { FieldView } from '../views/Field';
import { RigView } from '../views/Rig';
import { ScanIngest } from '../views/ScanIngest';

const NAV = [
  { id: '', label: 'Operations' },
  { id: 'gauges', label: 'Gauges' },
  { id: 'facility', label: 'Facility' },
  { id: 'tasks', label: 'Team response' },
  { id: 'log', label: 'History' },
  { id: 'handoff', label: 'Handoff' },
];

/** Pages driven by the simulation stage: they get the play / spawn-disaster bar under the header. */
const STAGE_PAGES = new Set(['gauges', 'facility']);

export function AppShell({ route }: { route: string }) {
  const [section, param] = route.split('/');

  if (section === 'field') return <><ScanIngest /><FieldView taskId={param} /></>;

  return (
    <div className="shell">
      <header className="topbar cg-header" role="banner">
        <a href="#/" className="cg-home"><Brand /></a>
        <nav className="nav" aria-label="Workspace">
          {NAV.map((n) => (
            <a key={n.id} href={`#/app${n.id ? '/' + n.id : ''}`} className={section === n.id || (!section && !n.id) ? 'is-active' : ''} aria-current={section === n.id ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          <a className="tb-scan" href="#/scan" target="_blank" rel="noopener">Scanner ↗</a>
          <a className="tb-present" href="#/app/inventory">Sensor inventory</a>

        </div>
      </header>
      {STAGE_PAGES.has(section) && <TopBar section={section} embedded />}
      <ScanIngest />
      <main className="main">
        {!section && <MonitorWorkspace />}
        {section === 'inventory' && <Operations />}
        {section === 'gauges' && <Monitor />}
        {section === 'facility' && <Facility />}
        {(section === 'sim' || section === 'lab') && <Simulation />}
        {section === 'rig' && <RigView />}
        {section === 'tasks' && <MonitorWorkspace view="tasks" />}
        {section === 'legacy-tasks' && <TasksView />}
        {section === 'dependencies' && <DependenciesView />}
        {section === 'log' && <MonitorWorkspace view="log" />}
        {section === 'handoff' && <MonitorWorkspace view="handoff" />}
        {section === 'legacy-log' && <LogView />}
      </main>
    </div>
  );
}
