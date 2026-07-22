/**
 * Cross-platform outbound push — the registry each adapter plugs its "DM this
 * user" capability into (mirrors the founder-notifier pattern in
 * beta/guardrails.ts). Lets platform-agnostic code (the alert poller) push a
 * message without importing discord.js/grammy directly.
 */
export type Pusher = (userId: string, text: string) => Promise<void>;
export type ChannelPusher = (channelId: string, userId: string, text: string) => Promise<void>;

const pushers = new Map<string, Pusher>();
const channelPushers = new Map<string, ChannelPusher>();

export function registerPusher(platform: string, fn: Pusher): void {
  pushers.set(platform, fn);
}

/**
 * Fallback path for when the DM can't reach the user (DMs closed, blocked the
 * bot). The adapter is responsible for the platform's own mention syntax —
 * callers here pass plain text and never assemble `<@id>` themselves, since
 * that's Discord-specific and would be wrong on another platform.
 */
export function registerChannelPusher(platform: string, fn: ChannelPusher): void {
  channelPushers.set(platform, fn);
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

/** Best-effort channel fallback. Returns false if no fallback is registered, no channel was recorded, or the send failed. */
export async function pushToChannel(platform: string, channelId: string, userId: string, text: string): Promise<boolean> {
  const fn = channelPushers.get(platform);
  if (!fn) return false;
  try {
    await fn(channelId, userId, text);
    return true;
  } catch (e) {
    console.warn(`[push] ${platform} channel fallback to ${channelId} for ${userId} failed: ${(e as Error).message}`);
    return false;
  }
}
