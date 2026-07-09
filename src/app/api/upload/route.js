import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({
    imageUrl: "https://i.imgur.com/8Km9tLL.jpg",
    provider: "imgur",
    mode: "mvp-placeholder",
  });
}
