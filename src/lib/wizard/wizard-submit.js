import { buildPostSubmission } from "./post-submission.js";

export async function submitCheckedPost({
  form,
  targets,
  imageUrl,
  fetchImpl = fetch,
  onPhase = () => {},
}) {
  onPhase("checking");
  const proofreadResponse = await fetchImpl("/api/proofread", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      llmProvider: form.llmProvider,
      llmModel: form.llmModel,
      targets,
    }),
  });
  const proofreadData = await proofreadResponse.json();
  if (!proofreadResponse.ok) {
    throw new Error(proofreadData.error ?? "AI 錯字檢查失敗，請稍後再試。");
  }
  if (proofreadData.issues?.length) {
    return { status: "issues", issues: proofreadData.issues };
  }

  onPhase("publishing");
  const response = await fetchImpl("/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPostSubmission({ form, targets, imageUrl })),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "建立貼文失敗。");
  return { status: "submitted", post: data.post };
}

export function isSuccessfulPostResult(post) {
  return post?.status === "scheduled" || post?.status === "published";
}
