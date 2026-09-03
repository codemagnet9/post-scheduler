// src/screens/app/composer/AccountPicker.tsx
// Every connected account as a pill; selecting adds a target, deselecting removes it (through the API,
// via the container). Accounts needing reauthorization are shown, disabled, WITH the reason — never
// silently dropped from the list.
import type { Account, PostTarget } from '../../../api/types';
import { Avatar } from '../../../components/Avatar';

function unavailableReason(status: string): string {
  if (status === 'auth_expired') return 'Reconnect';
  if (status === 'needs_review') return 'Needs review';
  if (status === 'suspended') return 'Suspended';
  return status.replace(/_/g, ' ');
}

export function AccountPicker({ accounts, targets, busy, onToggle }: {
  accounts: Account[];
  targets: PostTarget[];
  busy: boolean;
  onToggle: (account: Account, selected: boolean) => void;
}): JSX.Element {
  const selected = new Set(targets.map((t) => t.connected_account_id));
  return (
    <div className="card">
      <div className="card-h"><h3>Publish to</h3><span className="badge b-mute sp">{selected.size} of {accounts.length} accounts</span></div>
      <div className="card-b">
        <div className="acct-pick">
          {accounts.map((a) => {
            const isSelected = selected.has(a.id);
            const unavailable = a.status !== 'active';
            return (
              <button
                key={a.id}
                type="button"
                className={`apick${isSelected ? ' on' : ''}`}
                disabled={busy || (unavailable && !isSelected)}
                onClick={() => onToggle(a, isSelected)}
                title={unavailable ? unavailableReason(a.status) : undefined}
                style={unavailable ? { opacity: 0.55 } : undefined}
              >
                <Avatar name={a.handle ?? a.provider} seed={a.id} size={22} />
                {a.handle ?? a.display_name ?? a.provider}
                {unavailable && <span className="badge b-bad" style={{ marginLeft: 6 }}><span className="d" />{unavailableReason(a.status)}</span>}
              </button>
            );
          })}
          {accounts.length === 0 && <span className="dim" style={{ fontSize: 13 }}>No accounts connected yet.</span>}
        </div>
      </div>
    </div>
  );
}
