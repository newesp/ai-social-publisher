import { NextResponse } from "next/server";
import { buildPlatformPreviews } from "../../../../../lib/platform-preview/build-platform-previews.js";
import { publishTargets } from "../../../../../lib/platforms/publish-service.js";
import { filterActivePlatforms } from "../../../../../lib/platforms/platform-config.js";
import { readSettings } from "../../../../../lib/settings/settings-store.js";

export async function POST(request, { params }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const settings = await readSettings();
  const targets =
    Array.isArray(body.targets) && body.targets.length > 0
      ? body.targets.filter((target) => filterActivePlatforms([target.platform]).length > 0)
      : filterActivePlatforms(body.platforms ?? ["meta", "line"]).map((platform) => ({
          platform,
          content: body.content ?? "AI Social Publisher 測試發文",
          hashtags: platform === "line" ? [] : (body.hashtags ?? []),
        }));
  const previews = buildPlatformPreviews({ imageUrl: body.imageUrl ?? null, targets });
  const publishTargetsInput = Object.values(previews).map((preview) => ({
    platform: preview.platform,
    publishPayload: preview.publishPayload,
  }));
  const results = await publishTargets({ targets: publishTargetsInput, settings });

  return NextResponse.json({
    id,
    status: results.every((result) => result.status === "published") ? "published" : "partial_or_failed",
    results,
  });
}
