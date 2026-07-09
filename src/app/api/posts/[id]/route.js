import { NextResponse } from "next/server";

export async function DELETE(_request, { params }) {
  return NextResponse.json({ id: params.id, status: "cancelled" });
}
