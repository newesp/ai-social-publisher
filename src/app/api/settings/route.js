import { NextResponse } from "next/server";
import { getMaskedSettings, updateSettings } from "../../../lib/settings/settings-store.js";

export async function GET() {
  return NextResponse.json({ settings: await getMaskedSettings() });
}

export async function PUT(request) {
  const body = await request.json();
  const settings = await updateSettings(body);

  return NextResponse.json({
    updatedKeys: Object.keys(settings),
    settings: await getMaskedSettings(),
  });
}
