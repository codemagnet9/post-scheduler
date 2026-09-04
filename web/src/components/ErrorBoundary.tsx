// src/components/ErrorBoundary.tsx
// The real 500 page: a React error boundary that catches a render/runtime crash anywhere below it and
// shows a recoverable page instead of a white screen. "Reload" is a full navigation (clears the broken
// in-memory state); the raw error goes to the console for support, never rendered to the user.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A real deployment forwards this to its monitoring pipeline (see WHAT IS NOT DONE); for now, the
    // console is where support looks.
    // eslint-disable-next-line no-console
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ background: 'var(--bg)', borderRadius: 30, margin: 16, minHeight: 'calc(100vh - 32px)', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <div className="empty" style={{ padding: 0 }}><span className="ic" style={{ background: 'var(--bad-wash)', color: 'var(--bad)' }}>!</span></div>
          <h2 style={{ fontSize: 24, marginTop: 12 }}>Something broke on our end</h2>
          <p className="dim" style={{ margin: '10px 0 22px' }}>
            This screen hit an unexpected error. Your data is safe — reloading usually clears it. If it keeps happening, let us know what you were doing.
          </p>
          <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
            <button className="btn btn-primary" onClick={() => { window.location.href = '/'; }}>Reload the app</button>
          </div>
        </div>
      </div>
    );
  }
}
