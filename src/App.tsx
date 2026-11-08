import { lazy, Suspense, useEffect, useState } from 'react';
import { Landing } from './landing/Landing';
import { OpsProvider } from './state/store';
import { BridgeProvider } from './state/bridge';
import { AppShell } from './app/AppShell';

const TwinDemo = lazy(() => import('./twin/TwinDemo').then((m) => ({ default: m.TwinDemo })));
const ScanApp = lazy(() => import('./scan/ScanApp').then((m) => ({ default: m.ScanApp })));
const MobileApp = lazy(() => import('./mobile/MobileApp').then((m) => ({ default: m.MobileApp })));

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
      <BridgeProvider>
        <OpsProvider>
          <AppShell route={hash.slice('#/app'.length).split('?')[0].replace(/^\//, '')} />
        </OpsProvider>
      </BridgeProvider>
    );
  }
  if (hash === '#/m' || hash.startsWith('#/m/') || hash.startsWith('#/m?')) {
    return (
      <BridgeProvider>
        <OpsProvider>
          <Suspense fallback={null}><MobileApp route={hash.slice('#/m'.length).split('?')[0].replace(/^\//, '')} /></Suspense>
        </OpsProvider>
      </BridgeProvider>
    );
  }
  if (hash.startsWith('#/scan')) {
    return <BridgeProvider><Suspense fallback={null}><ScanApp /></Suspense></BridgeProvider>;
  }
  if (hash.startsWith('#/twin-lab')) {
    return <Suspense fallback={null}><TwinDemo /></Suspense>;
  }
  return <Landing />;
}
