# Scheduled Posts Auth DB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build per-user Google-authenticated settings, post history, immediate publishing, scheduled publishing, and scheduled cancellation with DB persistence.

**Architecture:** Add a small auth policy layer, encrypted per-user settings storage, DB-backed post repository/services, and a scheduler runner that can be triggered by Vercel Cron today or n8n later. Keep provider publishing side effects behind `publishTargets()` and test with fakes only.

**Tech Stack:** Next.js App Router, NextAuth Google provider, Drizzle ORM, Turso/libSQL, Node `crypto`, Mantine, `node --test`.

## Global Constraints

- `AUTH_MODE=demo` means any authenticated Google account can sign in and operate on its own data.
- `AUTH_MODE=production` means only emails in `ADMIN_EMAILS` can sign in and operate.
- All posts, history, settings, generation, publishing, scheduling, and cancellation are scoped by normalized Google email.
- User API keys and tokens are stored in `user_settings`, encrypted at rest with `SETTINGS_ENCRYPTION_KEY`.
- `SETTINGS_ENCRYPTION_KEY` is a base64-encoded 32-byte key.
- `encrypted_value` is a JSON envelope with `version`, `cipher`, `iv`, `tag`, and `ciphertext`.
- Vercel Hobby cron uses `0 1 * * *`, UTC, for the 9:00 AM Taiwan hour.
- Scheduler triggers are separate from scheduler behavior; n8n can later trigger the same app-owned scheduler API.
- The UI schedule flow has a Schedule button, a date picker, and a time select; the only initial time value is `9:00 AM`.
- Automated tests and implementation verification must use mocks/fakes for Meta, LINE, OpenAI, Google AI, and image upload side effects.
- Do not run live Meta or LINE publish verification unless the user explicitly approves the exact destination account/channel/page and payload at that time.
- Existing user changes in the worktree must not be reverted.

---

## File Structure

- Modify `src/lib/db/schema.js`: add owner fields, publishing timestamp, indexes, unique constraints, and `userSettings`.
- Create `src/lib/auth/policy.js`: auth mode, email normalization, allowlist checks.
- Create `src/lib/auth/route-guards.js`: server route helpers around NextAuth session and auth policy.
- Modify `src/lib/auth.js`: use policy for sign-in and normalized role assignment.
- Modify `src/middleware.js`: keep authenticated app protection, exclude `/api/cron`.
- Create `src/lib/settings/settings-encryption.js`: AES-256-GCM JSON envelope encryption.
- Create `src/lib/settings/user-settings-store.js`: per-user encrypted settings read/write/mask.
- Modify `src/app/api/settings/route.js`: use user settings store and route guards.
- Modify `src/app/api/settings/export/route.js` and `src/app/api/settings/import/route.js`: scope bundles to signed-in user.
- Modify `src/app/api/generate/route.js`: require user and read per-user settings.
- Create `src/lib/posts/post-status.js`: shared status constants and parent status calculation.
- Create `src/lib/posts/schedule-time.js`: compute Taiwan 9:00 AM scheduled timestamps.
- Create `src/lib/posts/error-redaction.js`: sanitize provider errors before persistence/response.
- Create `src/lib/posts/post-repository.js`: DB operations and atomic claims.
- Create `src/lib/posts/publish-runner.js`: publish stored targets with per-user settings.
- Create `src/lib/posts/post-service.js`: create, publish, cancel, list use cases.
- Create `src/lib/scheduler/run-due-post-scheduler.js`: due-post scheduler behavior.
- Modify `src/app/api/posts/route.js`: replace demo data with DB-backed create/list.
- Modify `src/app/api/posts/[id]/route.js`: cancel scheduled posts.
- Modify `src/app/api/posts/[id]/publish/route.js`: manual publish/retry via service.
- Modify `src/app/api/cron/route.js`: bearer-secret protected scheduler trigger.
- Modify `vercel.json`: set daily `0 1 * * *`.
- Modify `.env.example`: add `AUTH_MODE`, `MIGRATION_OWNER_EMAIL`, and clarify cron/encryption values.
- Modify `src/components/CreatePostWizard.js`: mode control, date picker, schedule submit, publish submit.
- Modify `src/app/history/page.js`: fetch DB history and support cancellation.
- Modify `src/components/AppShellFrame.js`: show signed-in user and call NextAuth sign-out.
- Modify `src/app/login/page.js`: call NextAuth Google sign-in cleanly.
- Add tests under `tests/` for auth policy, settings encryption/store, post repository/service, scheduler, API helpers, and wizard scheduling logic.

---

### Task 1: Auth Policy And Route Guards

**Files:**
- Create: `src/lib/auth/policy.js`
- Create: `src/lib/auth/route-guards.js`
- Modify: `src/lib/auth.js`
- Modify: `src/lib/auth/roles.js`
- Modify: `src/middleware.js`
- Test: `tests/auth-policy.test.js`

**Interfaces:**
- Produces: `normalizeEmail(email: string): string`
- Produces: `getAuthMode(env?: object): "demo" | "production"`
- Produces: `canSignInWithGoogle(email: string, env?: object): boolean`
- Produces: `canUseApp(email: string, env?: object): boolean`
- Produces: `canPublish(email: string, env?: object): boolean`
- Produces: `canManageSettings(email: string, env?: object): boolean`
- Produces: `requireAppUser(): Promise<string>`
- Produces: `requirePublisher(): Promise<string>`
- Produces: `requireSettingsAccess(): Promise<string>`
- Consumes: existing NextAuth `authOptions`.

- [ ] **Step 1: Write the failing auth policy tests**

Create `tests/auth-policy.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canManageSettings,
  canPublish,
  canSignInWithGoogle,
  canUseApp,
  getAuthMode,
  normalizeEmail,
} from "../src/lib/auth/policy.js";

test("normalizes Google account emails", () => {
  assert.equal(normalizeEmail(" Owner@Example.COM "), "owner@example.com");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail(null), "");
});

test("demo mode allows any non-empty Google email to operate on own data", () => {
  const env = { AUTH_MODE: "demo", ADMIN_EMAILS: "" };

  assert.equal(getAuthMode(env), "demo");
  assert.equal(canSignInWithGoogle("guest@example.com", env), true);
  assert.equal(canUseApp("guest@example.com", env), true);
  assert.equal(canPublish("guest@example.com", env), true);
  assert.equal(canManageSettings("guest@example.com", env), true);
  assert.equal(canSignInWithGoogle("", env), false);
});

test("production mode allows only ADMIN_EMAILS", () => {
  const env = { AUTH_MODE: "production", ADMIN_EMAILS: " Owner@Example.com,admin@example.com " };

  assert.equal(getAuthMode(env), "production");
  assert.equal(canSignInWithGoogle("owner@example.com", env), true);
  assert.equal(canUseApp("ADMIN@example.com", env), true);
  assert.equal(canPublish("guest@example.com", env), false);
  assert.equal(canManageSettings("guest@example.com", env), false);
});
```

- [ ] **Step 2: Run the failing auth policy test**

Run: `npm.cmd test -- tests/auth-policy.test.js`

Expected: FAIL with `Cannot find module '../src/lib/auth/policy.js'`.

- [ ] **Step 3: Implement centralized auth policy**

Create `src/lib/auth/policy.js`:

```js
export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function getAuthMode(env = process.env) {
  return env.AUTH_MODE === "production" ? "production" : "demo";
}

export function parseAdminEmails(env = process.env) {
  return new Set(
    String(env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => normalizeEmail(email))
      .filter(Boolean),
  );
}

export function isAllowedProductionEmail(email, env = process.env) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && parseAdminEmails(env).has(normalized);
}

export function canSignInWithGoogle(email, env = process.env) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (getAuthMode(env) === "demo") return true;
  return isAllowedProductionEmail(normalized, env);
}

export function canUseApp(email, env = process.env) {
  return canSignInWithGoogle(email, env);
}

export function canPublish(email, env = process.env) {
  return canSignInWithGoogle(email, env);
}

export function canManageSettings(email, env = process.env) {
  return canSignInWithGoogle(email, env);
}

export function getRoleForEmail(email, env = process.env) {
  return isAllowedProductionEmail(email, env) ? "admin" : "user";
}
```

