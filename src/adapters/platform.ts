/**
 * Platform-agnostic types for paul-core. No discord.js types may live here
 * or be imported by anything under src/core or src/data or src/memory.
 * Adding Telegram later means a new adapter, not a rewrite of core.
 */

export interface NormalizedMessage {
  platform: 'discord' | 'telegram';
  guildId: string;     // for DMs, set to `dm:<userId>` so memory still scopes cleanly
  guildName?: string;
  userId: string;
  userName?: string;
  text: string;
  receivedAt: Date;
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

export interface PlatformAdapter {
  start(handler: (msg: NormalizedMessage) => Promise<NormalizedReply>): Promise<void>;
  stop(): Promise<void>;
}
