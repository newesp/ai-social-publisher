import { eq } from "drizzle-orm";

import { userSettings } from "../db/schema.js";

export function createDbUserSettingsRepository(db) {
  return {
    async findByOwnerEmail(ownerEmail) {
      const [record] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.ownerEmail, ownerEmail))
        .limit(1);
      return record ?? null;
    },

    async save(record) {
      await db
        .insert(userSettings)
        .values(record)
        .onConflictDoUpdate({
          target: userSettings.ownerEmail,
          set: {
            encryptedSettings: record.encryptedSettings,
            updatedAt: record.updatedAt,
          },
        });
    },
  };
}
