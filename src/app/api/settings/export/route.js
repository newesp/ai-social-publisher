import { NextResponse } from "next/server";
import { encryptSecretBundle } from "../../../../lib/settings/secret-bundle.js";
import { readSettings } from "../../../../lib/settings/settings-store.js";

export async function POST(request) {
  const { passphrase, secrets } = await request.json();
  const bundle = encryptSecretBundle(secrets ?? (await readSettings()), passphrase);

  return NextResponse.json({ bundle });
}
