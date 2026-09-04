// src/screens/NotFound.tsx
// A real 404 — not a silent redirect. Renders inside the shell (for signed-in users) so the rail is
// right there to get them back to something real.
import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { Screen } from '../shell/Screen';
import { EmptyState } from '../components/states';

export function NotFound(): JSX.Element {
  useEffect(() => { document.title = 'Not found · Meridian'; }, []);
  return (
    <Screen title="Not found">
      <div className="card">
        <EmptyState
          icon="⚲"
          title="We couldn’t find that page"
          description="The link may be old, or the thing it pointed to has moved. Nothing’s broken — let’s get you back."
          actions={<><Link className="btn btn-primary btn-sm" to="/">Go to Home</Link><Link className="btn btn-ghost btn-sm" to="/queue">Open the queue</Link></>}
        />
      </div>
    </Screen>
  );
}
