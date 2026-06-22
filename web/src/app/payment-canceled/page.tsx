export default function PaymentCanceled() {
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
        CoPatible
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
        No payment was taken.
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
        Your spot is still available. Return to the app to complete your booking.
      </p>

      <a
        href="copatible://payment-canceled"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: 52,
          padding: "0 32px",
          border: "1px solid rgba(255,255,255,0.4)",
          borderRadius: 100,
          color: "rgba(255,255,255,0.7)",
          fontSize: 15,
          fontWeight: 400,
          textDecoration: "none",
          letterSpacing: "0.01em",
        }}
      >
        Return to CoPatible
      </a>
    </div>
  );
}
