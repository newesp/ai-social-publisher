export async function loadPostHistory(fetchImpl = fetch) {
  const response = await fetchImpl("/api/posts");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "無法載入貼文紀錄。");
  return Array.isArray(data.posts) ? data.posts : [];
}

export async function cancelScheduledPost(fetchImpl = fetch, postId) {
  const response = await fetchImpl(`/api/posts/${postId}`, { method: "DELETE" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "無法取消排程貼文。");
  return data.post;
}
