import { NextResponse } from "next/server";
import {
  decryptSecretBundle,
  mergeSecrets,
  previewSecretImport,
} from "../../../../lib/settings/secret-bundle.js";
import {
  getMaskedSettings,
  readSettings,
  replaceSettings,
} from "../../../../lib/settings/settings-store.js";

export async function POST(request) {
  const { bundle, passphrase, mode = "preview", currentSecrets } = await request.json();
  const current = currentSecrets ?? (await readSettings());
  const incoming = decryptSecretBundle(bundle, passphrase);

  if (mode === "preview") {
    return NextResponse.json({ preview: previewSecretImport(incoming, current) });
  }

  const settings = mergeSecrets(current, incoming, mode);
  await replaceSettings(settings);

  return NextResponse.json({ settings: await getMaskedSettings() });
}
