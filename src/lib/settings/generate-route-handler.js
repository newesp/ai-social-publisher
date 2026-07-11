export function createGenerateRouteHandler({ requireOwner, store, getStore = () => store, buildResponse, respond = jsonResponse }) {
  return async function POST(request) {
    const ownerEmail = await requireOwner();
    const settingsStore = await getStore();
    const body = await request.json();
    const settings = await settingsStore.read(ownerEmail);

    try {
      return respond(await buildResponse({ body, settings }));
    } catch (error) {
      return respond({ error: error.message }, { status: 400 });
    }
  };
}

function jsonResponse(body, init) {
  return Response.json(body, init);
}
