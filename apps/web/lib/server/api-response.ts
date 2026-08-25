import { NextResponse } from "next/server";
import type { RequestIdentity } from "./auth";

export type ApiIssue = {
  path: string;
  message: string;
  code: string;
};

export const errorResponse = (
  status: number,
  code: string,
  message: string,
  issues: ApiIssue[] = [],
): NextResponse =>
  NextResponse.json(
    {
      code,
      message,
      issues,
    },
    {
      status,
    },
  );
export const applyIdentityCookie = (
  response: NextResponse,
  identity: RequestIdentity,
): NextResponse => {
  if (identity.cookie) {
    response.cookies.set(
      identity.cookie.name,
      identity.cookie.value,
      identity.cookie.options,
    );
  }
  return response;
};
