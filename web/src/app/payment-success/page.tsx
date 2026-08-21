export default function PaymentSuccess() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#000000",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      <span
        style={{
          color: "#ffffff",
          fontSize: 15,
          fontWeight: 500,
          letterSpacing: "0.04em",
          marginBottom: 40,
        }}
      >
        Co
      </span>

      <p
        style={{
          color: "#ffffff",
          fontSize: 22,
          fontWeight: 300,
          lineHeight: 1.4,
          maxWidth: 320,
          marginBottom: 12,
        }}
      >
        Your spot is confirmed.
      </p>
      <p
        style={{
          color: "rgba(255,255,255,0.4)",
          fontSize: 14,
          fontWeight: 300,
          lineHeight: 1.6,
          maxWidth: 280,
          marginBottom: 40,
        }}
      >
        Co will be in touch with details. Return to the app to see your circle.
      </p>

      <a
        href="copatible://payment-success"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: 52,
          padding: "0 32px",
          border: "1px solid #ffffff",
          borderRadius: 100,
          color: "#ffffff",
          fontSize: 15,
          fontWeight: 400,
          textDecoration: "none",
          letterSpacing: "0.01em",
        }}
      >
        Return to Co
      </a>
    </div>
  );
}
