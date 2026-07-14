import { z } from 'zod';

export interface ToolContext {
  platform: string;
  guildId: string;
  userId: string;
  /**
   * Attach a rendered image (PNG) to the outgoing reply — used by chart tools.
   * Returns false when the per-reply attachment budget is spent.
   */
  attachImage?: (filename: string, png: Buffer) => boolean;
}

/** Shape Anthropic expects for tool input schemas. */
export interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** JSON Schema, formatted exactly as Anthropic expects under `input_schema`. */
  inputSchema: JsonSchemaObject;
  /** Runtime validator — produces the typed input for `execute`. */
  validate: (raw: unknown) => I;
  execute: (input: I, ctx: ToolContext) => Promise<O>;
  /** Citation label for any successful execution — agent loop attaches it to the reply. */
  citation: (input: I, output: O) => { label: string; url?: string };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  register<I, O>(tool: Tool<I, O>): this {
    this.tools.set(tool.name, tool as Tool<unknown, unknown>);
    return this;
  }

  list(): Tool<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  /** Shape consumed by Anthropic's `tools` parameter. */
  anthropicTools() {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
}

/** Helper for tool authors: validate raw JSON against a zod schema. */
export function zValidator<I>(schema: z.ZodType<I>): (raw: unknown) => I {
  return (raw) => {
    const r = schema.safeParse(raw);
    if (!r.success) {
      throw new Error(`Invalid tool input: ${r.error.issues.map((i) => i.message).join('; ')}`);
    }
    return r.data;
  };
}
