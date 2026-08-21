const TESTFLIGHT_URL =
  process.env.NEXT_PUBLIC_TESTFLIGHT_URL ?? "https://testflight.apple.com";

export default function Home() {
  return (
    <div
      className="animate-fade-in"
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "32px",
        background: "#000000",
      }}
    >
      <h1
        className="animate-fade-up delay-1"
        style={{
          fontSize: 32,
          fontWeight: 200,
          color: "#ffffff",
          letterSpacing: 0.3,
          margin: 0,
        }}
      >
        Co
      </h1>

      <p
        className="animate-fade-up delay-2"
        style={{
          fontSize: 17,
          fontWeight: 400,
          color: "rgba(255,255,255,0.85)",
          marginTop: 20,
          maxWidth: 320,
        }}
      >
        Find compatible friends for your chapter.
      </p>

      <p
        className="animate-fade-up delay-3"
        style={{
          fontSize: 14,
          fontWeight: 300,
          color: "rgba(255,255,255,0.5)",
          marginTop: 8,
          maxWidth: 320,
        }}
      >
        Curated by chapter, built for connection.
      </p>

      <a
        href={TESTFLIGHT_URL}
        className="animate-fade-up delay-4"
        style={{
          marginTop: 40,
          display: "inline-block",
          border: "1px solid #ffffff",
          borderRadius: 100,
          padding: "14px 32px",
          color: "#ffffff",
          fontSize: 15,
          fontWeight: 300,
          letterSpacing: 0.3,
          textDecoration: "none",
        }}
      >
        Download on TestFlight
      </a>

      <p
        className="animate-fade-up delay-5"
        style={{
          position: "fixed",
          bottom: 32,
          fontSize: 11,
          fontWeight: 400,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.3)",
        }}
      >
        Invite only.
      </p>
    </div>
  );
}
