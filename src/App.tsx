import { lazy, Suspense, useEffect, useState } from 'react';
import { Landing } from './landing/Landing';
import { OpsProvider } from './state/store';
import { AppShell } from './app/AppShell';

const TwinDemo = lazy(() => import('./twin/TwinDemo').then((m) => ({ default: m.TwinDemo })));

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();
  if (hash.startsWith('#/app')) {
    return (
      <OpsProvider>
        <AppShell route={hash.slice('#/app'.length).replace(/^\//, '')} />
      </OpsProvider>
    );
  }
  if (hash.startsWith('#/twin-lab')) {
    return <Suspense fallback={null}><TwinDemo /></Suspense>;
  }
  return <Landing />;
}
