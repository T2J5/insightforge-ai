import { randomUUID } from "node:crypto";

import { RESEARCH_RUN_JOB, type ResearchRunJob } from "@insightforge/domain";
import { Queue, QueueEvents } from "bullmq";
import type IORedis from "ioredis";
import { describe, expect, it, vi } from "vitest";

import {
  createResearchWorker,
  DEFAULT_RESEARCH_WORKER_CONCURRENCY,
  type ResearchJobProcessor,
  type ResearchWorker,
} from "./research-worker";
import { createWorkerRedis } from "./redis";

const redisTestUrl = process.env.REDIS_TEST_URL ?? "redis://localhost:6379/1";
const runId = "550e8400-e29b-41d4-a716-446655440000";

type Harness = {
  queue: Queue;
  events: QueueEvents;
  worker: ResearchWorker;
  processor: ResearchJobProcessor;
  close(): Promise<void>;
};

const closeRedis = async (connection: IORedis): Promise<void> => {
  if (connection.status === "end") return;

  try {
    await connection.quit();
  } catch {
    connection.disconnect();
  }
};

const createHarness = async (): Promise<Harness> => {
  const queueName = `research-worker-test-${randomUUID()}`;
  const producerConnection = createWorkerRedis(redisTestUrl);
  const workerConnection = createWorkerRedis(redisTestUrl);
  const eventsConnection = createWorkerRedis(redisTestUrl);
  const processor: ResearchJobProcessor = {
    process: vi.fn().mockResolvedValue(undefined),
  };
  const queue = new Queue(queueName, {
    connection: producerConnection,
  });
  const events = new QueueEvents(queueName, {
    connection: eventsConnection,
  });
  const worker = createResearchWorker(workerConnection, processor, {
    queueName,
  });

  await Promise.all([
    queue.waitUntilReady(),
    events.waitUntilReady(),
    worker.waitUntilReady(),
  ]);

  return {
    queue,
    events,
    worker,
    processor,
    async close() {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await Promise.all([
        closeRedis(producerConnection),
        closeRedis(workerConnection),
        closeRedis(eventsConnection),
      ]);
    },
  };
};

describe("createResearchWorker参数校验", () => {
  const unusedConnection = {} as IORedis;
  const processor: ResearchJobProcessor = {
    process: vi.fn(),
  };

  it.each(["", "   "])("拒绝空队列名称：%j", (queueName) => {
    expect(() =>
      createResearchWorker(unusedConnection, processor, {
        queueName,
        autorun: false,
      }),
    ).toThrowError("RESEARCH_QUEUE_NAME_REQUIRED");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "拒绝非法并发数：%j",
    (concurrency) => {
      expect(() =>
        createResearchWorker(unusedConnection, processor, {
          concurrency,
          autorun: false,
        }),
      ).toThrowError("RESEARCH_WORKER_CONCURRENCY_INVALID");
    },
  );
});

describe.sequential("Research Worker Redis集成", () => {
  it("使用默认并发数并把合法Job交给Processor", async () => {
    const harness = await createHarness();
    const data: ResearchRunJob = { runId };

    try {
      expect(harness.worker.concurrency).toBe(
        DEFAULT_RESEARCH_WORKER_CONCURRENCY,
      );
      expect(harness.worker.opts.maxStalledCount).toBe(1);

      const job = await harness.queue.add(RESEARCH_RUN_JOB, data, {
        jobId: randomUUID(),
      });

      await expect(
        job.waitUntilFinished(harness.events, 5_000),
      ).resolves.toBeNull();
      expect(harness.processor.process).toHaveBeenCalledOnce();
      expect(harness.processor.process).toHaveBeenCalledWith(data);
    } finally {
      await harness.close();
    }
  });

  it("错误任务名称不可重试且不会进入Processor", async () => {
    const harness = await createHarness();

    try {
      const job = await harness.queue.add(
        "unsupported-job",
        { runId },
        {
          jobId: randomUUID(),
          attempts: 4,
        },
      );

      await expect(
        job.waitUntilFinished(harness.events, 5_000),
      ).rejects.toThrow("Unsupported research job: unsupported-job");

      const stored = await harness.queue.getJob(job.id!);
      expect(stored?.attemptsMade).toBe(1);
      expect(harness.processor.process).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("非法Job数据不可重试且不会进入Processor", async () => {
    const harness = await createHarness();

    try {
      const job = await harness.queue.add(
        RESEARCH_RUN_JOB,
        { runId: "not-a-uuid" },
        {
          jobId: randomUUID(),
          attempts: 4,
        },
      );

      await expect(
        job.waitUntilFinished(harness.events, 5_000),
      ).rejects.toThrow("INVALID_RESEARCH_RUN_JOB");

      const stored = await harness.queue.getJob(job.id!);
      expect(stored?.attemptsMade).toBe(1);
      expect(harness.processor.process).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});
