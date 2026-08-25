import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
export const AUTH_COOKIE_NAME = "insightforge_anonymous_session";

const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const AnonymousIdSchema = z.uuid();

export interface RequestCookieReader {
  get(name: string): { value: string } | undefined;
}

export interface IdentityRequest {
  cookies: RequestCookieReader;
}

export interface IdentityCookie {
  name: typeof AUTH_COOKIE_NAME;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: "lax";
    path: "/";
    maxAge: number;
  };
}

export interface RequestIdentity {
  ownerId: string;
  /**
   * 首次访问或Cookie失效时需要写入响应。
   * 已有合法Cookie时为undefined。
   */
  cookie?: IdentityCookie;
}

const getAuthSecret = (): string => {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("AUTH_SECRET_REQUIRED");
  }

  if (secret.length < 32) {
    throw new Error("AUTH_SECRET_TOO_SHORT");
  }

  return secret;
};

const signAnonymousId = (anonymousId: string, secret: string): string =>
  createHmac("sha256", secret).update(anonymousId).digest("base64url");

const verifyAnonymousId = (
  anonymousId: string,
  signature: string,
  secret: string,
): boolean => {
  const expected = Buffer.from(signAnonymousId(anonymousId, secret));

  const received = Buffer.from(signature);

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
};

const parseSessionCookie = (value: string, secret: string): string | null => {
  const separator = value.lastIndexOf(".");

  if (separator <= 0) return null;

  const anonymousId = value.slice(0, separator);
  const signature = value.slice(separator + 1);

  if (!AnonymousIdSchema.safeParse(anonymousId).success) {
    return null;
  }

  if (!verifyAnonymousId(anonymousId, signature, secret)) {
    return null;
  }

  return anonymousId;
};

const createSessionCookie = (
  anonymousId: string,
  secret: string,
): IdentityCookie => ({
  name: AUTH_COOKIE_NAME,
  value: `${anonymousId}.${signAnonymousId(anonymousId, secret)}`,
  options: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  },
});

export const resolveRequestIdentity = (
  request: IdentityRequest,
): RequestIdentity => {
  const secret = getAuthSecret();

  const existingCookie = request.cookies.get(AUTH_COOKIE_NAME)?.value;

  if (existingCookie) {
    const anonymousId = parseSessionCookie(existingCookie, secret);
    if (anonymousId) {
      return { ownerId: `anonymous:${anonymousId}` };
    }
  }

  const anonymousId = randomUUID();
  return {
    ownerId: `anonymous:${anonymousId}`,
    cookie: createSessionCookie(anonymousId, secret),
  };
};
