import { filterActivePlatforms } from "../platforms/platform-config.js";

export function createDraftTargets(input) {
  return filterActivePlatforms(input.platforms ?? ["meta", "line"]).map((platform) => ({
    platform,
    content: createDraftContent(platform, input),
    hashtags: [],
  }));
}

export function createDraftContent(platform, input) {
  const productName = input.productName?.trim() || "未命名產品";
  const productFeatures = input.productFeatures?.trim() || "請補上產品核心特點";
  const base = `${productName}：${productFeatures}`;

  if (platform === "line") {
    return `${productName} 新消息：${productFeatures}`;
  }

  return base;
}
