import { NextResponse } from "next/server";

export async function GET(request) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Invalid cron secret." }, { status: 401 });
  }

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    published: [],
    message: "Cron placeholder ready for scheduled post locking.",
  });
}
