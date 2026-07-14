import Google from "next-auth/providers/google";
import { canSignInWithGoogle } from "./auth/policy.js";
import { applyGoogleProfileToToken, applyTokenToSession } from "./auth/session-profile.js";

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
      return applyGoogleProfileToToken({ token, user });
    },
    async session({ session, token }) {
      return applyTokenToSession({ session, token });
    },
  },
};
