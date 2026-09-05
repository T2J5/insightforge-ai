import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { createAdminUsageHandler } from "./route";

const runId = "550e8400-e29b-41d4-a716-446655440000";
const context = { params: Promise.resolve({ runId }) };

describe("GET admin run usage", () => {
  it("rejects requests without the explicit admin bearer token", async () => {
    const query = { get: vi.fn() };
    const handler = createAdminUsageHandler(query, () => "secret-token");
    const response = await handler(
      new NextRequest(`http://localhost/api/admin/runs/${runId}/usage`),
      context,
    );
    expect(response.status).toBe(403);
    expect(query.get).not.toHaveBeenCalled();
  });

  it("returns only aggregate and allowlisted event metadata", async () => {
    const query = {
      get: vi.fn().mockResolvedValue({
        run: { tokenUsage: 30, estimatedCostCny: 0.2 },
        events: [
          {
            provider: "ai-sdk",
            model: "test-model",
            operation: "write-report",
            inputTokens: 10,
            outputTokens: 20,
            estimatedCostCny: 0.2,
            latencyMs: 100,
            cacheHit: false,
            retryCount: 0,
            node: "writer",
            createdAt: "2026-09-04T00:00:00.000Z",
          },
        ],
      }),
    };
    const handler = createAdminUsageHandler(query, () => "secret-token");
    const response = await handler(
      new NextRequest(`http://localhost/api/admin/runs/${runId}/usage`, {
        headers: { authorization: "Bearer secret-token" },
      }),
      context,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tokenUsage).toBe(30);
    expect(JSON.stringify(body)).not.toContain("prompt");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
