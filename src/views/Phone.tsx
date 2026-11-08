/**
 * Phone — its own tab. Waits for a phone to connect to the shared stage. No phone app is bundled
 * here; the native client is a separate SwiftUI application and is not built yet.
 */
import { useEffect, useState } from 'react';

export function PhoneView() {
  const [screens, setScreens] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const res = await fetch('/api/stage', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json() as { screens?: number };
        if (alive) setScreens(typeof body.screens === 'number' ? body.screens : 0);
      } catch {
        if (alive) setScreens(null);
      }
    };
    void read();
    const id = window.setInterval(() => { void read(); }, 3000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  return (
    <section className="phone" aria-label="Phone connection">
      <div className="phone-card">
        <span className="word word-watch">Waiting</span>
        <h1>Waiting for a phone</h1>
        <p>Open the phone app on the same network and it will appear here. This page reports the real stage link and never pretends a phone is attached.</p>
        <p className="resp-note">
          {screens == null
            ? 'No stage link on this page yet.'
            : `${screens} stage screen${screens === 1 ? '' : 's'} connected. The stage does not yet report which one is a phone.`}
        </p>
        <a className="link" href="#/stage" target="_blank" rel="noopener">Open the web remote instead ↗</a>
      </div>

      <div className="phone-card">
        <h2>Phone app</h2>
        <p>A full native iPhone application written in SwiftUI — incident queue, readings and response control for the projector — is not built yet.</p>
        <p className="resp-note">This tab is the connection point for that app.</p>
      </div>
    </section>
  );
}
