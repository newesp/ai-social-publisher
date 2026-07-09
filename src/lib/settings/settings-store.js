import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { maskSecret } from "./secret-bundle.js";

const PUBLIC_SETTING_KEYS = new Set(["metaPageId"]);

export async function readSettings(options = {}) {
  const filePath = options.filePath ?? getDefaultFilePath();

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function updateSettings(updates, options = {}) {
  const filePath = options.filePath ?? getDefaultFilePath();
  const current = await readSettings({ filePath });
  const next = { ...current, ...stripEmptyValues(updates) };

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return next;
}

export async function replaceSettings(settings, options = {}) {
  const filePath = options.filePath ?? getDefaultFilePath();

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  return settings;
}

export async function getMaskedSettings(options = {}) {
  const settings = await readSettings(options);
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [
      key,
      PUBLIC_SETTING_KEYS.has(key) ? value : maskSecret(value),
    ]),
  );
}

function stripEmptyValues(updates) {
  return Object.fromEntries(
    Object.entries(updates ?? {}).filter(([, value]) => value !== "" && value != null),
  );
}

function getDefaultFilePath() {
  return path.join("data", "settings.json");
}
