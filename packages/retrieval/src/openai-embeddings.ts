import { z } from "zod";

import type { EmbeddingPort } from "@insightforge/domain";

const EmbeddingResponseSchema = z.object({
  data: z.array(
    z.object({ index: z.int().nonnegative(), embedding: z.array(z.number()) }),
  ),
});

export interface OpenAiEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class OpenAiEmbeddingModel implements EmbeddingPort {
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: OpenAiEmbeddingOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("EMBEDDING_API_KEY_REQUIRED");
    this.model = options.model?.trim() || "text-embedding-3-small";
    this.baseUrl = (
      options.baseUrl?.trim() || "https://api.openai.com/v1"
    ).replace(/\/$/u, "");
    this.dimensions = options.dimensions ?? 1_536;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}/embeddings`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            input: inputs,
            dimensions: this.dimensions,
          }),
        },
      );
      if (!response.ok) throw new Error("EMBEDDING_PROVIDER_ERROR");
      const parsed = EmbeddingResponseSchema.parse(await response.json());
      const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
      if (
        ordered.length !== inputs.length ||
        ordered.some((item) => item.embedding.length !== this.dimensions)
      ) {
        throw new Error("EMBEDDING_DIMENSION_MISMATCH");
      }
      return ordered.map((item) => item.embedding);
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error("EMBEDDING_TIMEOUT", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
