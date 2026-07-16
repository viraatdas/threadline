import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { isOwnerEmail } from "@/lib/auth/owner";

export const { auth, handlers, signIn, signOut } = NextAuth({
  trustHost: true,
  session: {
    strategy: "jwt",
  },
  providers: [
    Google({
      authorization: {
        params: {
          prompt: "select_account",
          scope: "openid email profile",
        },
      },
    }),
  ],
  callbacks: {
    signIn({ user }) {
      return isOwnerEmail(user.email);
    },
    authorized({ auth: session }) {
      return isOwnerEmail(session?.user?.email);
    },
  },
});
