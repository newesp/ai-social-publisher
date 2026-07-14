import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const posts = sqliteTable("posts", {
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
}, (table) => [
  index("posts_owner_created_at_idx").on(table.ownerEmail, table.createdAt),
  index("posts_status_scheduled_for_idx").on(table.status, table.scheduledFor),
]);

export const platformConnections = sqliteTable("platform_connections", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  platform: text("platform").notNull(),
  displayName: text("display_name").notNull(),
  state: text("state").notNull(),
  encryptedCredentials: text("encrypted_credentials").notNull(),
  credentialExpiresAt: integer("credential_expires_at", { mode: "timestamp" }),
  renewalLeaseId: text("renewal_lease_id"),
  renewalLeaseExpiresAt: integer("renewal_lease_expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("platform_connections_owner_platform_state_idx").on(table.ownerEmail, table.platform, table.state),
  uniqueIndex("platform_connections_one_active_owner_platform_idx")
    .on(table.ownerEmail, table.platform)
    .where(sql`${table.state} = 'active'`),
]);

export const oauthTransactions = sqliteTable("oauth_transactions", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  provider: text("provider").notNull(),
  encryptedPayload: text("encrypted_payload").notNull(),
  returnPath: text("return_path").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("oauth_transactions_expires_at_idx").on(table.expiresAt),
]);

export const postTargets = sqliteTable("post_targets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id")
    .notNull()
    .references(() => posts.id),
  platform: text("platform").notNull(),
  platformConnectionId: text("platform_connection_id").references(() => platformConnections.id),
  content: text("content").notNull(),
  hashtagsJson: text("hashtags_json").notNull().default("[]"),
  status: text("status").notNull().default("draft"),
  externalPostId: text("external_post_id"),
  errorMessage: text("error_message"),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const userSettings = sqliteTable("user_settings", {
  ownerEmail: text("owner_email").primaryKey(),
  encryptedSettings: text("encrypted_settings").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
