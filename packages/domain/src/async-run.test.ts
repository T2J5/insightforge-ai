import { describe, expect, it } from "vitest";

import {
  CreateRunRequestSchema,
  RESEARCH_RUN_JOB,
  RESEARCH_RUN_QUEUE,
  ResearchRunJobSchema,
  RunProgressEventSchema,
} from "./async-run";

const runId = "550e8400-e29b-41d4-a716-446655440000";

const validDocumentId = "650e8400-e29b-41d4-a716-446655440000";

const validRequest = {
  company: "字节跳动",
  focus: "comprehensive",
  depth: "quick",
  documentIds: [validDocumentId],
} as const;

const validProgressEvent = {
  id: 1,
  runId,
  type: "progress",
  status: "running",
  stage: "searching",
  message: "正在搜索公开资料",
  progress: 30,
  occurredAt: "2026-08-15T08:00:00.000Z",
  data: {
    queryCount: 3,
  },
} as const;

describe("异步调研常量", () => {
  it("使用固定的队列名称和任务名称", () => {
    expect(RESEARCH_RUN_QUEUE).toBe("research-runs");
    expect(RESEARCH_RUN_JOB).toBe("research-run");
  });
});

describe("CreateRunRequestSchema", () => {
  it("接受合法请求并清理公司名称首尾空格", () => {
    const result = CreateRunRequestSchema.parse({
      ...validRequest,
      company: " 字节跳动 ",
    });

    expect(result).toEqual({
      company: "字节跳动",
      focus: "comprehensive",
      depth: "quick",
      documentIds: [validDocumentId],
    });
  });

  it("没有传入 documentIds 时默认为空数组", () => {
    const result = CreateRunRequestSchema.parse({
      company: "OpenAI",
      focus: "technology",
      depth: "deep",
    });

    expect(result.documentIds).toEqual([]);
  });

  it.each([
    ["少于2个字符", "A"],
    ["超过120个字符", "A".repeat(121)],
  ])("拒绝%s的公司名称", (_description, company) => {
    const result = CreateRunRequestSchema.safeParse({
      ...validRequest,
      company,
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ["未知调研方向", { focus: "finance" }],
    ["未知调研深度", { depth: "medium" }],
  ])("拒绝%s", (_description, invalidFields) => {
    const result = CreateRunRequestSchema.safeParse({
      ...validRequest,
      ...invalidFields,
    });

    expect(result.success).toBe(false);
  });

  it("接受最多10个文档ID", () => {
    const documentIds = Array.from(
      { length: 10 },
      (_, index) =>
        `650e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}`,
    );

    const result = CreateRunRequestSchema.safeParse({
      ...validRequest,
      documentIds,
    });

    expect(result.success).toBe(true);
  });

  it("拒绝超过10个文档ID", () => {
    const documentIds = Array.from(
      { length: 11 },
      (_, index) =>
        `650e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}`,
    );

    const result = CreateRunRequestSchema.safeParse({
      ...validRequest,
      documentIds,
    });

    expect(result.success).toBe(false);
  });

  it("拒绝不是UUID的文档ID", () => {
    const result = CreateRunRequestSchema.safeParse({
      ...validRequest,
      documentIds: ["document-1"],
    });

    expect(result.success).toBe(false);
  });

  it("拒绝客户端提交ownerId等额外字段", () => {
    const result = CreateRunRequestSchema.safeParse({
      ...validRequest,
      ownerId: "user-1",
    });

    expect(result.success).toBe(false);
  });
});

describe("ResearchRunJobSchema", () => {
  it("接受只包含runId的队列任务", () => {
    expect(
      ResearchRunJobSchema.parse({
        runId,
      }),
    ).toEqual({
      runId,
    });
  });

  it("拒绝无效的runId", () => {
    const result = ResearchRunJobSchema.safeParse({
      runId: "invalid-run-id",
    });

    expect(result.success).toBe(false);
  });

  it("拒绝ownerId等额外队列字段", () => {
    const result = ResearchRunJobSchema.safeParse({
      runId,
      ownerId: "user-1",
    });

    expect(result.success).toBe(false);
  });
});

describe("RunProgressEventSchema", () => {
  it("接受合法的进度事件", () => {
    const result = RunProgressEventSchema.parse(validProgressEvent);

    expect(result).toEqual(validProgressEvent);
  });

  it("没有传入data时默认为空对象", () => {
    const { data: _data, ...eventWithoutData } = validProgressEvent;

    const result = RunProgressEventSchema.parse(eventWithoutData);

    expect(result.data).toEqual({});
  });

  it.each([-1, 101, 1.5])("拒绝无效的进度值 %s", (progress) => {
    const result = RunProgressEventSchema.safeParse({
      ...validProgressEvent,
      progress,
    });

    expect(result.success).toBe(false);
  });

  it.each([0, -1, 1.5])("拒绝无效的事件ID %s", (id) => {
    const result = RunProgressEventSchema.safeParse({
      ...validProgressEvent,
      id,
    });

    expect(result.success).toBe(false);
  });

  it("拒绝无效的事件时间", () => {
    const result = RunProgressEventSchema.safeParse({
      ...validProgressEvent,
      occurredAt: "2026-08-15",
    });

    expect(result.success).toBe(false);
  });

  it("拒绝未知的事件类型", () => {
    const result = RunProgressEventSchema.safeParse({
      ...validProgressEvent,
      type: "debug",
    });

    expect(result.success).toBe(false);
  });

  it("拒绝未知的任务状态", () => {
    const result = RunProgressEventSchema.safeParse({
      ...validProgressEvent,
      status: "paused",
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ["Date", new Date()],
    ["函数", () => "invalid"],
    ["undefined", undefined],
  ])("拒绝data中的非JSON值：%s", (_description, value) => {
    const result = RunProgressEventSchema.safeParse({
      ...validProgressEvent,
      data: {
        value,
      },
    });

    expect(result.success).toBe(false);
  });

  it("拒绝额外字段", () => {
    const result = RunProgressEventSchema.safeParse({
      ...validProgressEvent,
      internalSecret: "should-not-be-exposed",
    });

    expect(result.success).toBe(false);
  });
});
