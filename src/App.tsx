import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Landing } from './landing/Landing';
import { OpsProvider } from './state/store';
import { BridgeProvider } from './state/bridge';
import { StageProvider } from './stage/StageProvider';
import { AppShell } from './app/AppShell';

const TwinDemo = lazy(() => import('./twin/TwinDemo').then((m) => ({ default: m.TwinDemo })));
const MobileApp = lazy(() => import('./mobile/MobileApp').then((m) => ({ default: m.MobileApp })));
const StageRemote = lazy(() => import('./stage/StageRemote').then((m) => ({ default: m.StageRemote })));
const Present = lazy(() => import('./present/Present').then((m) => ({ default: m.Present })));

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

/** Every screen that shows or drives the presentation follows the shared stage (src/stage). */
function Live({ children, role = 'screen' }: { children: ReactNode; role?: 'remote' | 'screen' }) {
  return (
    <BridgeProvider>
      <StageProvider role={role}>
        <OpsProvider>
          <Suspense fallback={null}>{children}</Suspense>
        </OpsProvider>
      </StageProvider>
    </BridgeProvider>
  );
}

const routeOf = (hash: string, prefix: string) => hash.slice(prefix.length).split('?')[0].replace(/^\//, '');
const isRoute = (hash: string, prefix: string) => hash === prefix || hash.startsWith(`${prefix}/`) || hash.startsWith(`${prefix}?`);

/** claude.ai artifact links carry only a plain `#name`, so each shareable screen has one. */
const PLAIN: Record<string, string> = { '#stage': '#/stage', '#remote': '#/stage', '#present': '#/present', '#phone': '#/m', '#app': '#/app' };

export default function App() {
  const raw = useHash();
  const hash = PLAIN[raw] ?? raw;
  if (hash.startsWith('#/app')) return <Live><AppShell route={routeOf(hash, '#/app')} /></Live>;
  if (isRoute(hash, '#/m')) return <Live><MobileApp route={routeOf(hash, '#/m')} /></Live>;
  if (isRoute(hash, '#/stage')) return <Live role="remote"><StageRemote /></Live>;
  if (isRoute(hash, '#/present')) return <Live><Present /></Live>;
  if (hash.startsWith('#/twin-lab')) {
    return <Suspense fallback={null}><TwinDemo /></Suspense>;
  }
  return <Landing />;
}
