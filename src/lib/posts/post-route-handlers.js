import { cancelScheduledPost, createPost, listPosts, publishPost } from "./post-service.js";

export function createPostRouteHandlers({ requireAppUser, requirePublisher, getRepository, readSettings, publishTargets, now = () => new Date(), respond = (body, init) => Response.json(body, init) }) {
  return {
    async GET() {
      const ownerEmail = await requireAppUser();
      const repository = await getRepository();
      const posts = await listPosts({ ownerEmail, repository });
      return respond({ posts: posts.map(toPostResponse) });
    },
    async POST(request) {
      const ownerEmail = await requirePublisher();
      const repository = await getRepository();
      const input = await request.json();
      const post = await createPost({ ownerEmail, input, mode: input.mode, repository, now: now() });
      let published = post;
      if (input.mode === "now") {
        try {
          published = await publishPost({ ownerEmail, postId: post.id, repository, readSettings, publishTargets, now: now() });
        } catch {
          throw routeError("Publishing failed and the outcome could not be recorded.", 500);
        }
      }
      return respond({ post: toPostResponse(published) }, { status: 201 });
    },
  };
}

function routeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createPostCancellationHandler({ requirePublisher, getRepository, now = () => new Date(), respond = (body, init) => Response.json(body, init) }) {
  return async function DELETE(_request, { params }) {
    const ownerEmail = await requirePublisher();
    const { id } = await params;
    const repository = await getRepository();
    const post = await cancelScheduledPost({ ownerEmail, postId: id, repository, now: now() });
    return respond({ post: toPostResponse(post) });
  };
}

function toPostResponse(post) {
  const { ownerEmail: _ownerEmail, targets = [], ...safePost } = post;
  return {
    ...safePost,
    targets: targets.map(({ errorMessage: _errorMessage, ...target }) => ({
      ...target,
      errorMessage: target.status === "failed" ? "Publishing failed." : null,
    })),
  };
}
