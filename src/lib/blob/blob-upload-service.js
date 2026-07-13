import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";

const EXTENSIONS_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function uploadGeneratedImage({
  imageUrl,
  putImpl = put,
  idFactory = randomUUID,
  blobStoreId = process.env.BLOB_STORE_ID,
} = {}) {
  if (!imageUrl) return null;
  if (isPublicHttpsUrl(imageUrl)) return imageUrl;

  const parsed = parseDataUrl(imageUrl);
  const extension = EXTENSIONS_BY_MIME[parsed.contentType] ?? "bin";
  const pathname = `generated-posts/${idFactory()}.${extension}`;
  const blob = new Blob([parsed.buffer], { type: parsed.contentType });
  const result = await putImpl(pathname, blob, {
    access: "public",
    contentType: parsed.contentType,
    ...(blobStoreId ? { storeId: blobStoreId } : {}),
  });

  return result.url;
}

function isPublicHttpsUrl(value) {
  return typeof value === "string" && value.startsWith("https://");
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value ?? "");
  if (!match) {
    throw new Error("Generated image must be a public HTTPS URL or base64 data URL.");
  }

  return {
    contentType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}
