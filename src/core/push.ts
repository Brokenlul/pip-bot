/**
 * Cross-platform outbound push — the registry each adapter plugs its "DM this
 * user" capability into (mirrors the founder-notifier pattern in
 * beta/guardrails.ts). Lets platform-agnostic code (the alert poller) push a
 * message without importing discord.js/grammy directly.
 */
export type Pusher = (userId: string, text: string) => Promise<void>;

const pushers = new Map<string, Pusher>();

export function registerPusher(platform: string, fn: Pusher): void {
  pushers.set(platform, fn);
}

/** Best-effort push. Returns false if the platform has no pusher registered or the send failed. */
export async function pushMessage(platform: string, userId: string, text: string): Promise<boolean> {
  const fn = pushers.get(platform);
  if (!fn) return false;
  try {
    await fn(userId, text);
    return true;
  } catch (e) {
    console.warn(`[push] ${platform} send to ${userId} failed: ${(e as Error).message}`);
    return false;
  }
}
