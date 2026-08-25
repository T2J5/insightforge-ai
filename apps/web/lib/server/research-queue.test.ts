import { randomUUID } from "node:crypto";

import { RESEARCH_RUN_JOB, type ResearchRunJob } from "@insightforge/domain";
import type IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProducerRedis } from "./redis";
import {
  createResearchQueue,
  RESEARCH_RUN_DEFAULT_JOB_OPTIONS,
  type ResearchQueue,
} from "./research-queue";

const redisTestUrl = process.env.REDIS_TEST_URL ?? "redis://localhost:6379/1";

const runId = "550e8400-e29b-41d4-a716-446655440000";

describe.sequential("research queue", () => {
  let connection: IORedis;
  let queue: ResearchQueue;

  beforeAll(async () => {
    connection = createProducerRedis(redisTestUrl);
    queue = createResearchQueue(
      connection,
      `research-runs-test-${randomUUID()}`,
    );

    await queue.waitUntilReady();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();

    if (connection.status !== "end") {
      try {
        await connection.quit();
      } catch {
        connection.disconnect();
      }
    }
  });

  it("拒绝空队列名称", () => {
    expect(() => createResearchQueue(connection, "   ")).toThrowError(
      "RESEARCH_QUEUE_NAME_REQUIRED",
    );
  });

  it("定义重试、指数退避和任务清理策略", () => {
    expect(RESEARCH_RUN_DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 4,
      backoff: {
        type: "exponential",
        delay: 2_000,
        jitter: 0.2,
      },
      removeOnComplete: {
        age: 24 * 60 * 60,
        count: 1_000,
      },
      removeOnFail: {
        age: 7 * 24 * 60 * 60,
        count: 5_000,
      },
    });
  });

  it("使用runId作为Job ID并把最小任务消息持久化到Redis", async () => {
    const data: ResearchRunJob = {
      runId,
    };

    const created = await queue.add(RESEARCH_RUN_JOB, data, {
      jobId: runId,
    });

    expect(created.id).toBe(runId);

    const stored = await queue.getJob(runId);

    expect(stored).not.toBeNull();
    expect(stored?.name).toBe(RESEARCH_RUN_JOB);
    expect(stored?.data).toEqual({ runId });
    expect(stored?.opts.attempts).toBe(4);
    expect(stored?.opts.backoff).toEqual({
      type: "exponential",
      delay: 2_000,
      jitter: 0.2,
    });
    expect(stored?.opts.removeOnComplete).toEqual({
      age: 24 * 60 * 60,
      count: 1_000,
    });
    expect(stored?.opts.removeOnFail).toEqual({
      age: 7 * 24 * 60 * 60,
      count: 5_000,
    });
  });
});
