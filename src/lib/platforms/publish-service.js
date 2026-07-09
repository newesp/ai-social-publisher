import { filterActivePlatforms } from "./platform-config.js";

export async function publishTargets({ targets, settings, fetchImpl = fetch }) {
  const activePlatforms = new Set(filterActivePlatforms(targets.map((target) => target.platform)));
  const activeTargets = targets.filter((target) => activePlatforms.has(target.platform));
  const results = [];

  for (const target of activeTargets) {
    try {
      if (target.platform === "meta") {
        results.push(await publishMeta(target, settings, fetchImpl));
      }
      if (target.platform === "line") {
        results.push(await publishLine(target, settings, fetchImpl));
      }
    } catch (error) {
      results.push({
        platform: target.platform,
        status: "failed",
        error: error.message,
      });
    }
  }

  return results;
}

async function publishMeta(target, settings, fetchImpl) {
  requireSetting(settings.metaPageId, "META_PAGE_ID");
  requireSetting(settings.metaPageAccessToken, "META_PAGE_ACCESS_TOKEN");

  const hasImage = Boolean(target.publishPayload.imageUrl);
  const url = hasImage
    ? `https://graph.facebook.com/v25.0/${settings.metaPageId}/photos`
    : `https://graph.facebook.com/v25.0/${settings.metaPageId}/feed`;
  const payload = hasImage
    ? {
        caption: target.publishPayload.message,
        url: target.publishPayload.imageUrl,
        access_token: settings.metaPageAccessToken,
      }
    : {
        message: target.publishPayload.message,
        access_token: settings.metaPageAccessToken,
      };

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return readPlatformResponse("meta", response);
}

async function publishLine(target, settings, fetchImpl) {
  requireSetting(settings.lineChannelAccessToken, "LINE_CHANNEL_ACCESS_TOKEN");

  const response = await fetchImpl("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.lineChannelAccessToken}`,
    },
    body: JSON.stringify({
      messages: buildLineMessages(target.publishPayload),
    }),
  });

  return readPlatformResponse("line", response);
}

function buildLineMessages(publishPayload) {
  const messages = [{ type: "text", text: publishPayload.text }];

  if (publishPayload.imageUrl) {
    messages.push({
      type: "image",
      originalContentUrl: publishPayload.imageUrl,
      previewImageUrl: publishPayload.imageUrl,
    });
  }

  return messages;
}

async function readPlatformResponse(platform, response) {
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok) {
    throw new Error(body.message ?? body.error?.message ?? `${platform} publish failed.`);
  }

  return {
    platform,
    status: "published",
    externalId: body.id ?? null,
  };
}

function requireSetting(value, name) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
}
