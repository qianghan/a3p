/** Build the JSON payload the service worker renders as a notification. */
export function buildPushPayload(alert: { title: string; body: string; url?: string }): string {
  return JSON.stringify({
    title: alert.title,
    body: alert.body,
    url: alert.url && alert.url.startsWith('/') ? alert.url : '/app',
  });
}
