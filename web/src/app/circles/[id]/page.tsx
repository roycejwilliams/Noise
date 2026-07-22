import type { Metadata } from "next";

interface Circle {
  id: string;
  circle_name: string;
  status: string;
  city: string | null;
  chapter: string | null;
  member_count: number;
  member_first_names: string[];
}

async function getCircle(id: string): Promise<Circle | null> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) return null;
  try {
    const res = await fetch(`${apiUrl}/circles/public/${id}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ?? null;
  } catch {
    return null;
  }
}

function formatChapter(chapter: string | null): string | null {
  return chapter ? chapter.replace(/_/g, " ") : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const circle = await getCircle(id);
  if (!circle) return { title: "CoPatible" };

  const chapter = formatChapter(circle.chapter);
  const desc = [circle.city, chapter, "Curated by Co"].filter(Boolean).join(" · ");

  return {
    title: circle.circle_name,
    description: desc,
    openGraph: {
      title: circle.circle_name,
      description: desc,
      url: `https://app.copatible.com/circles/${id}`,
      siteName: "CoPatible",
      type: "website",
    },
    twitter: {
      card: "summary",
      title: circle.circle_name,
      description: desc,
    },
  };
}

export default async function CirclePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const circle = await getCircle(id);

  if (!circle) {
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
          Circle not found.
        </p>
      </div>
    );
  }

  const chapter = formatChapter(circle.chapter);
  const names = circle.member_first_names;

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
        <div
          className="animate-hero"
          style={{
            position: "relative",
            width: "100%",
            height: 220,
            background: "linear-gradient(180deg, #0d0d10 0%, #000 100%)",
          }}
        >
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 120,
              background: "linear-gradient(to bottom, transparent, #000)",
            }}
          />
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
            Co found your circle.
          </p>

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
            {circle.circle_name}
          </h1>

          {(circle.city || chapter) && (
            <p
              className="animate-fade-up delay-3"
              style={{
                color: "rgba(255,255,255,0.5)",
                fontSize: 14,
                margin: "12px 0 0",
                fontWeight: 300,
              }}
            >
              {[circle.city, chapter].filter(Boolean).join(" · ")}
            </p>
          )}

          {/* Member avatars + first names */}
          {names.length > 0 && (
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
                {names.slice(0, 5).map((_, i) => (
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
                {names.join(", ")}
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

          <p
            className="animate-fade-up delay-5"
            style={{
              color: "rgba(255,255,255,0.85)",
              fontSize: 14,
              lineHeight: 1.7,
              margin: 0,
              fontWeight: 300,
            }}
          >
            Co matches people navigating the same chapter of life, then brings
            you together in person. There&apos;s already a moment being
            curated for this circle — reply to the text from Co to join in.
          </p>

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
