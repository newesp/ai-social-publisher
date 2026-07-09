import { NextResponse } from "next/server";
import { buildGeneratedResponse } from "../../../lib/ai/generated-response.js";
import { readSettings } from "../../../lib/settings/settings-store.js";

export async function POST(request) {
  const body = await request.json();
  const settings = await readSettings();

  try {
    return NextResponse.json(await buildGeneratedResponse({ body, settings }));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
