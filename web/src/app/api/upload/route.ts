import { NextRequest, NextResponse } from "next/server";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MOMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const momentId = formData.get("momentId") as string | null;

    if (!file) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }
    if (!momentId || !MOMENT_ID_PATTERN.test(momentId)) {
      return NextResponse.json({ error: "valid momentId is required" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: "unsupported file type" }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "file too large" }, { status: 400 });
    }

    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!apiUrl) {
      return NextResponse.json({ error: "API not configured" }, { status: 500 });
    }

    // Only upload photos for moments that actually exist — momentId is the
    // capability token on this public, no-login share page.
    const momentCheck = await fetch(`${apiUrl}/moments/public/${momentId}`);
    if (!momentCheck.ok) {
      return NextResponse.json({ error: "moment not found" }, { status: 404 });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { error: "Storage not configured" },
        { status: 500 },
      );
    }

    const ext = file.name.split(".").pop() ?? "jpg";
    const path = `moments/${momentId}/${Date.now()}.${ext}`;

    const res = await fetch(
      `${supabaseUrl}/storage/v1/object/moment-photos/${path}`,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          "Content-Type": file.type,
          "x-upsert": "false",
        },
        body: file,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error("Supabase Storage upload error:", text);
      return NextResponse.json({ error: "Upload failed" }, { status: 502 });
    }

    const url = `${supabaseUrl}/storage/v1/object/public/moment-photos/${path}`;
    return NextResponse.json({ url });
  } catch (error) {
    console.error("Upload route error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
