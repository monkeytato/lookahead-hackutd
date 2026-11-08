/** Small, crisp interface lockup matching the supplied navy/teal shield. */
export function Brand() {
  return <span className="cg-brand" aria-label="CenterGuard">
    <svg viewBox="0 0 56 64" aria-hidden="true" focusable="false">
      <path fill="var(--brand-navy)" d="M28 2 53 12v18c0 16-10 25-25 32C13 55 3 46 3 30V12Z" />
      <path fill="var(--brand-teal)" d="m4 35 24-6 24 6c-2 12-11 21-24 27C15 56 6 47 4 35Z" />
      <rect x="23" y="16" width="10" height="29" rx=".8" fill="var(--brand-ivory)" />
    </svg>
    <span>Center<span className="cg-brand-accent">Guard</span></span>
  </span>;
}
