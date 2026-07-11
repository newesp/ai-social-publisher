import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "This direct publish endpoint has been retired. Create posts through POST /api/posts." },
    { status: 410 },
  );
}
