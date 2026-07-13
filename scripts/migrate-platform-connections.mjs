import { isDirectExecution, runLegacyPlatformCleanup } from "./remove-legacy-platform-credentials.mjs";
import { runPlatformSchemaMigration } from "./apply-platform-schema.mjs";

export async function runPlatformConnectionMigration({
  directExecution = isDirectExecution(import.meta.url, process.argv[1]), env = process.env,
  applySchema = (options) => runPlatformSchemaMigration(options),
  cleanupLegacy = (options) => runLegacyPlatformCleanup(options),
} = {}) {
  if (!directExecution) return null;
  const schema = await applySchema({ directExecution: true, env });
  const cleanup = await cleanupLegacy({ directExecution: true, env });
  return { ...schema, ...cleanup };
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  runPlatformConnectionMigration({ directExecution: true })
    .then(({ cleanedSettings, failedTargets }) => console.log(`Platform migration complete: ${cleanedSettings} settings row(s), ${failedTargets} target(s).`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
