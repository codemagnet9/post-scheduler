// src/screens/app/Placeholder.tsx
// The nav is fully wired; these inner screens (composer, calendar, queue, …) are built in later
// phases. Each renders inside the real shell with the ported empty-state, so the frame is complete and
// honest about what's coming.
import { Screen } from '../../shell/Screen';
import { EmptyState } from '../../components/states';

export function Placeholder({ title, icon }: { title: string; icon?: string }): JSX.Element {
  return (
    <Screen title={title}>
      <div className="card">
        <EmptyState
          icon={icon ?? '◇'}
          title={`${title} is coming next`}
          description="The app shell, auth, and design system are in place. This screen is built in a later frontend phase."
        />
      </div>
    </Screen>
  );
}
