export const ACTIVE_PLATFORMS = Object.freeze([
  { value: "meta", label: "Meta" },
  { value: "line", label: "LINE" },
]);

const ACTIVE_PLATFORM_VALUES = new Set(ACTIVE_PLATFORMS.map((platform) => platform.value));

export function isActivePlatform(platform) {
  return ACTIVE_PLATFORM_VALUES.has(platform);
}

export function filterActivePlatforms(platforms = []) {
  return platforms.filter((platform) => isActivePlatform(platform));
}