- [ ] **Step 4: Keep legacy role exports compatible**

Replace `src/lib/auth/roles.js` with:

```js
export {
  canSignInWithGoogle,
  getRoleForEmail,
  isAllowedProductionEmail as isAdminEmail,
  normalizeEmail,
  parseAdminEmails,
} from "./policy.js";

export function requireAdminEmail(email, env = process.env) {
  if (!isAdminEmail(email, env)) {
    const error = new Error("Admin privileges are required.");
    error.status = 403;
    throw error;
  }
}
```

Then adjust the import inside that file to include `isAdminEmail` if the re-export syntax needs a local binding:

```js
import { isAllowedProductionEmail as isAdminEmail } from "./policy.js";

export {
  canSignInWithGoogle,
  getRoleForEmail,
  isAllowedProductionEmail as isAdminEmail,
  normalizeEmail,
  parseAdminEmails,
} from "./policy.js";
```

- [ ] **Step 5: Normalize session email in NextAuth**

Modify `src/lib/auth.js` callbacks:

```js
import Google from "next-auth/providers/google";
import { canSignInWithGoogle, getRoleForEmail, normalizeEmail } from "./auth/policy.js";

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
```

- [ ] **Step 6: Add route guards**

Create `src/lib/auth/route-guards.js`:

```js
import { getServerSession } from "next-auth";
import { authOptions } from "../auth.js";
import {
  canManageSettings,
  canPublish,
  canUseApp,
  normalizeEmail,
} from "./policy.js";

export async function requireAppUser() {
  return requireEmailWithPolicy(canUseApp);
}

export async function requirePublisher() {
  return requireEmailWithPolicy(canPublish);
}

export async function requireSettingsAccess() {
  return requireEmailWithPolicy(canManageSettings);
}

async function requireEmailWithPolicy(policy) {
  const session = await getServerSession(authOptions);
  const email = normalizeEmail(session?.user?.email);

  if (!email) {
    throwRouteError("Authentication is required.", 401);
  }
  if (!policy(email)) {
    throwRouteError("This account is not allowed to use this app.", 403);
  }

  return email;
}

function throwRouteError(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export function routeErrorResponse(error, NextResponse) {
  return NextResponse.json(
    { error: error.message ?? "Request failed." },
    { status: error.status ?? 500 },
  );
}
```

- [ ] **Step 7: Exclude cron from middleware session protection**

Modify `src/middleware.js` matcher to exclude `/api/cron`:

```js
export const config = {
  matcher: ["/((?!api/auth|api/cron|_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 8: Run auth tests**

Run: `npm.cmd test -- tests/auth-policy.test.js tests/roles.test.js`

Expected: PASS. If `tests/roles.test.js` still expects demo to allow empty email, update it to assert empty email is rejected because a real Google session must include an email.

- [ ] **Step 9: Commit auth policy foundation**

```bash
git add src/lib/auth.js src/lib/auth/policy.js src/lib/auth/route-guards.js src/lib/auth/roles.js src/middleware.js tests/auth-policy.test.js tests/roles.test.js
git commit -m "feat: add auth policy and route guards"
```

---

### Task 2: Schema And Per-User Encrypted Settings

**Files:**
- Modify: `src/lib/db/schema.js`
- Create: `src/lib/settings/settings-encryption.js`
- Create: `src/lib/settings/user-settings-store.js`
- Modify: `src/app/api/settings/route.js`
- Modify: `src/app/api/settings/export/route.js`
- Modify: `src/app/api/settings/import/route.js`
- Test: `tests/settings-encryption.test.js`
- Test: `tests/user-settings-store.test.js`

**Interfaces:**
- Consumes: `normalizeEmail(email)` from Task 1.
- Produces: `encryptSettingValue(value, env): string`
- Produces: `decryptSettingValue(envelopeJson, env): string`
- Produces: `readUserSettings(ownerEmail, options?): Promise<object>`
- Produces: `getMaskedUserSettings(ownerEmail, options?): Promise<object>`
- Produces: `updateUserSettings(ownerEmail, updates, options?): Promise<object>`
- Produces: `replaceUserSettings(ownerEmail, settings, options?): Promise<object>`

- [ ] **Step 1: Write encryption tests**

Create `tests/settings-encryption.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decryptSettingValue,
  encryptSettingValue,
} from "../src/lib/settings/settings-encryption.js";

const key = Buffer.alloc(32, 7).toString("base64");

test("encrypts settings as an AES-GCM envelope", () => {
  const encrypted = encryptSettingValue("secret-value", { SETTINGS_ENCRYPTION_KEY: key });
  const envelope = JSON.parse(encrypted);

  assert.equal(envelope.version, 1);
  assert.equal(envelope.cipher, "aes-256-gcm");
  assert.equal(typeof envelope.iv, "string");
  assert.equal(typeof envelope.tag, "string");
  assert.equal(typeof envelope.ciphertext, "string");
  assert.notEqual(encrypted.includes("secret-value"), true);
  assert.equal(decryptSettingValue(encrypted, { SETTINGS_ENCRYPTION_KEY: key }), "secret-value");
});

test("rejects missing or invalid encryption key", () => {
  assert.throws(() => encryptSettingValue("secret", {}), /SETTINGS_ENCRYPTION_KEY/);
  assert.throws(
    () => encryptSettingValue("secret", { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(8).toString("base64") }),
    /32-byte/,
  );
});
```

- [ ] **Step 2: Run the failing encryption test**

Run: `npm.cmd test -- tests/settings-encryption.test.js`

Expected: FAIL with `Cannot find module '../src/lib/settings/settings-encryption.js'`.

- [ ] **Step 3: Implement settings encryption**

Create `src/lib/settings/settings-encryption.js`:

```js
import crypto from "node:crypto";

const CIPHER = "aes-256-gcm";
const VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;

export function encryptSettingValue(value, env = process.env) {
  const key = readEncryptionKey(env);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value ?? ""), "utf8"),
    cipher.final(),
  ]);

  return JSON.stringify({
    version: VERSION,
    cipher: CIPHER,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  });
}

export function decryptSettingValue(envelopeJson, env = process.env) {
  const key = readEncryptionKey(env);
  const envelope = JSON.parse(envelopeJson);

  if (envelope.version !== VERSION || envelope.cipher !== CIPHER) {
    throw new Error("Unsupported encrypted setting envelope.");
  }

  const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function readEncryptionKey(env) {
  const raw = env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("SETTINGS_ENCRYPTION_KEY is required.");
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("SETTINGS_ENCRYPTION_KEY must decode to a 32-byte key.");
  }
  return key;
}
```

- [ ] **Step 4: Extend DB schema**

Modify `src/lib/db/schema.js` imports and tables:

```js
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
```

Update `posts`:

```js
export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerEmail: text("owner_email").notNull(),
    productName: text("product_name").notNull(),
    productFeatures: text("product_features").notNull(),
    imagePrompt: text("image_prompt"),
    imageImgurUrl: text("image_imgur_url"),
    status: text("status").notNull().default("draft"),
    scheduledFor: integer("scheduled_for", { mode: "timestamp" }),
    publishingStartedAt: integer("publishing_started_at", { mode: "timestamp" }),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    schedulerIdx: index("posts_status_scheduled_for_idx").on(table.status, table.scheduledFor),
    ownerHistoryIdx: index("posts_owner_email_created_at_idx").on(table.ownerEmail, table.createdAt),
  }),
);
```

Update `postTargets`:

```js
export const postTargets = sqliteTable(
  "post_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id),
    platform: text("platform").notNull(),
    content: text("content").notNull(),
    hashtagsJson: text("hashtags_json").notNull().default("[]"),
    status: text("status").notNull().default("draft"),
    externalPostId: text("external_post_id"),
    errorMessage: text("error_message"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    postPlatformIdx: uniqueIndex("post_targets_post_id_platform_idx").on(table.postId, table.platform),
  }),
);
```

Add `userSettings`:

```js
export const userSettings = sqliteTable(
  "user_settings",
  {
    ownerEmail: text("owner_email").notNull(),
    key: text("key").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.ownerEmail, table.key] }),
  }),
);
```

- [ ] **Step 5: Write per-user settings store tests**

Create `tests/user-settings-store.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getMaskedUserSettings,
  readUserSettings,
  updateUserSettings,
} from "../src/lib/settings/user-settings-store.js";

