// src/screens/app/settings/Settings.tsx
// The tabbed settings screen. Tab visibility is ABILITY-GATED (workspace/posting/danger/billing are
// Owner-only; notifications and security are per-user and everyone gets them). The tab is kept in the
// URL (?tab=) so a deep link or a refresh lands on the same place. Each tab owns its own data + saves —
// nothing here is optimistic; a save reflects the server's returned state.
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Screen } from '../../../shell/Screen';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { useAuth } from '../../../auth/AuthProvider';
import { can } from '../../../authz/abilities';
import { EmptyState } from '../../../components/states';
import { WorkspaceTab } from './WorkspaceTab';
import { PostingDefaultsTab } from './PostingDefaultsTab';
import { NotificationsTab } from './NotificationsTab';
import { SecurityTab } from './SecurityTab';
import { DangerZoneTab } from './DangerZoneTab';

interface TabDef { key: string; label: string; show: boolean }

export function Settings(): JSX.Element {
  const { active } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const userId = user?.id ?? '';
  const isOwner = can(active.role, userId, 'workspace:update');
  const canBilling = can(active.role, userId, 'billing:view');

  const [params, setParams] = useSearchParams();

  const tabs: TabDef[] = [
    { key: 'workspace', label: 'Workspace', show: isOwner },
    { key: 'posting', label: 'Posting defaults', show: isOwner },
    { key: 'notifications', label: 'Notifications', show: true },
    { key: 'members', label: 'Members and roles', show: true },
    { key: 'billing', label: 'Billing', show: canBilling },
    { key: 'security', label: 'Security', show: true },
    { key: 'danger', label: 'Danger zone', show: isOwner },
  ].filter((t) => t.show);

  const requested = params.get('tab');
  const activeTab = tabs.some((t) => t.key === requested) ? (requested as string) : tabs[0].key;
  const setTab = (key: string) => setParams({ tab: key }, { replace: true });

  return (
    <Screen title="Settings">
      <div className="tabline" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === activeTab} className={t.key === activeTab ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'workspace' && <WorkspaceTab />}
      {activeTab === 'posting' && <PostingDefaultsTab />}
      {activeTab === 'notifications' && <NotificationsTab />}
      {activeTab === 'members' && (
        <div className="card"><EmptyState
          icon="⊙"
          title="Members and roles"
          description="Invite teammates, change roles and remove members on the Team screen."
          actions={<button className="btn btn-primary" onClick={() => navigate('/team')}>Go to Team</button>}
        /></div>
      )}
      {activeTab === 'billing' && (
        <div className="card">
          <div className="card-h"><h3>Billing</h3><span className="badge b-info sp">Beta</span></div>
          <div className="card-b">
            <EmptyState
              icon="◫"
              title="Coming soon — beta pricing"
              description="You’re on the free beta plan: up to 3 connected accounts and unlimited posts, no card required. Paid tiers (and invoices) land when Stripe is wired in a later release; we’ll email before anything is charged."
            />
            <p className="dim" style={{ fontSize: 12.5, textAlign: 'center', marginTop: 4 }}>Current plan: <strong>Beta (free)</strong></p>
          </div>
        </div>
      )}
      {activeTab === 'security' && <SecurityTab />}
      {activeTab === 'danger' && <DangerZoneTab />}
    </Screen>
  );
}
