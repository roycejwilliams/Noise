import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const momentId = formData.get("momentId") as string | null;

  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
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
  const path = `moments/${momentId ?? "unknown"}/${Date.now()}.${ext}`;

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
}
