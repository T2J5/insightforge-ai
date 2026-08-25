import type { RunProgressEvent, RunStatus } from "@insightforge/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createRunEventStream,
  type RunEventReader,
  type RunEventSubscriber,
} from "./run-event-stream";

const runId = "550e8400-e29b-41d4-a716-446655440000";
const decoder = new TextDecoder();

const event = (
  id: number,
  status: RunStatus = "running",
): RunProgressEvent => ({
  id,
  runId,
  type: "progress",
  status,
  stage: status,
  message: `进度事件 ${id}`,
  progress: status === "completed" ? 100 : id * 10,
  occurredAt: `2026-08-24T08:00:0${id}.000Z`,
  data: {},
});

const serialize = (value: RunProgressEvent): string => JSON.stringify(value);

class FakeSubscriber implements RunEventSubscriber {
  readonly subscribe = vi.fn(async (_channel: string) => 1);
  readonly unsubscribe = vi.fn(async (_channel: string) => 0);
  readonly quit = vi.fn(async () => "OK" as const);

  private readonly listeners = new Set<
    (channel: string, message: string) => void
  >();

  on(
    eventName: "message",
    listener: (channel: string, message: string) => void,
  ): this {
    if (eventName === "message") this.listeners.add(listener);
    return this;
  }

  off(
    eventName: "message",
    listener: (channel: string, message: string) => void,
  ): this {
    if (eventName === "message") this.listeners.delete(listener);
    return this;
  }

  emit(channel: string, message: string): void {
    for (const listener of this.listeners) listener(channel, message);
  }
}

const createReader = (events: RunProgressEvent[]): RunEventReader => ({
  lrange: vi.fn(async () => events.map(serialize)),
});

const readChunk = async (
  streamReader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> => {
  const result = await streamReader.read();
  expect(result.done).toBe(false);
  return decoder.decode(result.value);
};

describe("createRunEventStream", () => {
  it("只回放 Last-Event-ID 之后的事件，并使用标准 SSE 格式", async () => {
    const subscriber = new FakeSubscriber();
    const stream = createRunEventStream({
      runId,
      currentStatus: "running",
      lastEventId: 1,
      reader: createReader([event(1), event(2)]),
      subscriber,
    });
    const streamReader = stream.getReader();

    const chunk = await readChunk(streamReader);

    expect(chunk).toContain("id: 2\n");
    expect(chunk).toContain("event: progress\n");
    expect(chunk).toContain(`data: ${serialize(event(2))}\n\n`);
    expect(chunk).not.toContain("id: 1\n");
    await streamReader.cancel();
  });

  it("订阅 Redis 频道并向客户端转发实时事件", async () => {
    const subscriber = new FakeSubscriber();
    const stream = createRunEventStream({
      runId,
      currentStatus: "running",
      lastEventId: 0,
      reader: createReader([]),
      subscriber,
    });
    const streamReader = stream.getReader();

    await vi.waitFor(() => expect(subscriber.subscribe).toHaveBeenCalled());
    subscriber.emit(`run:${runId}:events`, serialize(event(1)));

    expect(await readChunk(streamReader)).toContain("id: 1\n");
    await streamReader.cancel();
  });

  it("订阅期间产生的事件不会因回放竞态而丢失或重复", async () => {
    let resolveReplay!: (events: string[]) => void;
    const replay = new Promise<string[]>((resolve) => {
      resolveReplay = resolve;
    });
    const reader: RunEventReader = {
      lrange: vi.fn(() => replay),
    };
    const subscriber = new FakeSubscriber();
    const stream = createRunEventStream({
      runId,
      currentStatus: "running",
      lastEventId: 0,
      reader,
      subscriber,
    });
    const streamReader = stream.getReader();

    await vi.waitFor(() => expect(subscriber.subscribe).toHaveBeenCalled());
    subscriber.emit(`run:${runId}:events`, serialize(event(2)));
    resolveReplay([serialize(event(1)), serialize(event(2))]);

    const output =
      (await readChunk(streamReader)) + (await readChunk(streamReader));
    expect(output.match(/id: 1\n/g)).toHaveLength(1);
    expect(output.match(/id: 2\n/g)).toHaveLength(1);
    await streamReader.cancel();
  });

  it("定期发送 SSE 注释心跳", async () => {
    const subscriber = new FakeSubscriber();
    const stream = createRunEventStream({
      runId,
      currentStatus: "running",
      lastEventId: 0,
      reader: createReader([]),
      subscriber,
      heartbeatMs: 5,
    });
    const streamReader = stream.getReader();

    expect(await readChunk(streamReader)).toBe(": heartbeat\n\n");
    await streamReader.cancel();
  });

  it("发送终态事件后关闭流并释放订阅连接", async () => {
    const subscriber = new FakeSubscriber();
    const stream = createRunEventStream({
      runId,
      currentStatus: "running",
      lastEventId: 0,
      reader: createReader([event(1, "completed")]),
      subscriber,
    });
    const streamReader = stream.getReader();

    expect(await readChunk(streamReader)).toContain("event: progress\n");
    await expect(streamReader.read()).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => {
      expect(subscriber.unsubscribe).toHaveBeenCalledWith(
        `run:${runId}:events`,
      );
      expect(subscriber.quit).toHaveBeenCalledOnce();
    });
  });

  it("客户端取消读取时解除订阅并关闭专用 Redis 连接", async () => {
    const subscriber = new FakeSubscriber();
    const stream = createRunEventStream({
      runId,
      currentStatus: "running",
      lastEventId: 0,
      reader: createReader([]),
      subscriber,
    });
    const streamReader = stream.getReader();

    await vi.waitFor(() => expect(subscriber.subscribe).toHaveBeenCalled());
    await streamReader.cancel();

    expect(subscriber.unsubscribe).toHaveBeenCalledWith(`run:${runId}:events`);
    expect(subscriber.quit).toHaveBeenCalledOnce();
  });

  it("忽略格式损坏或属于其他 Run 的 Redis 消息", async () => {
    const subscriber = new FakeSubscriber();
    const stream = createRunEventStream({
      runId,
      currentStatus: "running",
      lastEventId: 0,
      reader: createReader([]),
      subscriber,
      heartbeatMs: 5,
    });
    const streamReader = stream.getReader();

    await vi.waitFor(() => expect(subscriber.subscribe).toHaveBeenCalled());
    subscriber.emit(`run:${runId}:events`, "not-json");
    subscriber.emit(
      `run:${runId}:events`,
      JSON.stringify({ ...event(1), runId: crypto.randomUUID() }),
    );

    expect(await readChunk(streamReader)).toBe(": heartbeat\n\n");
    await streamReader.cancel();
  });
});
