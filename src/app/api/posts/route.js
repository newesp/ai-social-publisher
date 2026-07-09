import { NextResponse } from "next/server";

const demoPosts = [
  {
    id: 1,
    productName: "示範商品",
    status: "draft",
    targets: [
      { platform: "meta", status: "draft" },
      { platform: "instagram", status: "draft" },
    ],
  },
];

export async function GET() {
  return NextResponse.json({ posts: demoPosts });
}

export async function POST(request) {
  const body = await request.json();

  return NextResponse.json(
    {
      post: {
        id: Date.now(),
        status: body.mode === "scheduled" ? "scheduled" : "draft",
        ...body,
      },
    },
    { status: 201 },
  );
}
