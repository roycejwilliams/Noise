import type { Metadata } from "next";

interface Moment {
  id: string;
  moments_name: string;
  venue: string | null;
  location_name: string | null;
  suggested_time: string | null;
  venue_booking_url: string | null;
  description: string | null;
  circle_id: string | null;
  member_count: number;
}

async function getMoment(id: string): Promise<Moment | null> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) return null;
  try {
    const res = await fetch(`${apiUrl}/moments/public/${id}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const moment = await getMoment(id);
  if (!moment) return { title: "CoPatible" };

  const desc = [
    moment.location_name,
    moment.suggested_time,
    moment.member_count ? `${moment.member_count} people` : null,
    "Curated by Co",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    title: moment.moments_name,
    description: desc,
    openGraph: {
      title: moment.moments_name,
      description: desc,
      url: `https://copatible.com/moments/${id}`,
      siteName: "CoPatible",
      images: [
        {
          url: `https://copatible.com/api/og/moments/${id}`,
          width: 1200,
          height: 630,
        },
      ],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: moment.moments_name,
      description: desc,
      images: [`https://copatible.com/api/og/moments/${id}`],
    },
  };
}

export default async function MomentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const moment = await getMoment(id);

  if (!moment) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          background: "#000000",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>
          Moment not found.
        </p>
      </div>
    );
  }

  const memberCount = moment.member_count ?? 0;

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#000000",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          padding: "0 0 40px 0",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Wordmark */}
        <div style={{ padding: "24px 20px 0" }}>
          <span
            style={{
              color: "#ffffff",
              fontSize: 15,
              fontWeight: 500,
              letterSpacing: "0.04em",
            }}
          >
            CoPatible
          </span>
        </div>

        {/* Hero placeholder */}
        <div
          style={{
            width: "100%",
            height: 280,
            background: "#111111",
            border: "0.5px solid rgba(255,255,255,0.1)",
            marginTop: 20,
          }}
        />

        {/* Content */}
        <div style={{ padding: "0 20px" }}>
          <h1
            style={{
              color: "#ffffff",
              fontSize: 28,
              fontWeight: 600,
              lineHeight: 1.2,
              margin: "24px 0 0",
              letterSpacing: "-0.02em",
            }}
          >
            {moment.moments_name}
          </h1>

          {moment.location_name && (
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 15, margin: "8px 0 0", lineHeight: 1.5 }}>
              {moment.location_name}
            </p>
          )}

          {moment.suggested_time && (
            <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 15, margin: "4px 0 0", lineHeight: 1.5 }}>
              {moment.suggested_time}
            </p>
          )}

          {memberCount > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                {Array.from({ length: Math.min(memberCount, 4) }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      background: `rgba(255,255,255,${0.12 + i * 0.04})`,
                      border: "1.5px solid #000000",
                      marginLeft: i === 0 ? 0 : -8,
                      zIndex: 4 - i,
                      position: "relative",
                    }}
                  />
                ))}
              </div>
              <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>
                {memberCount} people · Curated by Co
              </span>
            </div>
          )}

          <div
            style={{
              width: "100%",
              height: "0.5px",
              background: "rgba(255,255,255,0.1)",
              margin: "24px 0",
            }}
          />

          {moment.description && (
            <>
              <p
                style={{
                  color: "rgba(255,255,255,0.4)",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  margin: "0 0 12px",
                }}
              >
                Co&apos;s Notes
              </p>
              <p style={{ color: "#ffffff", fontSize: 14, lineHeight: 1.6, margin: 0 }}>
                {moment.description}
              </p>

              <div
                style={{
                  width: "100%",
                  height: "0.5px",
                  background: "rgba(255,255,255,0.1)",
                  margin: "24px 0",
                }}
              />
            </>
          )}

          {moment.venue_booking_url && (
            <a
              href={moment.venue_booking_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
                height: 52,
                border: "1px solid #ffffff",
                borderRadius: 100,
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 500,
                textDecoration: "none",
                letterSpacing: "0.01em",
                boxSizing: "border-box",
              }}
            >
              Book Your Spot
            </a>
          )}

          <p
            style={{
              color: "rgba(255,255,255,0.3)",
              fontSize: 12,
              textAlign: "center",
              margin: "40px 0 0",
            }}
          >
            A CoPatible experience.
          </p>
        </div>
      </div>
    </div>
  );
}