const key = Buffer.alloc(32, 9).toString("base64");

function createMemoryStore() {
  const rows = new Map();
  return {
    rows,
    async selectByOwner(ownerEmail) {
      return [...rows.values()].filter((row) => row.ownerEmail === ownerEmail);
    },
    async upsert(row) {
      rows.set(`${row.ownerEmail}:${row.key}`, row);
    },
    async delete(ownerEmail, settingKey) {
      rows.delete(`${ownerEmail}:${settingKey}`);
    },
  };
}

test("stores settings per normalized owner email", async () => {
  const store = createMemoryStore();
  await updateUserSettings(" Owner@Example.com ", { openAiApiKey: "sk-secret" }, { store, env: { SETTINGS_ENCRYPTION_KEY: key } });
  await updateUserSettings("other@example.com", { openAiApiKey: "sk-other" }, { store, env: { SETTINGS_ENCRYPTION_KEY: key } });

  assert.deepEqual(await readUserSettings("owner@example.com", { store, env: { SETTINGS_ENCRYPTION_KEY: key } }), {
    openAiApiKey: "sk-secret",
  });
  assert.deepEqual(await readUserSettings("other@example.com", { store, env: { SETTINGS_ENCRYPTION_KEY: key } }), {
    openAiApiKey: "sk-other",
  });
});

test("ignores empty values, clears explicit clearKeys, and masks secrets", async () => {
  const store = createMemoryStore();
  const options = { store, env: { SETTINGS_ENCRYPTION_KEY: key } };

  await updateUserSettings("owner@example.com", { metaPageAccessToken: "token-secret", metaPageId: "12345" }, options);
  await updateUserSettings("owner@example.com", { metaPageAccessToken: "", clearKeys: ["metaPageId"] }, options);

  assert.deepEqual(await readUserSettings("owner@example.com", options), {
    metaPageAccessToken: "token-secret",
  });
  assert.deepEqual(await getMaskedUserSettings("owner@example.com", options), {
    metaPageAccessToken: "tok...ret",
  });
});

test("rejects masked placeholders submitted as values", async () => {
  const store = createMemoryStore();
  await assert.rejects(
    updateUserSettings("owner@example.com", { openAiApiKey: "sk-...ret" }, { store, env: { SETTINGS_ENCRYPTION_KEY: key } }),
    /masked placeholder/,
  );
});
```

- [ ] **Step 6: Implement user settings store with testable adapter**

Create `src/lib/settings/user-settings-store.js`:

```js
import { eq } from "drizzle-orm";
import { createDbClient } from "../db/index.js";
import { userSettings } from "../db/schema.js";
import { normalizeEmail } from "../auth/policy.js";
import { maskSecret } from "./secret-bundle.js";
import { decryptSettingValue, encryptSettingValue } from "./settings-encryption.js";

const PUBLIC_SETTING_KEYS = new Set(["metaPageId"]);
const MASKED_PLACEHOLDER_PATTERN = /^.{1,3}\.\.\..{1,3}$/;

export async function readUserSettings(ownerEmail, options = {}) {
  const owner = normalizeEmail(ownerEmail);
  const store = options.store ?? createDrizzleSettingsStore(options.db ?? createDbClient());
  const rows = await store.selectByOwner(owner);

  return Object.fromEntries(
    rows.map((row) => [
      row.key,
      decryptSettingValue(row.encryptedValue, options.env ?? process.env),
    ]),
  );
}

export async function getMaskedUserSettings(ownerEmail, options = {}) {
  const settings = await readUserSettings(ownerEmail, options);
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [
      key,
      PUBLIC_SETTING_KEYS.has(key) ? value : maskSecret(value),
    ]),
  );
}

export async function updateUserSettings(ownerEmail, updates = {}, options = {}) {
  const owner = normalizeEmail(ownerEmail);
  const store = options.store ?? createDrizzleSettingsStore(options.db ?? createDbClient());
  const now = options.now ?? new Date();
  const { clearKeys = [], ...values } = updates;

  for (const key of clearKeys) {
    await store.delete(owner, key);
  }

  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === "") continue;
    if (MASKED_PLACEHOLDER_PATTERN.test(String(value))) {
      throw new Error(`Refusing to save masked placeholder for ${key}.`);
    }

    await store.upsert({
      ownerEmail: owner,
      key,
      encryptedValue: encryptSettingValue(value, options.env ?? process.env),
      updatedAt: now,
    });
  }

  return readUserSettings(owner, options);
}

export async function replaceUserSettings(ownerEmail, settings, options = {}) {
  const owner = normalizeEmail(ownerEmail);
  const existing = await readUserSettings(owner, options);
  return updateUserSettings(
    owner,
    { clearKeys: Object.keys(existing), ...settings },
    options,
  );
}

function createDrizzleSettingsStore(db) {
  return {
    async selectByOwner(ownerEmail) {
      return db.select().from(userSettings).where(eq(userSettings.ownerEmail, ownerEmail));
    },
    async upsert(row) {
      await db
        .insert(userSettings)
        .values(row)
        .onConflictDoUpdate({
          target: [userSettings.ownerEmail, userSettings.key],
          set: {
            encryptedValue: row.encryptedValue,
            updatedAt: row.updatedAt,
          },
        });
    },
    async delete(ownerEmail, key) {
      await db
        .delete(userSettings)
        .where(eq(userSettings.ownerEmail, ownerEmail))
        .where(eq(userSettings.key, key));
    },
  };
}
```

If Drizzle does not allow chained `.where()` for deletes in this project version, replace the delete condition with `and(eq(...), eq(...))` after importing `and` from `drizzle-orm`.

- [ ] **Step 7: Update settings API routes**

Replace `src/app/api/settings/route.js`:

```js
import { NextResponse } from "next/server";
import { requireSettingsAccess, routeErrorResponse } from "../../../lib/auth/route-guards.js";
import {
  getMaskedUserSettings,
  updateUserSettings,
} from "../../../lib/settings/user-settings-store.js";

