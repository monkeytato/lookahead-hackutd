export type SimulationPhase = 'idle' | 'running' | 'complete' | 'error';

/** Request feedback is driven by the real promise, never a made-up percentage or timer. */
export function SimulationFeedback({ phase, subject, message }: { phase: SimulationPhase; subject: string; message?: string }) {
  if (phase === 'idle') return null;
  return <div className={`cg-sim-feedback cg-sim-${phase}`} role={phase === 'error' ? 'alert' : 'status'} aria-live="polite" aria-atomic="true" aria-busy={phase === 'running'}>
    <div className="cg-sim-feedback-heading">
      {phase === 'running' ? <span className="cg-request-spinner" aria-hidden="true" /> : <span className="cg-request-symbol" aria-hidden="true">{phase === 'complete' ? '✓' : '!'}</span>}
      <strong>{phase === 'running' ? 'Simulation requested' : phase === 'complete' ? 'Response evaluation ready' : 'Simulation could not complete'}</strong>
    </div>
    <p>{phase === 'running' ? `Evaluating ${subject}. Waiting for the engine and analysis service to return results.` : phase === 'complete' ? `The results for ${subject} are shown below. Review the assumptions before acting.` : message || 'Check the connection and try again.'}</p>
    {phase === 'running' && <div className="cg-request-track" role="progressbar" aria-label={`Evaluating ${subject}`}><span /></div>}
    <small>{phase === 'running' ? 'You can keep monitoring the facility. No equipment action is being executed.' : phase === 'complete' ? 'Model estimates are separate from current sensor readings.' : 'Your recorded evidence and tasks are unchanged.'}</small>
  </div>;
}
