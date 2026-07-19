export function createSupportSettingsRouteHandlers({
  requireOwner,
  requireSameOrigin,
  store,
  getStore = () => store,
  respond = (body, init) => Response.json(body, init),
  empty = (init) => new Response(null, init),
}) {
  return {
    async getConfiguration() {
      const ownerEmail = await requireOwner();
      const supportStore = await getStore();
      return respond({ configuration: await supportStore.getConfiguration(ownerEmail) });
    },

    async updateConfiguration(request) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const supportStore = await getStore();
      const input = await jsonBody(request);
      return respond({ configuration: await supportStore.updateConfiguration(ownerEmail, input) });
    },

    async listFaqs() {
      const ownerEmail = await requireOwner();
      const supportStore = await getStore();
      return respond({ faqs: await supportStore.listFaqs(ownerEmail) });
    },

    async createFaq(request) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const supportStore = await getStore();
      const input = await jsonBody(request);
      return respond({ faq: await supportStore.createFaq(ownerEmail, input) }, { status: 201 });
    },

    async updateFaq(request, id) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const supportStore = await getStore();
      const input = await jsonBody(request);
      return respond({ faq: await supportStore.updateFaq(ownerEmail, id, input) });
    },

    async deleteFaq(request, id) {
      const ownerEmail = await requireOwner();
      requireSameOrigin(request);
      const supportStore = await getStore();
      await supportStore.deleteFaq(ownerEmail, id);
      return empty({ status: 204 });
    },
  };
}

async function jsonBody(request) {
  try {
    return await request.json();
  } catch {
    const error = new Error("A JSON request body is required.");
    error.status = 400;
    throw error;
  }
}
