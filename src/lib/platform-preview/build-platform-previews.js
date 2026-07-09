export function buildPlatformPreviews({ imageUrl, targets }) {
  const previews = {};

  for (const target of targets) {
    if (target.platform === "meta") {
      previews.meta = buildMetaPreview(target, imageUrl);
    }
    if (target.platform === "instagram") {
      previews.instagram = buildInstagramPreview(target, imageUrl);
    }
    if (target.platform === "line") {
      previews.line = buildLinePreview(target, imageUrl);
    }
  }

  return previews;
}

function buildMetaPreview(target, imageUrl) {
  const message = withHashtags(target.content, target.hashtags);
  const publishPayload = { message, imageUrl };

  return {
    platform: "meta",
    publishPayload,
    preview: {
      kind: "facebook-feed-post",
      imageUrl,
      message: publishPayload.message,
    },
  };
}

function buildInstagramPreview(target, imageUrl) {
  const caption = withHashtags(target.content, target.hashtags);
  const publishPayload = { caption, imageUrl };

  return {
    platform: "instagram",
    publishPayload,
    preview: {
      kind: "instagram-feed-post",
      aspectRatio: "1:1",
      imageUrl,
      caption: publishPayload.caption,
    },
  };
}

function buildLinePreview(target, imageUrl) {
  const publishPayload = { text: target.content, imageUrl };

  return {
    platform: "line",
    publishPayload,
    preview: {
      kind: "line-broadcast-message",
      imageUrl,
      text: publishPayload.text,
    },
  };
}

function withHashtags(content, hashtags = []) {
  const formattedTags = hashtags
    .map((tag) => String(tag).trim().replace(/^#/, ""))
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(" ");

  return formattedTags ? `${content}\n\n${formattedTags}` : content;
}
