import { getConfig } from '../config.js';
import { withRetry } from '../core/util.js';

/**
 * Voyage embeddings — Anthropic's recommended partner.
 * voyage-3-lite returns 512-dim vectors; if you swap models, update
 * the `vector(512)` columns in db/migrations/0001_init.sql to match.
 */

export const EMBEDDING_DIM = 512;

interface VoyageResp {
  data: Array<{ embedding: number[] }>;
}

export async function embed(text: string): Promise<number[]> {
  const cfg = getConfig();
  if (!cfg.VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY missing — embeddings disabled');
  }
  return withRetry(async () => {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: [text],
        model: cfg.EMBEDDING_MODEL,
        input_type: 'query',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`voyage ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as VoyageResp;
    const vec = json.data[0]?.embedding;
    if (!vec || vec.length !== EMBEDDING_DIM) {
      throw new Error(
        `voyage returned ${vec?.length ?? 0}-dim vector; expected ${EMBEDDING_DIM}. Update EMBEDDING_DIM + SQL.`,
      );
    }
    return vec;
  }, 'voyage-embed');
}