export async function GET() {
  try {
    const ownerEmail = await requireSettingsAccess();
    return NextResponse.json({ settings: await getMaskedUserSettings(ownerEmail) });
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}

export async function PUT(request) {
  try {
    const ownerEmail = await requireSettingsAccess();
    const body = await request.json();
    await updateUserSettings(ownerEmail, body);
    return NextResponse.json({ settings: await getMaskedUserSettings(ownerEmail) });
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
```

Modify export/import routes to call `requireSettingsAccess()` and `readUserSettings()` / `replaceUserSettings()` for the signed-in user instead of shared settings.

- [ ] **Step 8: Run settings tests**

Run: `npm.cmd test -- tests/settings-encryption.test.js tests/user-settings-store.test.js tests/settings-store.test.js`

Expected: PASS. Keep `tests/settings-store.test.js` passing because legacy JSON settings can remain temporarily for compatibility, but new routes must use `user-settings-store`.

- [ ] **Step 9: Commit per-user settings foundation**

```bash
git add src/lib/db/schema.js src/lib/settings/settings-encryption.js src/lib/settings/user-settings-store.js src/app/api/settings/route.js src/app/api/settings/export/route.js src/app/api/settings/import/route.js tests/settings-encryption.test.js tests/user-settings-store.test.js
git commit -m "feat: add per-user encrypted settings"
```

---

### Task 3: Post Repository, Scheduling Time, And Cancellation

**Files:**
- Create: `src/lib/posts/post-status.js`
- Create: `src/lib/posts/schedule-time.js`
- Create: `src/lib/posts/error-redaction.js`
- Create: `src/lib/posts/post-repository.js`
- Create: `src/lib/posts/post-service.js`
- Modify: `src/app/api/posts/route.js`
- Modify: `src/app/api/posts/[id]/route.js`
- Test: `tests/schedule-time.test.js`
- Test: `tests/post-service.test.js`

**Interfaces:**
- Consumes: `normalizeEmail(email)`.
- Produces: `computeScheduledFor({ scheduledDate, scheduledTime, now }): Date`
- Produces: `createScheduledPost({ ownerEmail, input, repository }): Promise<object>`
- Produces: `cancelScheduledPost({ ownerEmail, postId, repository }): Promise<object>`
- Produces: `listPosts({ ownerEmail, repository }): Promise<object[]>`
- Produces: `sanitizeProviderError(message, secrets?): string`

- [ ] **Step 1: Write schedule time tests**

Create `tests/schedule-time.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { computeScheduledFor } from "../src/lib/posts/schedule-time.js";

test("computes selected Taiwan 9 AM date as UTC", () => {
  const scheduled = computeScheduledFor({
    scheduledDate: "2026-07-11",
    scheduledTime: "09:00",
    now: new Date("2026-07-09T00:00:00.000Z"),
  });

  assert.equal(scheduled.toISOString(), "2026-07-11T01:00:00.000Z");
});

test("rejects past Taiwan 9 AM date", () => {
  assert.throws(
    () =>
      computeScheduledFor({
        scheduledDate: "2026-07-09",
        scheduledTime: "09:00",
        now: new Date("2026-07-09T02:00:00.000Z"),
      }),
    /past/,
  );
});

test("rejects unsupported schedule time", () => {
  assert.throws(
    () =>
      computeScheduledFor({
        scheduledDate: "2026-07-11",
        scheduledTime: "10:00",
        now: new Date("2026-07-09T00:00:00.000Z"),
      }),
    /Unsupported scheduled time/,
  );
});
```

- [ ] **Step 2: Implement schedule time helper**

Create `src/lib/posts/schedule-time.js`:

```js
const TAIWAN_UTC_OFFSET_HOURS = 8;

export function computeScheduledFor({ scheduledDate, scheduledTime, now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(scheduledDate ?? ""))) {
    throw new Error("scheduledDate must use YYYY-MM-DD format.");
  }
  if (scheduledTime !== "09:00") {
    throw new Error("Unsupported scheduled time.");
  }

  const scheduledUtc = new Date(`${scheduledDate}T01:00:00.000Z`);
  if (Number.isNaN(scheduledUtc.getTime())) {
    throw new Error("scheduledDate is invalid.");
  }
  if (scheduledUtc <= now) {
    throw new Error("Scheduled date and time is already in the past.");
  }

  return scheduledUtc;
}

export function getTaiwanTodayDate(now = new Date()) {
  const taiwanNow = new Date(now.getTime() + TAIWAN_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return taiwanNow.toISOString().slice(0, 10);
}
```

- [ ] **Step 3: Write post service tests with an in-memory repository**

Create `tests/post-service.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cancelScheduledPost,
  createScheduledPost,
  listPosts,
} from "../src/lib/posts/post-service.js";

function createMemoryRepository() {
  const posts = [];
  const targets = [];
  let nextPostId = 1;
  let nextTargetId = 1;

  return {
    posts,
    targets,
    async createPostWithTargets({ post, targetRows }) {
      const created = { ...post, id: nextPostId++ };
      posts.push(created);
      for (const target of targetRows) {
        targets.push({ ...target, id: nextTargetId++, postId: created.id });
      }
      return { ...created, targets: targets.filter((target) => target.postId === created.id) };
    },
    async listPostsByOwner(ownerEmail) {
      return posts
        .filter((post) => post.ownerEmail === ownerEmail)
        .map((post) => ({ ...post, targets: targets.filter((target) => target.postId === post.id) }));
    },
    async cancelScheduledPost(ownerEmail, postId, now) {
      const post = posts.find((item) => item.ownerEmail === ownerEmail && item.id === postId);
      if (!post || post.status !== "scheduled") return null;
      post.status = "cancelled";
      post.updatedAt = now;
      for (const target of targets.filter((item) => item.postId === postId)) {
        target.status = "cancelled";
        target.updatedAt = now;
      }
      return { ...post, targets: targets.filter((target) => target.postId === post.id) };
    },
    async findPostByOwner(ownerEmail, postId) {
      const post = posts.find((item) => item.ownerEmail === ownerEmail && item.id === postId);
      return post ? { ...post, targets: targets.filter((target) => target.postId === post.id) } : null;
    },
  };
}

const input = {
  productName: "Demo Product",
  productFeatures: "Fast setup",
  imageUrl: "https://blob.example/image.jpg",
  targets: [
    { platform: "meta", content: "Meta text", hashtags: ["demo"] },
    { platform: "line", content: "LINE text", hashtags: [] },
  ],
  scheduledDate: "2026-07-11",
  scheduledTime: "09:00",
};

test("creates scheduled posts scoped by normalized owner email", async () => {
  const repository = createMemoryRepository();
  const post = await createScheduledPost({
    ownerEmail: " Owner@Example.com ",
    input,
    repository,
    now: new Date("2026-07-09T00:00:00.000Z"),
  });

  assert.equal(post.ownerEmail, "owner@example.com");
  assert.equal(post.status, "scheduled");
  assert.equal(post.scheduledFor.toISOString(), "2026-07-11T01:00:00.000Z");
  assert.deepEqual(post.targets.map((target) => target.status), ["scheduled", "scheduled"]);
});

test("lists only owner scoped posts", async () => {
  const repository = createMemoryRepository();
  await createScheduledPost({ ownerEmail: "owner@example.com", input, repository, now: new Date("2026-07-09T00:00:00.000Z") });
  await createScheduledPost({ ownerEmail: "other@example.com", input, repository, now: new Date("2026-07-09T00:00:00.000Z") });

  const posts = await listPosts({ ownerEmail: "OWNER@example.com", repository });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].ownerEmail, "owner@example.com");
});

test("cancels only scheduled posts", async () => {
  const repository = createMemoryRepository();
  const post = await createScheduledPost({ ownerEmail: "owner@example.com", input, repository, now: new Date("2026-07-09T00:00:00.000Z") });

  const cancelled = await cancelScheduledPost({
    ownerEmail: "owner@example.com",
    postId: post.id,
    repository,
    now: new Date("2026-07-09T00:10:00.000Z"),
  });

  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.targets.map((target) => target.status), ["cancelled", "cancelled"]);
});
```

- [ ] **Step 4: Add status constants and redaction helper**

Create `src/lib/posts/post-status.js`:

```js
export const POST_STATUS = Object.freeze({
  DRAFT: "draft",
  SCHEDULED: "scheduled",
  PUBLISHING: "publishing",
  PUBLISHED: "published",
  PARTIAL_FAILED: "partial_failed",
  FAILED: "failed",
  PUBLISH_UNKNOWN: "publish_unknown",
  CANCELLED: "cancelled",
});

export function computeParentStatus(targets) {
  const activeTargets = targets.filter((target) => target.status !== POST_STATUS.CANCELLED);
  if (activeTargets.length === 0) return POST_STATUS.CANCELLED;
  if (activeTargets.every((target) => target.status === POST_STATUS.PUBLISHED)) return POST_STATUS.PUBLISHED;
  if (activeTargets.some((target) => target.status === POST_STATUS.PUBLISHED)) return POST_STATUS.PARTIAL_FAILED;
  if (activeTargets.some((target) => target.status === POST_STATUS.PUBLISH_UNKNOWN)) return POST_STATUS.PUBLISH_UNKNOWN;
  return POST_STATUS.FAILED;
}
```

Create `src/lib/posts/error-redaction.js`:

```js
export function sanitizeProviderError(message, secrets = []) {
  let text = String(message ?? "Provider request failed.");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  text = text.replace(/access_token=([^&\s]+)/gi, "access_token=[redacted]");
  text = text.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[redacted]"');
  text = text.replace(/"Authorization"\s*:\s*"[^"]+"/gi, '"Authorization":"[redacted]"');

  for (const secret of secrets.filter(Boolean).map(String)) {
    text = text.split(secret).join("[redacted]");
  }

  return text;
}
```

- [ ] **Step 5: Implement post service**

Create `src/lib/posts/post-service.js`:

```js
import { normalizeEmail } from "../auth/policy.js";
import { computeScheduledFor } from "./schedule-time.js";
import { POST_STATUS } from "./post-status.js";
import { createPostRepository } from "./post-repository.js";

