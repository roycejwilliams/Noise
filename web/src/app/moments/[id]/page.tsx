import type { Metadata } from "next";
import PhotoSection from "./PhotoSection";

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
  vibes: string[] | null;
  image: string | null;
}

function getHeroGradient(vibes: string[] | null): string {
  if (!vibes?.length) return "linear-gradient(180deg, #0d0d10 0%, #000 100%)";
  const v = vibes.join(" ").toLowerCase();
  if (/dinner|wine|intimate|cozy|romantic|warm|candlelit|bistro/.test(v))
    return "linear-gradient(180deg, #1a0c06 0%, #0a0500 60%, #000 100%)";
  if (/outdoor|nature|park|fresh|garden|hike|adventure|open/.test(v))
    return "linear-gradient(180deg, #061408 0%, #030a04 60%, #000 100%)";
  if (/social|vibrant|lively|energy|lounge|fun|community/.test(v))
    return "linear-gradient(180deg, #08060f 0%, #050408 60%, #000 100%)";
  if (/creative|art|gallery|design|studio|craft/.test(v))
    return "linear-gradient(180deg, #120608 0%, #080404 60%, #000 100%)";
  return "linear-gradient(180deg, #0d0d10 0%, #000 100%)";
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
          background: "#000",
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
  const heroGradient = getHeroGradient(moment.vibes);
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#000",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Hero */}
        <div className="animate-hero" style={{ position: "relative", width: "100%", height: 300 }}>
          {moment.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={moment.image}
              alt=""
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: heroGradient,
              }}
            />
          )}
          {/* Fade hero to page background */}
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 140,
              background: "linear-gradient(to bottom, transparent, #000)",
            }}
          />
          {/* Wordmark overlaid on hero */}
          <div className="animate-fade-in delay-1" style={{ position: "absolute", top: 20, left: 20 }}>
            <span
              style={{
                color: "rgba(255,255,255,0.6)",
                fontSize: 13,
                fontWeight: 400,
                letterSpacing: "0.06em",
              }}
            >
              CoPatible
            </span>
          </div>
        </div>

        {/* Content */}
        <div style={{ padding: "0 20px 48px" }}>
          {/* Framing line */}
          <p
            className="animate-fade-up delay-1"
            style={{
              color: "rgba(255,255,255,0.35)",
              fontSize: 13,
              fontWeight: 300,
              margin: "16px 0 0",
              letterSpacing: "0.01em",
            }}
          >
            Co has arranged something for your circle.
          </p>

          {/* Moment name */}
          <h1
            className="animate-fade-up delay-2"
            style={{
              color: "#fff",
              fontSize: 32,
              fontWeight: 500,
              lineHeight: 1.15,
              margin: "10px 0 0",
              letterSpacing: "-0.02em",
            }}
          >
            {moment.moments_name}
          </h1>

          {/* Venue + time */}
          <div
            className="animate-fade-up delay-3"
            style={{
              marginTop: 12,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {(moment.venue || moment.location_name) && (
              <p
                style={{
                  color: "rgba(255,255,255,0.5)",
                  fontSize: 14,
                  margin: 0,
                  fontWeight: 300,
                }}
              >
                {[moment.venue, moment.location_name].filter(Boolean).join(" · ")}
              </p>
            )}
            {moment.suggested_time && (
              <p
                style={{
                  color: "rgba(255,255,255,0.35)",
                  fontSize: 14,
                  margin: 0,
                  fontWeight: 300,
                }}
              >
                {moment.suggested_time}
              </p>
            )}
          </div>

          {/* Member avatars */}
          {memberCount > 0 && (
            <div
              className="animate-fade-up delay-4"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 20,
              }}
            >
              <div style={{ display: "flex" }}>
                {Array.from({ length: Math.min(memberCount, 5) }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: `rgba(255,255,255,${0.1 + i * 0.03})`,
                      border: "1.5px solid #000",
                      marginLeft: i === 0 ? 0 : -10,
                      zIndex: 5 - i,
                      position: "relative",
                    }}
                  />
                ))}
              </div>
              <span
                style={{
                  color: "rgba(255,255,255,0.4)",
                  fontSize: 13,
                  fontWeight: 300,
                }}
              >
                {memberCount} people · selected for this circle
              </span>
            </div>
          )}

          <div
            className="animate-fade-in delay-4"
            style={{
              height: "0.5px",
              background: "rgba(255,255,255,0.1)",
              margin: "28px 0",
            }}
          />

          {/* Vibes */}
          {moment.vibes && moment.vibes.length > 0 && (
            <>
              <p
                className="animate-fade-up delay-5"
                style={{
                  color: "rgba(255,255,255,0.3)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  margin: "0 0 12px",
                }}
              >
                Vibe
              </p>
              <div
                className="animate-fade-up delay-5"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  marginBottom: 28,
                }}
              >
                {moment.vibes.map((vibe, i) => (
                  <span
                    key={i}
                    style={{
                      border: "1px solid rgba(255,255,255,0.15)",
                      borderRadius: 100,
                      padding: "5px 14px",
                      color: "rgba(255,255,255,0.5)",
                      fontSize: 12,
                      fontWeight: 300,
                      letterSpacing: "0.02em",
                    }}
                  >
                    {vibe}
                  </span>
                ))}
              </div>
              <div
                style={{
                  height: "0.5px",
                  background: "rgba(255,255,255,0.1)",
                  margin: "0 0 28px",
                }}
              />
            </>
          )}

          {/* Co's Notes */}
          {moment.description && (
            <>
              <p
                className="animate-fade-up delay-6"
                style={{
                  color: "rgba(255,255,255,0.3)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  margin: "0 0 12px",
                }}
              >
                Co&apos;s Notes
              </p>
              <p
                className="animate-fade-up delay-6"
                style={{
                  color: "rgba(255,255,255,0.85)",
                  fontSize: 14,
                  lineHeight: 1.7,
                  margin: 0,
                  fontWeight: 300,
                }}
              >
                {moment.description}
              </p>
              <div
                style={{
                  height: "0.5px",
                  background: "rgba(255,255,255,0.1)",
                  margin: "28px 0",
                }}
              />
            </>
          )}

          {/* Book CTA */}
          {moment.venue_booking_url && (
            <>
              <a
                className="animate-fade-up delay-7"
                href={moment.venue_booking_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "100%",
                  height: 52,
                  border: "1px solid #fff",
                  borderRadius: 100,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 400,
                  textDecoration: "none",
                  letterSpacing: "0.02em",
                  boxSizing: "border-box",
                }}
              >
                Book Your Spot
              </a>
              <div
                style={{
                  height: "0.5px",
                  background: "rgba(255,255,255,0.1)",
                  margin: "28px 0",
                }}
              />
            </>
          )}

          {/* Photos — client component */}
          <div className="animate-fade-in delay-7">
            <PhotoSection momentId={id} apiUrl={apiUrl} />
          </div>

          <p
            style={{
              color: "rgba(255,255,255,0.15)",
              fontSize: 11,
              textAlign: "center",
              margin: "40px 0 0",
              letterSpacing: "0.04em",
            }}
          >
            A CoPatible experience.
          </p>
        </div>
      </div>
    </div>
  );
}
