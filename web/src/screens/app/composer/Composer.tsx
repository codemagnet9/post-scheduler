// src/screens/app/composer/Composer.tsx
// The composer container. It owns the draft (whose id lives in the URL so a refresh never loses it),
// autosaves edits, and drives a DEBOUNCED validation call whose result feeds the findings panel and
// previews. It never counts characters, evaluates a rule, or merges content — it sends edits and
// renders what the API returns.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../../shell/Screen';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { ApiError } from '../../../api/client';
import {
  addTarget, createDraft, createUpload, finalizeUpload, getPost, listAccounts, removeTarget,
  schedulePost, setOverride, setSchedule, submitForApproval, updatePost, validatePost,
} from '../../../api/endpoints';
import type { Account, PostSchedule } from '../../../api/types';
import { EmptyState, ErrorState, SkeletonRows } from '../../../components/states';
import { AccountPicker } from './AccountPicker';
import { OverrideTabs, type Tab } from './OverrideTabs';
import { MediaTray, type Upload } from './MediaTray';
import { ScheduleRow } from './ScheduleRow';
import { ScheduleActions } from './ScheduleActions';
import { PreviewList } from './PreviewList';
import { BeforeYouSchedule } from './BeforeYouSchedule';
import { buildSchedulePayload, canCompose, canDirectSchedule, overrideForNetworkTab, tightestCount, type ScheduleMode, type TimeBasis } from './logic';

interface SchedState { mode: ScheduleMode; date: string; time: string; basis: TimeBasis }

