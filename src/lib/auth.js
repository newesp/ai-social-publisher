import Google from "next-auth/providers/google";
import { canSignInWithGoogle, getRoleForEmail } from "./auth/roles.js";

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
      if (user?.email) token.role = getRoleForEmail(user.email);
      return token;
    },
    async session({ session, token }) {
      session.user.role = token.role ?? "user";
      return session;
    },
  },
};
