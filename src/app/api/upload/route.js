import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ error: "This legacy upload endpoint is no longer supported." }, { status: 410 });
}
