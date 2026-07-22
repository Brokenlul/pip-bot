import { z } from 'zod';
import { Tool, ToolContext, zValidator } from './registry.js';
import { getDb } from '../memory/db.js';
import { fundingRateTool } from './hyperliquid.js';

/**
 * Push price alerts — "tell me when BTC retests $62,490". Pip can't watch a
 * chart between messages, so this is the honest answer to that ask: persist
 * the level, let src/core/alert-poller.ts watch it on an interval, and DM the
 * user the moment it crosses. Requires memory (Supabase) — gated the same way
 * as recentQuestionsTool in agent.ts.
 */

async function currentMarkPrice(symbol: string, ctx: ToolContext): Promise<{ coin: string; price: number }> {
  const out = await fundingRateTool.execute({ coin: symbol }, ctx);
  return { coin: out.coin, price: out.mark_price };
}

// ---- set_price_alert --------------------------------------------------------

const SetSchema = z.object({
  symbol: z.string().min(1).describe('Hyperliquid ticker to watch, e.g. "BTC", "ETH", "SOL".'),
  target_price: z.number().positive().describe('The price level to watch for.'),
  direction: z
    .enum(['above', 'below'])
    .optional()
    .describe(
      'Which way price should cross the level to fire. Omit to auto-infer from the current price — a level below spot means "wait for it to drop to/below" (a retest), a level above spot means "wait for it to rise to/above" (a breakout).',
    ),
  note: z.string().max(200).optional().describe("Short reminder of the setup, e.g. \"BTC long retest of VWAP mid\"."),
});
type SetInput = z.infer<typeof SetSchema>;
interface SetOutput {
  id: number;
  symbol: string;
  direction: 'above' | 'below';
  target_price: number;
  current_price: number;
}

export const setPriceAlertTool: Tool<SetInput, SetOutput> = {
  name: 'set_price_alert',
  description:
    'Set a one-time push price alert — Pip will DM the user the moment the price crosses a level, even without them asking again. Use whenever a user asks to be notified/pinged/messaged about a price level, a retest, or a breakout ("let me know when it retests X", "tell me if it breaks above Y", "ping me at Z"). This is a REAL outbound push, not a reminder to check back manually.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Hyperliquid ticker, e.g. "BTC".' },
      target_price: { type: 'number', description: 'Price level to watch.' },
      direction: { type: 'string', enum: ['above', 'below'], description: 'Optional — auto-inferred from current price if omitted.' },
      note: { type: 'string', description: 'Optional short context for the push message.' },
    },
    required: ['symbol', 'target_price'],
  },
  validate: zValidator(SetSchema),
  execute: async (input, ctx) => {
    const db = getDb();
    if (!db) throw new Error('Price alerts need memory (Supabase) to be configured.');
    const { coin, price } = await currentMarkPrice(input.symbol, ctx);
    const direction = input.direction ?? (price > input.target_price ? 'below' : 'above');
    const { data, error } = await db
      .from('price_alerts')
      .insert({
        platform: ctx.platform,
        guild_id: ctx.guildId,
        channel_id: ctx.channelId ?? null,
        user_id: ctx.userId,
        symbol: coin,
        direction,
        target_price: input.target_price,
        note: input.note ?? null,
        last_price: price,
      })
      .select('id')
      .single();
    if (error) throw new Error(`set_price_alert insert: ${error.message}`);
    return { id: (data as { id: number }).id, symbol: coin, direction, target_price: input.target_price, current_price: price };
  },
  citation: () => ({ label: 'Pip price alert' }),
};

// ---- list_price_alerts ------------------------------------------------------

const ListSchema = z.object({});
type ListInput = z.infer<typeof ListSchema>;
interface ListOutput {
  alerts: Array<{
    id: number;
    kind: string;
    symbol: string;
    direction: string | null;
    target_price: number | null;
    notify_at: string | null;
    earnings_date: string | null;
    note: string | null;
    created_at: string;
  }>;
}

export const listPriceAlertsTool: Tool<ListInput, ListOutput> = {
  name: 'list_price_alerts',
  description:
    'List this user\'s active (not-yet-triggered) alerts — BOTH price-level alerts and upcoming earnings alerts. Use for "what alerts do I have", "what am I watching for". Each row carries `kind`: "price" (fires when target_price is crossed) or "earnings" (fires at notify_at, ahead of earnings_date).',
  inputSchema: { type: 'object', properties: {}, required: [] },
  validate: zValidator(ListSchema),
  execute: async (_input, ctx) => {
    const db = getDb();
    if (!db) throw new Error('Price alerts need memory (Supabase) to be configured.');
    const { data, error } = await db
      .from('price_alerts')
      .select('id, kind, symbol, direction, target_price, notify_at, earnings_date, note, created_at')
      .eq('platform', ctx.platform)
      .eq('user_id', ctx.userId)
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`list_price_alerts: ${error.message}`);
    return { alerts: (data ?? []) as ListOutput['alerts'] };
  },
  citation: () => ({ label: 'Pip price alert' }),
};

// ---- cancel_price_alert -----------------------------------------------------

const CancelSchema = z.object({
  id: z.number().int().describe('The alert id to cancel, from list_price_alerts.'),
});
type CancelInput = z.infer<typeof CancelSchema>;
interface CancelOutput {
  cancelled: boolean;
}

export const cancelPriceAlertTool: Tool<CancelInput, CancelOutput> = {
  name: 'cancel_price_alert',
  description:
    'Cancel one of this user\'s active alerts by id — works for both price and earnings alerts (get the id from list_price_alerts first). Use for "cancel that alert", "never mind, stop watching for X".',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'number', description: 'Alert id from list_price_alerts.' } },
    required: ['id'],
  },
  validate: zValidator(CancelSchema),
  execute: async (input, ctx) => {
    const db = getDb();
    if (!db) throw new Error('Price alerts need memory (Supabase) to be configured.');
    const { data, error } = await db
      .from('price_alerts')
      .update({ active: false })
      .eq('id', input.id)
      .eq('platform', ctx.platform)
      .eq('user_id', ctx.userId) // ownership check — can only cancel your own
      .eq('active', true)
      .select('id');
    if (error) throw new Error(`cancel_price_alert: ${error.message}`);
    return { cancelled: (data?.length ?? 0) > 0 };
  },
  citation: () => ({ label: 'Pip price alert' }),
};
