import {
  getRunEventRedisKeys,
  RUN_EVENT_LOG_LIMIT,
  RUN_EVENT_TTL_SECONDS,
  RunProgressEventSchema,
  type RunProgressEvent,
} from "@insightforge/domain";
import type IORedis from "ioredis";
import type { z } from "zod";

const PublishProgressInputSchema = RunProgressEventSchema.omit({
  occurredAt: true,
  id: true,
});
export type PublishProgressInput = z.input<typeof PublishProgressInputSchema>;
type ProgressRedis = Pick<IORedis, "incr" | "multi">;

export class ProgressPublisher {
  constructor(
    private readonly redis: ProgressRedis,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(input: PublishProgressInput): Promise<RunProgressEvent> {
    const validatedInput = PublishProgressInputSchema.parse(input);
    const keys = getRunEventRedisKeys(validatedInput.runId);

    // Generate a unique ID for the event by incrementing the Redis sequence key.
    const id = await this.redis.incr(keys.sequence);

    const event = RunProgressEventSchema.parse({
      ...validatedInput,
      id,
      occurredAt: this.now().toISOString(),
    });

    const serializedEvent = JSON.stringify(event);
    /**
     * MULTI/EXEC 将下面的 Redis 命令作为一个事务执行。
     *
     * 发布消息以前，事件已经被写入回放日志。
     */
    const transaction = this.redis
      .multi()
      .rpush(keys.log, serializedEvent)
      .ltrim(keys.log, -RUN_EVENT_LOG_LIMIT, -1)
      .expire(keys.log, RUN_EVENT_TTL_SECONDS)
      .expire(keys.sequence, RUN_EVENT_TTL_SECONDS)
      .publish(keys.channel, serializedEvent);

    const results = await transaction.exec();

    if (results === null) {
      throw new Error("RUN_PROGRESS_TRANSACTION_ABORTED");
    }

    const failedCommand = results.find(([err]) => err !== null);
    if (failedCommand?.[0]) {
      throw failedCommand[0];
    }
    return event;
  }
}
