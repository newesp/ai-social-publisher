import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Settings export is unavailable." },
    { status: 410 },
  );
}
