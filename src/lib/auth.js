import Google from "next-auth/providers/google";
import { canSignInWithGoogle, normalizeEmail } from "./auth/policy.js";
import { getRoleForEmail } from "./auth/roles.js";

export const authOptions = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      return canSignInWithGoogle(user?.email);
    },
    async jwt({ token, user }) {
      const email = normalizeEmail(user?.email ?? token.email);
      if (email) {
        token.email = email;
        token.role = getRoleForEmail(email);
      }
      return token;
    },
    async session({ session, token }) {
      const email = normalizeEmail(token.email ?? session.user?.email);
      session.user.email = email;
      session.user.role = token.role ?? getRoleForEmail(email);
      return session;
    },
  },
};
