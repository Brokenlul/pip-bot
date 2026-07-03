/**
 * Platform-agnostic types for pip-core. No discord.js types may live here
 * or be imported by anything under src/core or src/data or src/memory.
 * Adding Telegram later means a new adapter, not a rewrite of core.
 */

/** An image the user attached — chart screenshots are the primary case. */
export interface NormalizedImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  dataBase64: string;
}

export interface NormalizedMessage {
  platform: 'discord' | 'telegram';
  guildId: string;     // for DMs, set to `dm:<userId>` so memory still scopes cleanly
  guildName?: string;
  channelId?: string;  // for the beta channel-allowlist (Discord channel / TG chat)
  userId: string;
  userName?: string;
  text: string;
  images?: NormalizedImage[];  // attached images (charts) for vision analysis
  receivedAt: Date;
}

/** Per-request feature budget from the beta gate. All true when beta is off. */
export interface AnswerOptions {
  allowWeb?: boolean;
  allowVision?: boolean;
  allowScan?: boolean;
  degraded?: boolean;
}

export interface SourceCitation {
  label: string;
  url?: string;
}

export interface NormalizedReply {
  title?: string;
  body: string;
  sources: SourceCitation[];
  asOf: Date;
  disclaimer?: string;
}

export type MessageHandler = (
  msg: NormalizedMessage,
  opts?: AnswerOptions,
) => Promise<NormalizedReply>;

export interface PlatformAdapter {
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
}
