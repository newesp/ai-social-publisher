export function createSettingsRouteHandlers({ requireOwner, store, getStore = () => store, respond = jsonResponse }) {
  return {
    async GET() {
      const ownerEmail = await requireOwner();
      const settingsStore = await getStore();
      return respond({ settings: await settingsStore.getMasked(ownerEmail) });
    },

    async PUT(request) {
      const ownerEmail = await requireOwner();
      const settingsStore = await getStore();
      const updates = await request.json();
      const settings = await settingsStore.update(ownerEmail, updates);

      return respond({
        updatedKeys: Object.keys(settings),
        settings: await settingsStore.getMasked(ownerEmail),
      });
    },
  };
}

function jsonResponse(body, init) {
  return Response.json(body, init);
}