export async function createScheduledPost({ ownerEmail, input, repository = createPostRepository(), now = new Date() }) {
  const owner = normalizeEmail(ownerEmail);
  const scheduledFor = computeScheduledFor({
    scheduledDate: input.scheduledDate,
    scheduledTime: input.scheduledTime,
    now,
  });

  return repository.createPostWithTargets({
    post: buildPostRow({ ownerEmail: owner, input, status: POST_STATUS.SCHEDULED, scheduledFor, now }),
    targetRows: buildTargetRows({ targets: input.targets, status: POST_STATUS.SCHEDULED, now }),
  });
}

export async function listPosts({ ownerEmail, repository = createPostRepository() }) {
  return repository.listPostsByOwner(normalizeEmail(ownerEmail));
}

export async function cancelScheduledPost({ ownerEmail, postId, repository = createPostRepository(), now = new Date() }) {
  const owner = normalizeEmail(ownerEmail);
  const cancelled = await repository.cancelScheduledPost(owner, Number(postId), now);
  if (cancelled) return cancelled;

  const current = await repository.findPostByOwner(owner, Number(postId));
  const error = new Error(`Post cannot be cancelled from status ${current?.status ?? "missing"}.`);
  error.status = current ? 409 : 404;
  throw error;
}

function buildPostRow({ ownerEmail, input, status, scheduledFor = null, now }) {
  return {
    ownerEmail,
    productName: input.productName,
    productFeatures: input.productFeatures,
    imagePrompt: input.imagePrompt ?? null,
    imageImgurUrl: input.imageUrl ?? null,
    status,
    scheduledFor,
    publishingStartedAt: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildTargetRows({ targets = [], status, now }) {
  return targets.map((target) => ({
    platform: target.platform,
    content: target.content,
    hashtagsJson: JSON.stringify(target.hashtags ?? []),
    status,
    externalPostId: null,
    errorMessage: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
}
```

- [ ] **Step 6: Implement Drizzle repository**

Create `src/lib/posts/post-repository.js` with methods matching the test adapter. Use `eq`, `and`, `desc`, `lte`, and `inArray` from `drizzle-orm`.

Key implementation shape:

```js
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { createDbClient } from "../db/index.js";
import { posts, postTargets } from "../db/schema.js";
import { POST_STATUS } from "./post-status.js";

export function createPostRepository(db = createDbClient()) {
  return {
    async createPostWithTargets({ post, targetRows }) {
      const [createdPost] = await db.insert(posts).values(post).returning();
      const createdTargets = targetRows.length
        ? await db
            .insert(postTargets)
            .values(targetRows.map((target) => ({ ...target, postId: createdPost.id })))
            .returning()
        : [];
      return { ...createdPost, targets: createdTargets };
    },

    async listPostsByOwner(ownerEmail) {
      const ownerPosts = await db
        .select()
        .from(posts)
        .where(eq(posts.ownerEmail, ownerEmail))
        .orderBy(desc(posts.createdAt));
      return attachTargets(db, ownerPosts);
    },

    async findPostByOwner(ownerEmail, postId) {
      const [post] = await db
        .select()
        .from(posts)
        .where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId)));
      if (!post) return null;
      const [withTargets] = await attachTargets(db, [post]);
      return withTargets;
    },

    async cancelScheduledPost(ownerEmail, postId, now) {
      const [updated] = await db
        .update(posts)
        .set({ status: POST_STATUS.CANCELLED, updatedAt: now })
        .where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId), eq(posts.status, POST_STATUS.SCHEDULED)))
        .returning();
      if (!updated) return null;

      await db
        .update(postTargets)
        .set({ status: POST_STATUS.CANCELLED, updatedAt: now })
        .where(eq(postTargets.postId, postId));
      return this.findPostByOwner(ownerEmail, postId);
    },
  };
}

async function attachTargets(db, postRows) {
  if (postRows.length === 0) return [];
  const ids = postRows.map((post) => post.id);
  const targets = await db.select().from(postTargets).where(inArray(postTargets.postId, ids));
  return postRows.map((post) => ({
    ...post,
    targets: targets.filter((target) => target.postId === post.id),
  }));
}
```

- [ ] **Step 7: Replace posts routes**

Modify `src/app/api/posts/route.js`:

```js
import { NextResponse } from "next/server";
import { requireAppUser, requirePublisher, routeErrorResponse } from "../../../lib/auth/route-guards.js";
import {
  createScheduledPost,
  listPosts,
} from "../../../lib/posts/post-service.js";

