import type {
  ModelInput,
  ModelResult,
  StructuredModel,
} from "@insightforge/domain";
import type { ZodType } from "zod";

export class FakeStructuredModel implements StructuredModel {
  readonly calls: ModelInput[] = [];

  constructor(private readonly responses: unknown[]) {}

  async generate<T>(
    schema: ZodType<T>,
    input: ModelInput,
  ): Promise<ModelResult<T>> {
    this.calls.push(input);

    if (this.responses.length === 0) {
      throw new Error(`No fake response queued for ${input.operation}`);
    }

    return {
      value: schema.parse(this.responses.shift()),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        costCny: 0,
      },
    };
  }
}
