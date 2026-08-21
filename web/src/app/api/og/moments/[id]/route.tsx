import { ImageResponse } from "next/og";
import { type NextRequest } from "next/server";

export const runtime = "edge";

interface Moment {
  moments_name: string;
  location_name: string | null;
  suggested_time: string | null;
  member_count: number | null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;

  let moment: Moment = {
    moments_name: "A Co Experience",
    location_name: null,
    suggested_time: null,
    member_count: null,
  };

  if (apiUrl) {
    try {
      const res = await fetch(`${apiUrl}/moments/public/${id}`, {
        next: { revalidate: 60 },
      });
      if (res.ok) {
        const json = await res.json();
        if (json.data) moment = json.data;
      }
    } catch {
      // fall through to defaults
    }
  }

  const memberLine = moment.member_count
    ? `${moment.member_count} people · Curated by Co`
    : "Curated by Co";

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          background: "#000000",
          display: "flex",
          flexDirection: "column",
          padding: "60px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <span
          style={{
            color: "#ffffff",
            fontSize: 28,
            fontWeight: 300,
            letterSpacing: "0.04em",
          }}
        >
          Co
        </span>

        <div
          style={{
            color: "#ffffff",
            fontSize: 56,
            fontWeight: 300,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            maxWidth: 800,
            marginTop: 40,
          }}
        >
          {moment.moments_name}
        </div>

        {moment.location_name && (
          <div
            style={{
              color: "rgba(255,255,255,0.5)",
              fontSize: 24,
              fontWeight: 300,
              marginTop: 16,
            }}
          >
            {moment.location_name}
          </div>
        )}

        {moment.suggested_time && (
          <div
            style={{
              color: "rgba(255,255,255,0.5)",
              fontSize: 20,
              fontWeight: 300,
              marginTop: 8,
            }}
          >
            {moment.suggested_time}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "auto",
          }}
        >
          <span
            style={{
              color: "rgba(255,255,255,0.4)",
              fontSize: 16,
              fontWeight: 300,
            }}
          >
            {memberLine}
          </span>

          <div
            style={{
              border: "1px solid rgba(255,255,255,0.4)",
              borderRadius: 100,
              padding: "6px 14px",
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 300,
              letterSpacing: "0.04em",
            }}
          >
            Co
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
