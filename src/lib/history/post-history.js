export async function loadPostHistory(fetchImpl = fetch) {
  const response = await fetchImpl("/api/posts");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Unable to load post history.");
  return Array.isArray(data.posts) ? data.posts : [];
}

export async function cancelScheduledPost(fetchImpl = fetch, postId) {
  const response = await fetchImpl(`/api/posts/${postId}`, { method: "DELETE" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Unable to cancel the scheduled post.");
  return data.post;
}
