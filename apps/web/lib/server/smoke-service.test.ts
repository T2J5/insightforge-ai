import { describe, expect, it } from "vitest";

import { createSmokeFixture } from "./demo-fixture";
import { isValidSmokeToken } from "./smoke-service";

describe("deployment smoke service", () => {
  it("只接受长度足够且完全匹配的 Bearer token", () => {
    const token = "a".repeat(32);
    expect(isValidSmokeToken(`Bearer ${token}`, token)).toBe(true);
    expect(isValidSmokeToken(`Bearer ${"b".repeat(32)}`, token)).toBe(false);
    expect(isValidSmokeToken(null, token)).toBe(false);
    expect(isValidSmokeToken(`Bearer short`, "short")).toBe(false);
  });

  it("生成新的完成态零成本夹具身份", () => {
    const fixture = createSmokeFixture();
    expect(fixture.reportId).toBe(fixture.runId);
    expect(fixture.content.sections).toHaveLength(7);
    expect(fixture.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
