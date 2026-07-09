import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

const authMiddleware = withAuth({
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized: ({ token }) => Boolean(token),
  },
});

export default function middleware(request) {
  if (process.env.DISABLE_AUTH_FOR_LOCAL_DEV === "true") {
    return NextResponse.next();
  }

  return authMiddleware(request);
}

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
