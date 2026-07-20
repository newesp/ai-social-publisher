import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";
import {
  isBrowserRequestAuthorized,
  isLocalAuthBypassEnabled,
} from "./lib/auth/middleware-policy.js";

const authMiddleware = withAuth({
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized: isBrowserRequestAuthorized,
  },
});

export default function middleware(request) {
  if (isLocalAuthBypassEnabled()) {
    return NextResponse.next();
  }

  return authMiddleware(request);
}

export const config = {
  matcher: ["/((?!api/auth|api/cron|api/webhooks/line(?:/|$)|.well-known/workflow/|_next/static|_next/image|favicon.ico).*)"],
};
