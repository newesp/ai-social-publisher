import { cancelScheduledPost, createPost, listPosts, publishPost } from "./post-service.js";

export function createPostRouteHandlers({ requireAppUser, requirePublisher, getRepository, readSettings, publishTargets, now = () => new Date(), respond = (body, init) => Response.json(body, init) }) {
  return {
    async GET() {
      const ownerEmail = await requireAppUser();
      const repository = await getRepository();
      return respond({ posts: await listPosts({ ownerEmail, repository }) });
    },
    async POST(request) {
      const ownerEmail = await requirePublisher();
      const repository = await getRepository();
      const input = await request.json();
      const post = await createPost({ ownerEmail, input, mode: input.mode, repository, now: now() });
      const published = input.mode === "now"
        ? await publishPost({ ownerEmail, postId: post.id, repository, readSettings, publishTargets, now: now() })
        : post;
      return respond({ post: published }, { status: 201 });
    },
  };
}

export function createPostCancellationHandler({ requirePublisher, getRepository, now = () => new Date(), respond = (body, init) => Response.json(body, init) }) {
  return async function DELETE(_request, { params }) {
    const ownerEmail = await requirePublisher();
    const { id } = await params;
    const repository = await getRepository();
    const post = await cancelScheduledPost({ ownerEmail, postId: id, repository, now: now() });
    return respond({ post });
  };
}