export async function GET() {
  try {
    const ownerEmail = await requireAppUser();
    return NextResponse.json({ posts: await listPosts({ ownerEmail }) });
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}

export async function POST(request) {
  try {
    const ownerEmail = await requirePublisher();
    const body = await request.json();

    if (body.mode !== "scheduled") {
      throw Object.assign(new Error("Publish-now mode is added in the publish-runner task."), { status: 400 });
    }

    const post = await createScheduledPost({ ownerEmail, input: body });
    return NextResponse.json({ post }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
```

This temporary `mode=now` rejection is removed in Task 4 after `createAndPublishPost()` exists.

Modify `src/app/api/posts/[id]/route.js`:

```js
import { NextResponse } from "next/server";
import { requirePublisher, routeErrorResponse } from "../../../../lib/auth/route-guards.js";
import { cancelScheduledPost } from "../../../../lib/posts/post-service.js";

export async function DELETE(_request, { params }) {
  try {
    const ownerEmail = await requirePublisher();
    const { id } = await params;
    const post = await cancelScheduledPost({ ownerEmail, postId: id });
    return NextResponse.json({ post });
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
```

- [ ] **Step 8: Run post scheduling tests**

Run: `npm.cmd test -- tests/schedule-time.test.js tests/post-service.test.js`

Expected: PASS.

- [ ] **Step 9: Commit post scheduling foundation**

```bash
git add src/lib/posts/post-status.js src/lib/posts/schedule-time.js src/lib/posts/error-redaction.js src/lib/posts/post-repository.js src/lib/posts/post-service.js src/app/api/posts/route.js src/app/api/posts/[id]/route.js tests/schedule-time.test.js tests/post-service.test.js
git commit -m "feat: add scheduled post persistence"
```

---

### Task 4: Publish Runner And Generate Route Per-User Settings

**Files:**
- Modify: `src/lib/posts/post-repository.js`
- Modify: `src/lib/posts/post-service.js`
- Create: `src/lib/posts/publish-runner.js`
- Modify: `src/app/api/posts/route.js`
- Modify: `src/app/api/posts/[id]/publish/route.js`
- Modify: `src/app/api/generate/route.js`
- Test: `tests/publish-runner.test.js`
- Test: `tests/generate-route-auth.test.js`

**Interfaces:**
- Consumes: `readUserSettings(ownerEmail)`.
- Consumes: `buildPlatformPreviews({ imageUrl, targets })`.
- Produces: `publishStoredPost({ post, repository, settingsReader, publishTargetsImpl, now }): Promise<object>`
- Produces: `createAndPublishPost({ ownerEmail, input, repository }): Promise<object>`
- Produces: `publishExistingPost({ ownerEmail, postId, repository }): Promise<object>`

- [ ] **Step 1: Write publish runner tests**

Create `tests/publish-runner.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { publishStoredPost } from "../src/lib/posts/publish-runner.js";

function createRepository(post) {
  return {
    saved: [],
    async persistTargetResult(postId, platform, result, now) {
      this.saved.push({ postId, platform, result, now });
    },
    async markPostFinished(postId, status, now) {
      this.finished = { postId, status, now };
    },
  };
}

test("uses owner settings and skips already published targets", async () => {
  const post = {
    id: 10,
    ownerEmail: "owner@example.com",
    imageImgurUrl: "https://blob.example/image.jpg",
    targets: [
      { platform: "meta", content: "Meta", hashtagsJson: "[]", status: "published", externalPostId: "meta-id" },
      { platform: "line", content: "Line", hashtagsJson: "[]", status: "publishing", externalPostId: null },
    ],
  };
  const repository = createRepository(post);
  const calls = [];

  const result = await publishStoredPost({
    post,
    repository,
    settingsReader: async (ownerEmail) => {
      assert.equal(ownerEmail, "owner@example.com");
      return { lineChannelAccessToken: "line-token" };
    },
    publishTargetsImpl: async ({ targets, settings }) => {
      calls.push({ targets, settings });
      return [{ platform: "line", status: "published", externalId: "line-id" }];
    },
    now: new Date("2026-07-09T00:00:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].targets.map((target) => target.platform), ["line"]);
  assert.equal(repository.saved[0].result.externalId, "line-id");
  assert.equal(result.status, "published");
});
```

- [ ] **Step 2: Implement publish runner**

Create `src/lib/posts/publish-runner.js`:

```js
import { buildPlatformPreviews } from "../platform-preview/build-platform-previews.js";
import { publishTargets } from "../platforms/publish-service.js";
import { readUserSettings } from "../settings/user-settings-store.js";
import { sanitizeProviderError } from "./error-redaction.js";
import { computeParentStatus, POST_STATUS } from "./post-status.js";

export async function publishStoredPost({
  post,
  repository,
  settingsReader = readUserSettings,
  publishTargetsImpl = publishTargets,
  now = new Date(),
}) {
  const settings = await settingsReader(post.ownerEmail);
  const publishableTargets = post.targets.filter(
    (target) => target.status !== POST_STATUS.PUBLISHED && !target.externalPostId,
  );

  if (publishableTargets.length > 0) {
    const targets = publishableTargets.map((target) => ({
      platform: target.platform,
      content: target.content,
      hashtags: JSON.parse(target.hashtagsJson || "[]"),
    }));
    const previews = buildPlatformPreviews({ imageUrl: post.imageImgurUrl ?? null, targets });
    const publishInput = Object.values(previews).map((preview) => ({
      platform: preview.platform,
      publishPayload: preview.publishPayload,
    }));
    const results = await publishTargetsImpl({ targets: publishInput, settings });

    for (const result of results) {
      await repository.persistTargetResult(post.id, result.platform, normalizePublishResult(result, settings), now);
    }
  }

  const refreshed = await repository.findPostById(post.id);
  const status = computeParentStatus(refreshed.targets);
  await repository.markPostFinished(post.id, status, now);
  return { ...refreshed, status };
}

function normalizePublishResult(result, settings) {
  if (result.status === "published") {
    return {
      status: POST_STATUS.PUBLISHED,
      externalPostId: result.externalId ?? null,
      errorMessage: null,
    };
  }

  return {
    status: POST_STATUS.FAILED,
    externalPostId: null,
    errorMessage: sanitizeProviderError(result.error, Object.values(settings)),
  };
}
```

- [ ] **Step 3: Extend repository for publish claims and results**

Add these methods to `createPostRepository()`:

```js
async findPostById(postId) {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId));
  if (!post) return null;
  const [withTargets] = await attachTargets(db, [post]);
  return withTargets;
},

async claimManualPost(ownerEmail, postId, now) {
  const [updated] = await db
    .update(posts)
    .set({ status: POST_STATUS.PUBLISHING, publishingStartedAt: now, updatedAt: now })
    .where(and(eq(posts.ownerEmail, ownerEmail), eq(posts.id, postId), inArray(posts.status, [POST_STATUS.DRAFT, POST_STATUS.FAILED])))
    .returning();
  if (!updated) return null;
  await db
    .update(postTargets)
    .set({ status: POST_STATUS.PUBLISHING, updatedAt: now })
    .where(and(eq(postTargets.postId, postId), inArray(postTargets.status, [POST_STATUS.DRAFT, POST_STATUS.FAILED])));
  return this.findPostByOwner(ownerEmail, postId);
},

async persistTargetResult(postId, platform, result, now) {
  await db
    .update(postTargets)
    .set({
      status: result.status,
      externalPostId: result.externalPostId,
      errorMessage: result.errorMessage,
      publishedAt: result.status === POST_STATUS.PUBLISHED ? now : null,
      updatedAt: now,
    })
    .where(and(eq(postTargets.postId, postId), eq(postTargets.platform, platform)));
},

async markPostFinished(postId, status, now) {
  await db
    .update(posts)
    .set({
      status,
      publishedAt: status === POST_STATUS.PUBLISHED ? now : null,
      updatedAt: now,
    })
    .where(eq(posts.id, postId));
},
```

- [ ] **Step 4: Add publish use cases to post service**

Add to `src/lib/posts/post-service.js`:

```js
import { publishStoredPost } from "./publish-runner.js";

export async function createAndPublishPost({ ownerEmail, input, repository = createPostRepository(), now = new Date() }) {
  const owner = normalizeEmail(ownerEmail);
  const created = await repository.createPostWithTargets({
    post: buildPostRow({ ownerEmail: owner, input, status: POST_STATUS.DRAFT, now }),
    targetRows: buildTargetRows({ targets: input.targets, status: POST_STATUS.DRAFT, now }),
  });

  const claimed = await repository.claimManualPost(owner, created.id, now);
  if (!claimed) {
    const error = new Error("Post could not be claimed for publishing.");
    error.status = 409;
    throw error;
  }

  return publishStoredPost({ post: claimed, repository, now });
}

export async function publishExistingPost({ ownerEmail, postId, repository = createPostRepository(), now = new Date() }) {
  const owner = normalizeEmail(ownerEmail);
  const claimed = await repository.claimManualPost(owner, Number(postId), now);
  if (!claimed) {
    const current = await repository.findPostByOwner(owner, Number(postId));
    const error = new Error(`Post cannot be published from status ${current?.status ?? "missing"}.`);
    error.status = current ? 409 : 404;
    throw error;
  }

  return publishStoredPost({ post: claimed, repository, now });
}
```

- [ ] **Step 5: Wire publish routes**

Modify `src/app/api/posts/route.js` POST:

```js
import {
  createAndPublishPost,
  createScheduledPost,
  listPosts,
} from "../../../lib/posts/post-service.js";

// inside POST
const post =
  body.mode === "scheduled"
    ? await createScheduledPost({ ownerEmail, input: body })
    : await createAndPublishPost({ ownerEmail, input: body });
return NextResponse.json({ post }, { status: 201 });
```

Replace `src/app/api/posts/[id]/publish/route.js`:

```js
import { NextResponse } from "next/server";
import { requirePublisher, routeErrorResponse } from "../../../../../lib/auth/route-guards.js";
import { publishExistingPost } from "../../../../../lib/posts/post-service.js";

export async function POST(_request, { params }) {
  try {
    const ownerEmail = await requirePublisher();
    const { id } = await params;
    const post = await publishExistingPost({ ownerEmail, postId: id });
    return NextResponse.json({ post });
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
```

- [ ] **Step 6: Wire generate route to per-user settings**

Modify `src/app/api/generate/route.js`:

```js
import { NextResponse } from "next/server";
import { requireAppUser, routeErrorResponse } from "../../../lib/auth/route-guards.js";
import { buildGeneratedResponse } from "../../../lib/ai/generated-response.js";
import { readUserSettings } from "../../../lib/settings/user-settings-store.js";

export async function POST(request) {
  try {
    const ownerEmail = await requireAppUser();
    const body = await request.json();
    const settings = await readUserSettings(ownerEmail);
    return NextResponse.json(await buildGeneratedResponse({ body, settings }));
  } catch (error) {
    return routeErrorResponse(error, NextResponse);
  }
}
```

- [ ] **Step 7: Run publish/generate tests**

Run: `npm.cmd test -- tests/publish-runner.test.js tests/generate-route-auth.test.js tests/publish-service.test.js tests/generated-response-image-failure.test.js`

Expected: PASS. If `tests/generate-route-auth.test.js` is difficult to route-test without Next internals, make it a small unit test around an extracted helper `generateForUser({ ownerEmail, body, settingsReader, buildGeneratedResponseImpl })`.

- [ ] **Step 8: Commit publish runner and generate settings integration**

```bash
git add src/lib/posts/post-repository.js src/lib/posts/post-service.js src/lib/posts/publish-runner.js src/app/api/posts/route.js src/app/api/posts/[id]/publish/route.js src/app/api/generate/route.js tests/publish-runner.test.js tests/generate-route-auth.test.js
git commit -m "feat: publish posts with per-user settings"
```

---

### Task 5: Scheduler And Cron Trigger

**Files:**
- Modify: `src/lib/posts/post-repository.js`
- Create: `src/lib/scheduler/run-due-post-scheduler.js`
- Modify: `src/app/api/cron/route.js`
- Modify: `vercel.json`
- Modify: `.env.example`
- Test: `tests/scheduler.test.js`
- Test: `tests/cron-route.test.js`

**Interfaces:**
- Produces: `runDuePostScheduler({ repository, publishStoredPostImpl, now }): Promise<object>`
- Produces: `isValidCronAuthorization(request, env): boolean`
- Consumes: `publishStoredPost()`.

- [ ] **Step 1: Write scheduler tests**

Create `tests/scheduler.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { runDuePostScheduler } from "../src/lib/scheduler/run-due-post-scheduler.js";

test("claims and publishes only due scheduled posts", async () => {
  const duePost = { id: 1, status: "scheduled", scheduledFor: new Date("2026-07-09T01:00:00.000Z"), targets: [] };
  const futurePost = { id: 2, status: "scheduled", scheduledFor: new Date("2026-07-10T01:00:00.000Z"), targets: [] };
  const calls = [];
  const repository = {
    async findDueScheduledPosts(now) {
      assert.equal(now.toISOString(), "2026-07-09T02:00:00.000Z");
      return [duePost, futurePost].filter((post) => post.scheduledFor <= now);
    },
    async claimScheduledPost(postId, now) {
      calls.push({ postId, now });
      return postId === 1 ? { ...duePost, status: "publishing" } : null;
    },
  };

  const summary = await runDuePostScheduler({
    repository,
    publishStoredPostImpl: async ({ post }) => ({ ...post, status: "published" }),
    now: new Date("2026-07-09T02:00:00.000Z"),
  });

  assert.deepEqual(summary, { checked: 1, claimed: 1, published: 1, failed: 0, skipped: 0 });
  assert.deepEqual(calls.map((call) => call.postId), [1]);
});

test("skips posts that fail atomic claim", async () => {
  const repository = {
    async findDueScheduledPosts() {
      return [{ id: 1, status: "scheduled", targets: [] }];
    },
    async claimScheduledPost() {
      return null;
    },
  };

  const summary = await runDuePostScheduler({
    repository,
    publishStoredPostImpl: async () => {
      throw new Error("publish should not run");
    },
  });

  assert.equal(summary.skipped, 1);
  assert.equal(summary.published, 0);
});
```

- [ ] **Step 2: Implement scheduler runner**

Create `src/lib/scheduler/run-due-post-scheduler.js`:

```js
import { createPostRepository } from "../posts/post-repository.js";
import { publishStoredPost } from "../posts/publish-runner.js";

export async function runDuePostScheduler({
  repository = createPostRepository(),
  publishStoredPostImpl = publishStoredPost,
  now = new Date(),
} = {}) {
  const duePosts = await repository.findDueScheduledPosts(now);
  const summary = { checked: duePosts.length, claimed: 0, published: 0, failed: 0, skipped: 0 };

  for (const post of duePosts) {
    const claimed = await repository.claimScheduledPost(post.id, now);
    if (!claimed) {
      summary.skipped += 1;
      continue;
    }

    summary.claimed += 1;
    try {
      const result = await publishStoredPostImpl({ post: claimed, repository, now });
      if (result.status === "published") summary.published += 1;
      else summary.failed += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}
```

- [ ] **Step 3: Add repository scheduler methods**

Add to `createPostRepository()`:

```js
async findDueScheduledPosts(now) {
  const duePosts = await db
    .select()
    .from(posts)
    .where(and(eq(posts.status, POST_STATUS.SCHEDULED), lte(posts.scheduledFor, now)));
  return attachTargets(db, duePosts);
},

async claimScheduledPost(postId, now) {
  const [updated] = await db
    .update(posts)
    .set({ status: POST_STATUS.PUBLISHING, publishingStartedAt: now, updatedAt: now })
    .where(and(eq(posts.id, postId), eq(posts.status, POST_STATUS.SCHEDULED)))
    .returning();
  if (!updated) return null;
  await db
    .update(postTargets)
    .set({ status: POST_STATUS.PUBLISHING, updatedAt: now })
    .where(and(eq(postTargets.postId, postId), eq(postTargets.status, POST_STATUS.SCHEDULED)));
  return this.findPostById(postId);
},
```

- [ ] **Step 4: Write cron auth tests**

Create `tests/cron-route.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { isValidCronAuthorization } from "../src/app/api/cron/route.js";

function requestWithAuthorization(value) {
  return { headers: new Map(value ? [["authorization", value]] : []) };
}

test("cron authorization requires bearer secret", () => {
  const env = { CRON_SECRET: "cron-secret" };

  assert.equal(isValidCronAuthorization(requestWithAuthorization("Bearer cron-secret"), env), true);
  assert.equal(isValidCronAuthorization(requestWithAuthorization("Bearer wrong"), env), false);
  assert.equal(isValidCronAuthorization(requestWithAuthorization(null), env), false);
});
```

- [ ] **Step 5: Implement cron route**

Replace `src/app/api/cron/route.js`:

```js
import { NextResponse } from "next/server";
import { runDuePostScheduler } from "../../../lib/scheduler/run-due-post-scheduler.js";

export async function GET(request) {
  if (!isValidCronAuthorization(request)) {
    return NextResponse.json({ error: "Invalid cron secret." }, { status: 401 });
  }

  const summary = await runDuePostScheduler();
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    ...summary,
  });
}

export function isValidCronAuthorization(request, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}
```

- [ ] **Step 6: Update deployment configuration**

Modify `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "0 1 * * *"
    }
  ]
}
```

Modify `.env.example` to include:

```env
AUTH_MODE=demo
MIGRATION_OWNER_EMAIL=
CRON_SECRET=replace-with-random-secret
SETTINGS_ENCRYPTION_KEY=replace-with-32-byte-base64-key
```

- [ ] **Step 7: Run scheduler tests**

Run: `npm.cmd test -- tests/scheduler.test.js tests/cron-route.test.js`

Expected: PASS.

- [ ] **Step 8: Commit scheduler**

```bash
git add src/lib/posts/post-repository.js src/lib/scheduler/run-due-post-scheduler.js src/app/api/cron/route.js vercel.json .env.example tests/scheduler.test.js tests/cron-route.test.js
git commit -m "feat: run due scheduled posts from cron"
```

---

### Task 6: UI Integration For Scheduling, History, Settings, And Auth

**Files:**
- Modify: `src/components/CreatePostWizard.js`
- Modify: `src/lib/wizard/wizard-flow.js`
- Modify: `src/app/history/page.js`
- Modify: `src/components/SettingsPanel.js`
- Modify: `src/components/AppShellFrame.js`
- Modify: `src/app/login/page.js`
- Test: `tests/wizard-flow.test.js`

**Interfaces:**
- Consumes: `POST /api/posts` with `mode=now | scheduled`.
- Consumes: `GET /api/posts`.
- Consumes: `DELETE /api/posts/[id]`.
- Produces: wizard state fields `mode`, `scheduledDate`, `scheduledTime`.

- [ ] **Step 1: Expand wizard flow tests**

Modify `tests/wizard-flow.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  getInitialPostForm,
  getScheduleDateConstraints,
  shouldGenerateOnPreviewAdvance,
} from "../src/lib/wizard/wizard-flow.js";

test("starts in publish-now mode with only 9 AM schedule time", () => {
  const form = getInitialPostForm();

  assert.equal(form.mode, "now");
  assert.equal(form.scheduledTime, "09:00");
});

test("disables dates whose Taiwan 9 AM has passed", () => {
  const constraints = getScheduleDateConstraints(new Date("2026-07-09T02:00:00.000Z"));

  assert.equal(constraints.minDate, "2026-07-10");
});
```

- [ ] **Step 2: Add wizard scheduling helpers**

Modify `src/lib/wizard/wizard-flow.js`:

```js
export function getInitialPostForm() {
  return {
    productName: "",
    productFeatures: "",
    audience: "general",
    tone: "friendly",
    platforms: ["meta", "line"],
    llmProvider: "google",
    imageProvider: "google",
    mode: "now",
    scheduledDate: getDefaultScheduleDate(),
    scheduledTime: "09:00",
  };
}

export function getScheduleDateConstraints(now = new Date()) {
  const todayTaiwanAtNineUtc = getTaiwanNineUtc(getTaiwanDate(now));
  const minDate =
    todayTaiwanAtNineUtc > now ? getTaiwanDate(now) : getTaiwanDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  return { minDate };
}

function getDefaultScheduleDate(now = new Date()) {
  return getScheduleDateConstraints(now).minDate;
}

function getTaiwanDate(now) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getTaiwanNineUtc(date) {
  return new Date(`${date}T01:00:00.000Z`);
}
```

Keep the existing `WIZARD_STEPS` and `shouldGenerateOnPreviewAdvance()` exports.

- [ ] **Step 3: Update wizard submit behavior**

In `src/components/CreatePostWizard.js`, replace `publishNow()` with `submitPost()`:

```js
async function submitPost({ form, targets, imageUrl, setPublishStatus, setPublishResult }) {
  setPublishStatus("loading");
  setPublishResult(null);

  try {
    const response = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        targets,
        imageUrl,
      }),
    });
    const data = await response.json();

    setPublishResult(data);
    setPublishStatus(response.ok ? "done" : "error");
  } catch (error) {
    setPublishResult({
      error: error.message,
      results: [{ platform: "system", status: "failed", error: error.message }],
    });
    setPublishStatus("error");
  }
}
```

Add controls in the final step:

```jsx
<SegmentedControl
  value={form.mode}
  onChange={(mode) => setForm((current) => ({ ...current, mode }))}
  data={[
    { label: "Publish now", value: "now" },
    { label: "Schedule", value: "scheduled" },
  ]}
/>
{form.mode === "scheduled" ? (
  <Group align="end">
    <TextInput
      type="date"
      label="Schedule date"
      value={form.scheduledDate}
      min={getScheduleDateConstraints().minDate}
      onChange={(event) => setForm((current) => ({ ...current, scheduledDate: event.currentTarget.value }))}
    />
    <Select
      label="Schedule time"
      value={form.scheduledTime}
      onChange={(scheduledTime) => setForm((current) => ({ ...current, scheduledTime }))}
      data={[{ value: "09:00", label: "9:00 AM" }]}
    />
  </Group>
) : null}
```

Change the button label and handler:

```jsx
<Button
  leftSection={<IconSend size={16} />}
  loading={publishStatus === "loading"}
  disabled={generationStatus === "loading"}
  onClick={() =>
    submitPost({ form, targets, imageUrl, setPublishStatus, setPublishResult })
  }
>
  {form.mode === "scheduled" ? "Schedule" : "Publish now"}
</Button>
```

- [ ] **Step 4: Replace history hardcoded rows**

Modify `src/app/history/page.js` to fetch `/api/posts` client-side and render cancel buttons for `scheduled` rows. Keep the UI simple:

```js
const [posts, setPosts] = useState([]);
const [status, setStatus] = useState("loading");

async function loadPosts() {
  setStatus("loading");
  const response = await fetch("/api/posts");
  const data = await response.json();
  setPosts(data.posts ?? []);
  setStatus(response.ok ? "loaded" : "error");
}

async function cancelPost(id) {
  await fetch(`/api/posts/${id}`, { method: "DELETE" });
  await loadPosts();
}
```

In the table, render one row per parent post with platforms joined from `post.targets`.

- [ ] **Step 5: Update auth UI**

Modify `src/app/login/page.js` to use NextAuth client helpers:

```js
import { signIn } from "next-auth/react";

<Button leftSection={<IconBrandGoogle size={18} />} onClick={() => signIn("google", { callbackUrl: "/" })}>
  Sign in with Google
</Button>
```

Modify `src/components/AppShellFrame.js`:

```js
import { signOut, useSession } from "next-auth/react";

const { data: session } = useSession();
const email = session?.user?.email ?? "";

<Avatar color="orange" radius="xl">
  {email ? email[0].toUpperCase() : "A"}
</Avatar>
<UnstyledButton onClick={() => signOut({ callbackUrl: "/login" })} title="Sign out">
  <IconLogout size={20} />
</UnstyledButton>
```

If `useSession()` errors because no SessionProvider exists, add a small client `Providers` component around the root layout in a separate patch within this task.

- [ ] **Step 6: Keep settings UI compatible with clear semantics**

Modify `src/components/SettingsPanel.js` so empty fields are not sent as values. Add optional clear buttons only if the existing UI has room; otherwise leave clear behavior for a later small UI pass and keep backend support in place.

Keep save payload construction:

```js
const payload = Object.fromEntries(
  keys
    .map((key) => [key, values[key]])
    .filter(([, value]) => value && value.trim() && !value.includes("...")),
);
```

- [ ] **Step 7: Run UI logic tests**

Run: `npm.cmd test -- tests/wizard-flow.test.js`

Expected: PASS.

- [ ] **Step 8: Run build**

Run: `npm.cmd run build`

Expected: PASS. Existing Turbopack warning about dynamic settings import may remain until the import/export routes are fully cleaned up; do not ignore new compile errors.

- [ ] **Step 9: Commit UI integration**

```bash
git add src/components/CreatePostWizard.js src/lib/wizard/wizard-flow.js src/app/history/page.js src/components/SettingsPanel.js src/components/AppShellFrame.js src/app/login/page.js tests/wizard-flow.test.js
git commit -m "feat: connect scheduling and history UI"
```

---

### Task 7: Final Verification And Review

**Files:**
- Modify only if verification finds a bug in files touched by Tasks 1-6.
- Test: existing `tests/*.test.js`

**Interfaces:**
- Consumes all interfaces from Tasks 1-6.
- Produces a verified implementation branch ready for PR or handoff.

- [ ] **Step 1: Run full automated tests**

Run: `npm.cmd test`

Expected: all tests pass.

- [ ] **Step 2: Run production build**

Run: `npm.cmd run build`

Expected: build passes.

- [ ] **Step 3: Verify no live publish side effects happened**

Inspect the test logs and command history. Confirm only mocked/fake provider calls were used. Do not call Meta or LINE live endpoints.

- [ ] **Step 4: Inspect git diff**

Run: `git status --short`

Expected: only intended implementation files are modified. Existing unrelated user changes from before implementation should not be reverted.

- [ ] **Step 5: Request code review**

Use `requesting-code-review` with:

```text
DESCRIPTION: Implemented per-user encrypted settings, DB-backed scheduled posts/history/cancel, publish runner, scheduler cron, generate route per-user settings, and UI integration.
PLAN_OR_REQUIREMENTS: docs/superpowers/plans/2026-07-09-scheduled-posts-auth-db.md and docs/superpowers/specs/2026-07-09-scheduled-posts-auth-db-design.md.
BASE_SHA: 601977c
HEAD_SHA: output of git rev-parse HEAD
```

- [ ] **Step 6: Fix review findings**

Fix Critical and Important findings before completion. For Minor findings, either fix them or record why they are deferred.

- [ ] **Step 7: Final commit**

```bash
git add src tests vercel.json .env.example
git commit -m "feat: complete scheduled posts flow"
```

If earlier task commits already contain all changes and the worktree is clean, skip this final commit.

---

## Plan Self-Review Notes

- Spec coverage: auth, per-user settings, generation, posts, cancellation, publish runner, scheduler, cron auth, UI, no-live-publish verification, and deployment config are covered.
- Scope split: the plan follows the spec milestone sequence and keeps each task reviewable.
- Type consistency: `ownerEmail`, `scheduledFor`, `publishingStartedAt`, `externalPostId`, and `hashtagsJson` match the existing Drizzle camelCase field style.
- Residual risk: Drizzle/libSQL transaction support is not currently used in snippets. If implementation reveals multi-statement atomicity gaps, prefer a single conditional `UPDATE ... RETURNING` claim before provider calls and keep target status updates immediately after claim.

