/**
 * audioMONASTRY · Alarmzustellung (PROD-P1-004), gemeinsam genutzt
 * =================================================================
 * Die Zustellung an Discord/Slack/Telegram lag bisher nur inline in der Route
 * `POST /api/alerts/webhook` (server/routes/opsRoutes.ts). Der Auto-Stop der
 * Pods (FLEET-P1-012) braucht denselben Weg für seinen Fehlerpfad – deshalb
 * steht er jetzt hier, und beide Aufrufer nutzen ihn.
 *
 *   DISCORD_WEBHOOK, SLACK_WEBHOOK, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *
 * Ohne konfigurierte Ziele passiert nichts (0 zugestellt). Fehler beim
 * Zustellen werden geschluckt: Alarmierung darf den Server nie beeinträchtigen.
 */

export interface AlertTargets {
  discord?: string;
  slack?: string;
  telegramBot?: string;
  telegramChat?: string;
}

export function alertTargetsFromEnv(env: NodeJS.ProcessEnv = process.env): AlertTargets {
  return {
    discord: env.DISCORD_WEBHOOK?.trim() || undefined,
    slack: env.SLACK_WEBHOOK?.trim() || undefined,
    telegramBot: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramChat: env.TELEGRAM_CHAT_ID?.trim() || undefined,
  };
}

/** Namen der konfigurierten Ziele (für Antworten/Logs, ohne Geheimnisse). */
export function alertTargetNames(targets: AlertTargets): string[] {
  const names: string[] = [];
  if (targets.discord) names.push('discord');
  if (targets.slack) names.push('slack');
  if (targets.telegramBot && targets.telegramChat) names.push('telegram');
  return names;
}

/** Stellt jeden Text an jedes Ziel zu; liefert die Zahl erfolgreicher Zustellungen. */
export async function forwardAlertTexts(texts: readonly string[], targets: AlertTargets = alertTargetsFromEnv()): Promise<number> {
  let forwarded = 0;
  for (const text of texts) {
    const payloads: Array<[string, string]> = [];
    if (targets.discord) payloads.push([targets.discord, JSON.stringify({ content: text })]);
    if (targets.slack) payloads.push([targets.slack, JSON.stringify({ text })]);
    if (targets.telegramBot && targets.telegramChat) {
      payloads.push([`https://api.telegram.org/bot${targets.telegramBot}/sendMessage`, JSON.stringify({ chat_id: targets.telegramChat, text })]);
    }
    for (const [url, body] of payloads) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) forwarded += 1;
      } catch {
        // Alert-Weiterleitung darf den Server nie beeintraechtigen.
      }
    }
  }
  return forwarded;
}
