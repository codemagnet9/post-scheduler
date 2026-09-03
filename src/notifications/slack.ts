// src/notifications/slack.ts
// Slack via an incoming-webhook URL configured per workspace (workspaces.slack_webhook_url).
import { httpRequest } from '../providers/http';

export async function sendSlack(webhookUrl: string, text: string): Promise<void> {
  await httpRequest(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    timeoutMs: 10000,
  }).catch(() => undefined); // Slack delivery is best-effort; never block a notification on it
}
