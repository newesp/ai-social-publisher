export default function Home() {
  return (
    <main style={{ maxWidth: 480, margin: "80px auto", fontFamily: "sans-serif" }}>
      <h1>Facebook 永久 Page Token 產生器</h1>
      <p style={{ color: "#555" }}>
        點下方按鈕登入你的 Facebook 帳號,授權後會自動換出「永不過期」的 Page
        Access Token。
      </p>
      <a
        href="/api/facebook/login"
        style={{
          display: "inline-block",
          padding: "12px 24px",
          background: "#1877f2",
          color: "white",
          borderRadius: 6,
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        用 Facebook 登入並取得 Page Token
      </a>
    </main>
  );
}
