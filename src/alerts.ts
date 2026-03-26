// -- Alert pipeline --

import type { Env, AlertConfig, CheckStatus } from './types';

// Fetch active alert configs for a monitor
async function getAlertConfigs(db: D1Database, monitorId: string): Promise<AlertConfig[]> {
  const { results } = await db
    .prepare('SELECT * FROM alert_configs WHERE monitor_id = ? AND is_active = 1')
    .bind(monitorId)
    .all<AlertConfig>();
  return results || [];
}

// Deduplication: track last alerted status in KV to avoid re-alerting
function alertedKey(monitorId: string): string {
  return `alerted:${monitorId}`;
}

export async function processStatusChange(
  env: Env,
  monitorId: string,
  monitorName: string,
  monitorUrl: string,
  oldStatus: CheckStatus | null,
  newStatus: CheckStatus,
): Promise<void> {
  // Only alert on meaningful transitions
  const isDownTransition = newStatus === 'down' && oldStatus !== 'down';
  const isRecovery = newStatus === 'up' && oldStatus === 'down';

  if (!isDownTransition && !isRecovery) return;

  // Dedup check: have we already alerted for this state?
  const lastAlerted = await env.STATUS_KV.get(alertedKey(monitorId));
  if (lastAlerted === newStatus) return;

  // Mark as alerted
  await env.STATUS_KV.put(alertedKey(monitorId), newStatus, { expirationTtl: 86400 });

  const configs = await getAlertConfigs(env.DB, monitorId);
  if (configs.length === 0) return;

  const subject = isDownTransition
    ? `[PingBase] DOWN: ${monitorName}`
    : `[PingBase] RECOVERED: ${monitorName}`;

  const body = isDownTransition
    ? `Monitor "${monitorName}" (${monitorUrl}) is DOWN.\n\nThis was confirmed after 2 consecutive failures.\n\nCheck your dashboard for details.`
    : `Monitor "${monitorName}" (${monitorUrl}) has RECOVERED and is back UP.`;

  // Fire alerts in parallel
  const promises = configs.map(config => {
    switch (config.channel) {
      case 'email':
        return sendEmailAlert(env, config.target, subject, body);
      case 'webhook':
        return sendWebhookAlert(config.target, { monitorId, monitorName, monitorUrl, status: newStatus, subject, body });
      case 'slack':
        return sendSlackAlert(config.target, subject, body);
      case 'discord':
        return sendDiscordAlert(config.target, subject, body);
      default:
        return Promise.resolve();
    }
  });

  await Promise.allSettled(promises);
}

// --- Channel implementations ---

async function sendEmailAlert(env: Env, to: string, subject: string, body: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[alert:email] No API key, skipping: ${subject} -> ${to}`);
    return;
  }

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.ALERT_EMAIL_FROM,
        to: [to],
        subject,
        text: body,
      }),
    });
  } catch (e) {
    console.error(`[alert:email] Failed to send to ${to}:`, e);
  }
}

async function sendWebhookAlert(url: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error(`[alert:webhook] Failed to post to ${url}:`, e);
  }
}

async function sendSlackAlert(webhookUrl: string, subject: string, body: string): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${subject}*\n${body}` }),
    });
  } catch (e) {
    console.error('[alert:slack] Failed:', e);
  }
}

async function sendDiscordAlert(webhookUrl: string, subject: string, body: string): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${subject}**\n${body}` }),
    });
  } catch (e) {
    console.error('[alert:discord] Failed:', e);
  }
}
