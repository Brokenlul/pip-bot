import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { withRetry } from '../core/util.js';
import { hlInfo } from './hyperliquid.js';

/**
 * Read-only Hyperliquid account risk state — aggregate leverage, per-position
 * exposure, margin utilization, distance to liquidation, funding accrual.
 * PURE DESCRIPTION of current risk, never a sizing/allocation recommendation
 * — that line is deliberate (see agent.ts "Handling trade-idea questions").
 * Same public clearinghouseState endpoint hl-whales.ts uses for other
 * traders' positions; here the user supplies their OWN public address.
 * Standard perp universe only — builder-dex (HIP-3) positions live in a
 * separate clearinghouse and aren't included.
 */

const InputSchema = z.object({
  address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a Hyperliquid account address (0x + 40 hex characters).')
    .describe("The user's own public Hyperliquid wallet address."),
});
type Input = z.infer<typeof InputSchema>;

interface RawPosition {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  leverage?: { type?: string; value?: number };
  liquidationPx?: string | null;
  marginUsed?: string;
  cumFunding?: { sinceOpen?: string };
}

interface ClearinghouseState {
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  withdrawable?: string;
  assetPositions?: Array<{ position: RawPosition }>;
}

interface PositionRisk {
  coin: string;
  side: 'long' | 'short';
  size: number;
  notional_usd: number;
  entry_price: number;
  mark_price: number;
  leverage_x: number | null;
  margin_used_usd: number;
  liquidation_price: number | null;
  distance_to_liquidation_pct: number | null; // positive = price room before liquidation
  unrealized_pnl_usd: number;
  funding_since_open_usd: number; // negative = paid out, positive = received
}

interface Output {
  address: string;
  account_value_usd: number;
  withdrawable_usd: number;
  total_notional_usd: number;
  total_margin_used_usd: number;
  aggregate_leverage_x: number | null;
  margin_utilization_pct: number | null;
  position_count: number;
  positions: PositionRisk[];
  concentration_pct: Array<{ coin: string; pct_of_notional: number }>;
  closest_to_liquidation: { coin: string; distance_pct: number } | null;
  note: string;
  as_of: string;
  source_url: string;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function toPositionRisk(p: RawPosition): PositionRisk {
  const szi = Number(p.szi);
  const side: 'long' | 'short' = szi >= 0 ? 'long' : 'short';
  const size = Math.abs(szi);
  const notional = Number(p.positionValue);
  const markPx = size > 0 ? notional / size : 0;
  const liqPx = p.liquidationPx != null ? Number(p.liquidationPx) : null;
  let distancePct: number | null = null;
  if (liqPx !== null && markPx > 0) {
    distancePct = side === 'long' ? ((markPx - liqPx) / markPx) * 100 : ((liqPx - markPx) / markPx) * 100;
  }
  return {
    coin: p.coin,
    side,
    size: round(size, 6),
    notional_usd: round(notional),
    entry_price: Number(p.entryPx),
    mark_price: round(markPx, 4),
    leverage_x: p.leverage?.value ?? null,
    margin_used_usd: round(Number(p.marginUsed ?? '0')),
    liquidation_price: liqPx !== null ? round(liqPx, 4) : null,
    distance_to_liquidation_pct: distancePct !== null ? round(distancePct) : null,
    unrealized_pnl_usd: round(Number(p.unrealizedPnl)),
    funding_since_open_usd: round(Number(p.cumFunding?.sinceOpen ?? '0')),
  };
}

export const riskExposureTool: Tool<Input, Output> = {
  name: 'account_risk_exposure',
  description:
    "Read a user's OWN current Hyperliquid risk state from their public wallet address: account equity, aggregate leverage, per-position notional/leverage/margin, distance to liquidation, concentration by coin, and funding accrued since each position opened. This is PURE DESCRIPTION of current exposure — it does NOT recommend position sizing, leverage, or how to allocate capital; that decision is always the user's. Use it when someone asks about their own exposure, risk, leverage, or liquidation distance (\"how exposed am I\", \"how much room before I get liquidated\", \"what's my leverage across positions\") — ask for their Hyperliquid address if they haven't given one, never guess it. Standard perp universe only (builder-dex/HIP-3 positions aren't included).",
  inputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: "The user's Hyperliquid wallet address (0x...)." },
    },
    required: ['address'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    return withRetry(async () => {
      const state = await hlInfo<ClearinghouseState>({ type: 'clearinghouseState', user: input.address });
      const positions = (state.assetPositions ?? [])
        .map((ap) => ap.position)
        .filter((p) => Number(p.szi) !== 0)
        .map(toPositionRisk);

      const accountValue = Number(state.marginSummary?.accountValue ?? '0');
      const totalMarginUsed = Number(state.marginSummary?.totalMarginUsed ?? '0');
      const totalNotional = positions.reduce((s, p) => s + p.notional_usd, 0);

      const byCoin = new Map<string, number>();
      for (const p of positions) byCoin.set(p.coin, (byCoin.get(p.coin) ?? 0) + p.notional_usd);
      const concentration = [...byCoin.entries()]
        .map(([coin, notional]) => ({ coin, pct_of_notional: totalNotional > 0 ? round((notional / totalNotional) * 100) : 0 }))
        .sort((a, b) => b.pct_of_notional - a.pct_of_notional);

      const withLiq = positions.filter((p) => p.distance_to_liquidation_pct !== null);
      const closest = withLiq.length
        ? withLiq.reduce((a, b) => (b.distance_to_liquidation_pct! < a.distance_to_liquidation_pct! ? b : a))
        : null;

      return {
        address: input.address,
        account_value_usd: round(accountValue),
        withdrawable_usd: round(Number(state.withdrawable ?? '0')),
        total_notional_usd: round(totalNotional),
        total_margin_used_usd: round(totalMarginUsed),
        aggregate_leverage_x: accountValue > 0 ? round(totalNotional / accountValue) : null,
        margin_utilization_pct: accountValue > 0 ? round((totalMarginUsed / accountValue) * 100) : null,
        position_count: positions.length,
        positions,
        concentration_pct: concentration,
        closest_to_liquidation: closest ? { coin: closest.coin, distance_pct: closest.distance_to_liquidation_pct! } : null,
        note:
          positions.length === 0
            ? 'No open positions on the standard perp universe for this address.'
            : 'Standard Hyperliquid perps only — builder-dex (HIP-3) positions live in a separate clearinghouse and are not included.',
        as_of: new Date().toISOString(),
        source_url: `https://app.hyperliquid.xyz/portfolio`,
      };
    }, `risk-exposure:${input.address}`);
  },
  citation: () => ({ label: 'Hyperliquid account state' }),
};
