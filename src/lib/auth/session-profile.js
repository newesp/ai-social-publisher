import { normalizeEmail } from "./policy.js";
import { getRoleForEmail } from "./roles.js";

export function applyGoogleProfileToToken({ token, user }) {
  const email = normalizeEmail(user?.email ?? token.email);
  if (email) {
    token.email = email;
    token.role = getRoleForEmail(email);
  }
  if (user?.name) token.name = user.name;
  if (user?.image) token.picture = user.image;
  return token;
}

export function applyTokenToSession({ session, token }) {
  const user = session.user ?? {};
  const email = normalizeEmail(token.email ?? user.email);
  session.user = {
    ...user,
    email,
    name: token.name ?? user.name ?? null,
    image: token.picture ?? user.image ?? null,
    role: token.role ?? getRoleForEmail(email),
  };
  return session;
}

export async function fetchSessionOwner(fetchImpl = fetch) {
  const response = await fetchImpl("/api/auth/session");
  if (!response?.ok) throw new Error("無法確認登入狀態，請重新整理後再試。");
  const session = await response.json();
  return normalizeEmail(session?.user?.email) || "anonymous";
}