function scheduleFromPost(s: PostSchedule, fallbackDate: string): SchedState {
  if (s.type === 'audience_local') return { mode: 'time', basis: 'audience', date: s.localDate ?? fallbackDate, time: s.localTime ?? '09:30' };
  if (s.type === 'queued') return { mode: 'queue', basis: 'audience', date: fallbackDate, time: '09:30' };
  if (s.type === 'fixed_instant' && s.scheduledAt) {
    const d = new Date(s.scheduledAt);
    return { mode: 'time', basis: 'utc', date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
  }
  return { mode: 'time', basis: 'audience', date: fallbackDate, time: '09:30' };
}

export function Composer(): JSX.Element {
  const { active, timezone } = useWorkspace();
  const ws = active.id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const postId = params.get('post');
  const fileInput = useRef<HTMLInputElement>(null);

  // --- draft: create once if the URL has no ?post, so a refresh reloads the SAME draft ---
  const creating = useRef(false);
  useEffect(() => {
    if (postId || creating.current || !canCompose(active.role)) return;
    creating.current = true;
    createDraft(ws, { targetAccountIds: [] })
      .then((r) => setParams({ post: r.postId }, { replace: true }))
      .catch(() => { creating.current = false; });
  }, [postId, ws, setParams, active.role]);

  const postQ = useQuery({ queryKey: ['post', ws, postId], queryFn: () => getPost(ws, postId as string), enabled: !!postId });
  const accountsQ = useQuery({ queryKey: ['accounts', ws], queryFn: () => listAccounts(ws) });
  const validateQ = useQuery({
    queryKey: ['validate', ws, postId],
    queryFn: () => validatePost(ws, postId as string),
    enabled: !!postId,
    placeholderData: keepPreviousData, // keep the previous findings on screen while the next is in flight
  });
  const post = postQ.data;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['post', ws, postId] });
    qc.invalidateQueries({ queryKey: ['validate', ws, postId] });
  };

  // --- editor: local drafts overlay the server's effective text; save is debounced ---
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<number>();

  const effectiveText = (tab: Tab): string => {
    if (!post) return '';
    if (tab === 'all') return post.content.text ?? '';
    return post.targets.find((t) => t.target_id === tab)?.text_override ?? post.content.text ?? '';
  };
  const editorValue = drafts[activeTab] ?? effectiveText(activeTab);

  const saveText = async (tab: Tab, value: string) => {
    if (!postId) return;
    setSaving(true);
    try {
      if (tab === 'all') await updatePost(ws, postId, { text: value });
      else await setOverride(ws, postId, tab, overrideForNetworkTab(value));
      invalidate();
    } finally { setSaving(false); }
  };
  const onEditorChange = (value: string) => {
    const tab = activeTab;
    setDrafts((d) => ({ ...d, [tab]: value }));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveText(tab, value); }, 400);
  };
  const onRevert = async () => {
    if (!postId || activeTab === 'all') return;
    const tab = activeTab;
    await setOverride(ws, postId, tab, { text: null });
    setDrafts((d) => { const n = { ...d }; delete n[tab]; return n; });
    invalidate();
  };

  // --- accounts: select/deselect => add/remove target through the API ---
  const toggleMut = useMutation({
    mutationFn: async ({ account, selected }: { account: Account; selected: boolean }) => {
      if (!postId) return;
      if (selected) {
        const t = post?.targets.find((x) => x.connected_account_id === account.id);
        if (t) await removeTarget(ws, postId, t.target_id);
      } else {
        await addTarget(ws, postId, account.id);
      }
    },
    onSuccess: (_r, { selected }) => { if (selected && activeTab !== 'all') setActiveTab('all'); invalidate(); },
  });

  // --- schedule row ---
  const today = useMemo(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), []);
  const [sched, setSched] = useState<SchedState>({ mode: 'time', basis: 'audience', date: today, time: '09:30' });
  const schedInit = useRef(false);
  const schedTimer = useRef<number>();
  useEffect(() => {
    if (post && !schedInit.current) { schedInit.current = true; setSched(scheduleFromPost(post.schedule, today)); }
  }, [post, today]);

  const pushSchedule = async (s: SchedState) => {
    if (!postId) return;
    await setSchedule(ws, postId, buildSchedulePayload(s.mode, { date: s.date, time: s.time, basis: s.basis, workspaceTimezone: timezone, now: new Date() }));
    invalidate();
  };
  const onSchedChange = (patch: Partial<SchedState>) => {
    const next = { ...sched, ...patch };
    setSched(next);
    window.clearTimeout(schedTimer.current);
    schedTimer.current = window.setTimeout(() => { void pushSchedule(next); }, 350);
  };

  // --- media upload flow ---
  const [uploads, setUploads] = useState<Upload[]>([]);
  const onFiles = async (files: File[]) => {
    for (const file of files) {
      const tempId = crypto.randomUUID();
      setUploads((u) => [...u, { tempId, filename: file.name, status: 'uploading' }]);
      const set = (patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.tempId === tempId ? { ...x, ...patch } : x)));
      try {
        const contentType = file.type || 'application/octet-stream';
        const up = await createUpload(ws, { filename: file.name, declaredType: contentType, byteSize: file.size });
        // The presign signed this exact content-type; the PUT must send it to match the signature.
        const putRes = await fetch(up.uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: file });
        if (!putRes.ok) throw new Error(`storage returned ${putRes.status}`);
        const fin = await finalizeUpload(ws, up.assetId);
        if (fin.status === 'ready') {
          if (postId && post) await updatePost(ws, postId, { media: [...post.content.media, up.assetId] });
          set({ status: 'ready', assetId: up.assetId });
          invalidate();
        } else {
          set({ status: 'failed', reason: fin.reason ?? fin.status });
        }
      } catch (e) {
        set({ status: 'failed', reason: e instanceof ApiError ? e.message : (e as Error).message });
      }
    }
  };

  // --- actions (never optimistic) ---
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const commit = async (fn: () => Promise<unknown>, to: string) => {
    setActionBusy(true); setActionError(null);
    try { await pushSchedule(sched); await fn(); navigate(to); }
    catch (e) { setActionError(e instanceof ApiError ? e.displayMessage : 'Something went wrong.'); }
    finally { setActionBusy(false); }
  };

  // --- gating / loading / error ---
  if (!canCompose(active.role)) {
    return <Screen title="Compose"><div className="card"><EmptyState title="Read-only access" description="Your role can view analytics but not compose posts." /></div></Screen>;
  }
  if (!postId || postQ.isLoading) {
    return <Screen title="Compose"><div className="card"><div className="card-b"><SkeletonRows rows={4} /></div></div></Screen>;
  }
  if (postQ.error || !post) {
    return <Screen title="Compose"><div className="card"><ErrorState error={postQ.error instanceof ApiError ? postQ.error : null} onRetry={() => postQ.refetch()} /></div></Screen>;
  }

  const v = validateQ.data;
  const counts = v?.counts ?? [];
  const activeCount = activeTab === 'all' ? tightestCount(counts) : counts.find((c) => c.targetId === activeTab) ?? null;
  const activeTarget = activeTab !== 'all' ? post.targets.find((t) => t.target_id === activeTab) : undefined;
  const showRevert = activeTab !== 'all' && (activeTarget?.text_override != null || drafts[activeTab] !== undefined);
  const canSchedule = v?.canSchedule ?? false;

  return (
    <Screen title="Compose" actions={<span className="dim" style={{ fontSize: 12 }}>{saving ? 'Saving…' : 'Draft saved'}</span>}>
      <div className="compose">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <AccountPicker accounts={accountsQ.data ?? []} targets={post.targets} busy={toggleMut.isPending} onToggle={(account, selected) => toggleMut.mutate({ account, selected })} />
          <OverrideTabs
            targets={post.targets} active={activeTab} onActive={setActiveTab}
            value={editorValue} onChange={onEditorChange} count={activeCount}
            showRevert={showRevert} onRevert={onRevert} onPickMedia={() => fileInput.current?.click()}
          />
          <MediaTray mediaIds={post.content.media} uploads={uploads} inputRef={fileInput} onFiles={onFiles} />
          <ScheduleRow mode={sched.mode} date={sched.date} time={sched.time} basis={sched.basis} onChange={onSchedChange} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'sticky', top: 76 }}>
          <div className="card">
            <div className="card-h"><h3>Preview</h3><span className="dim sp" style={{ fontSize: 12 }}>{validateQ.isFetching ? 'Updating…' : 'Live'}</span></div>
            <div className="card-b">
              {validateQ.isLoading ? <SkeletonRows rows={2} /> : <PreviewList previews={v?.previews ?? []} threadPreviews={v?.threadPreviews ?? []} />}
            </div>
          </div>
          <BeforeYouSchedule findings={v?.findings ?? []} stale={validateQ.isFetching} />
          <ScheduleActions
            role={active.role} canSchedule={canSchedule} busy={actionBusy} error={actionError}
            onSchedule={() => commit(() => schedulePost(ws, postId), '/queue')}
            onSubmit={() => commit(() => submitForApproval(ws, postId), canDirectSchedule(active.role) ? '/queue' : '/approvals')}
          />
        </div>
      </div>
    </Screen>
  );
}
