import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_COOKIE_NAME, resolveRequestIdentity } from "./auth";

const authSecret = "test-auth-secret-with-at-least-32-characters";

const createRequest = (cookieValue?: string) => ({
  cookies: {
    get: vi.fn((name: string) =>
      name === AUTH_COOKIE_NAME && cookieValue
        ? { value: cookieValue }
        : undefined,
    ),
  },
});

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", authSecret);
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveRequestIdentity配置校验", () => {
  it("缺少AUTH_SECRET时快速失败", () => {
    vi.stubEnv("AUTH_SECRET", "");

    expect(() => resolveRequestIdentity(createRequest())).toThrowError(
      "AUTH_SECRET_REQUIRED",
    );
  });

  it("拒绝长度不足32个字符的AUTH_SECRET", () => {
    vi.stubEnv("AUTH_SECRET", "too-short");

    expect(() => resolveRequestIdentity(createRequest())).toThrowError(
      "AUTH_SECRET_TOO_SHORT",
    );
  });
});

describe("resolveRequestIdentity", () => {
  it("首次请求创建签名匿名身份和安全Cookie", () => {
    const request = createRequest();

    const identity = resolveRequestIdentity(request);

    expect(request.cookies.get).toHaveBeenCalledWith(AUTH_COOKIE_NAME);
    expect(identity.ownerId).toMatch(
      /^anonymous:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(identity.cookie).toEqual({
      name: AUTH_COOKIE_NAME,
      value: expect.stringMatching(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/i),
      options: {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      },
    });
    expect(identity.cookie?.value).not.toContain(authSecret);
  });

  it("复用签名有效的Cookie且不重复写入Cookie", () => {
    const first = resolveRequestIdentity(createRequest());

    const second = resolveRequestIdentity(createRequest(first.cookie?.value));

    expect(second).toEqual({ ownerId: first.ownerId });
    expect(second.cookie).toBeUndefined();
  });

  it("Cookie签名被篡改时生成新的匿名身份", () => {
    const first = resolveRequestIdentity(createRequest());
    const originalCookie = first.cookie!.value;
    const tamperedCookie = `${originalCookie.slice(0, -1)}${
      originalCookie.endsWith("a") ? "b" : "a"
    }`;

    const second = resolveRequestIdentity(createRequest(tamperedCookie));

    expect(second.ownerId).not.toBe(first.ownerId);
    expect(second.cookie).toBeDefined();
  });

  it.each(["invalid", ".signature", "not-a-uuid.signature", "uuid."])(
    "格式错误的Cookie会生成新身份：%s",
    (cookieValue) => {
      const identity = resolveRequestIdentity(createRequest(cookieValue));

      expect(identity.ownerId).toMatch(/^anonymous:/);
      expect(identity.cookie).toBeDefined();
    },
  );

  it("AUTH_SECRET轮换后旧Cookie失效", () => {
    const first = resolveRequestIdentity(createRequest());

    vi.stubEnv(
      "AUTH_SECRET",
      "rotated-auth-secret-with-at-least-32-characters",
    );
    const second = resolveRequestIdentity(createRequest(first.cookie?.value));

    expect(second.ownerId).not.toBe(first.ownerId);
    expect(second.cookie).toBeDefined();
  });

  it("生产环境Cookie启用secure属性", () => {
    vi.stubEnv("NODE_ENV", "production");

    const identity = resolveRequestIdentity(createRequest());

    expect(identity.cookie?.options.secure).toBe(true);
  });
});
