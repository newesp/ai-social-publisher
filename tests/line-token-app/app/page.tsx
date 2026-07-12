"use client";

import { useState } from "react";

type IssueResult = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  key_id?: string;
  error?: string;
  error_description?: string;
};

export default function Home() {
  const [result, setResult] = useState<IssueResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);

  async function issueToken() {
    setLoading(true);
    setResult(null);
    setRevokeMsg(null);
    const res = await fetch("/api/line/issue-token", { method: "POST" });
    const data = await res.json();
    setResult(data);
    setLoading(false);
  }

  async function revokeToken() {
    if (!result?.access_token) return;
    const res = await fetch("/api/line/revoke-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: result.access_token }),
    });
    if (res.ok) {
      setRevokeMsg("已撤銷這組 token ✅");
    } else {
      const data = await res.json();
      setRevokeMsg(`撤銷失敗:${JSON.stringify(data)}`);
    }
  }

  return (
    <main style={{ maxWidth: 560, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>LINE Channel Access Token 產生器</h1>
      <p style={{ color: "#555" }}>
        用你 Channel 的 <code>Channel ID</code> + <code>Channel Secret</code> 直接換發
        Channel Access Token v2.1(效期 30 天)。
      </p>

      <button
        onClick={issueToken}
        disabled={loading}
        style={{
          padding: "12px 24px",
          background: "#06c755",
          color: "white",
          border: "none",
          borderRadius: 6,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {loading ? "取得中..." : "取得 Channel Access Token"}
      </button>

      {result && (
        <div style={{ marginTop: 24, padding: 16, background: "#f6f6f6", borderRadius: 8 }}>
          {result.error ? (
            <p style={{ color: "#b00" }}>
              錯誤:{result.error} — {result.error_description}
            </p>
          ) : (
            <>
              <p>
                <strong>Access Token:</strong>
                <br />
                <code style={{ wordBreak: "break-all" }}>{result.access_token}</code>
              </p>
              <p>
                <strong>有效期:</strong> {result.expires_in} 秒(約 {Math.round((result.expires_in || 0) / 86400)} 天)
              </p>
              <p>
                <strong>Key ID:</strong> {result.key_id}
              </p>
              <button
                onClick={revokeToken}
                style={{
                  marginTop: 8,
                  padding: "8px 16px",
                  background: "#b00020",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                撤銷這組 Token
              </button>
              {revokeMsg && <p>{revokeMsg}</p>}
            </>
          )}
        </div>
      )}

      <p style={{ marginTop: 32, color: "#b00", fontSize: 14 }}>
        ⚠️ Token 會直接顯示在畫面上,複製走之後記得關掉分頁,不要截圖分享。
      </p>
    </main>
  );
}
