"use client";

import { useEffect, useRef, useState } from "react";

interface Photo {
  id: string;
  image_url: string;
}

interface Props {
  momentId: string;
  apiUrl: string;
}

export default function PhotoSection({ momentId, apiUrl }: Props) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!apiUrl) return;
    fetch(`${apiUrl}/moments/${momentId}/photos/public`)
      .then((r) => r.json())
      .then((json) => {
        if (Array.isArray(json.data)) setPhotos(json.data);
      })
      .catch(() => {});
  }, [momentId, apiUrl]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("momentId", momentId);

      const uploadRes = await fetch("/api/upload", { method: "POST", body: form });
      if (!uploadRes.ok) throw new Error("Upload failed");
      const { url } = await uploadRes.json();

      const saveRes = await fetch(`${apiUrl}/moments/${momentId}/photos/public`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: url }),
      });
      if (!saveRes.ok) throw new Error("Could not save photo");
      const saved = await saveRes.json();

      setPhotos((prev) => [...prev, saved.data]);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div>
      <p
        style={{
          color: "rgba(255,255,255,0.3)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          margin: "0 0 16px",
        }}
      >
        From the Night
      </p>

      {/* Photo grid */}
      {photos.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 4,
            marginBottom: 12,
          }}
        >
          {photos.map((photo) => (
            <div
              key={photo.id}
              style={{ aspectRatio: "1", overflow: "hidden", borderRadius: 4 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.image_url}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Upload trigger */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        style={{ display: "none" }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        style={{
          width: "100%",
          height: 48,
          border: "1px dashed rgba(255,255,255,0.18)",
          borderRadius: 8,
          background: "transparent",
          color: uploading ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.4)",
          fontSize: 13,
          fontWeight: 300,
          cursor: uploading ? "wait" : "pointer",
          letterSpacing: "0.02em",
          transition: "color 0.2s",
        }}
      >
        {uploading
          ? "Uploading..."
          : photos.length > 0
          ? "Add another photo"
          : "Add a photo from the night"}
      </button>

      {error && (
        <p
          style={{
            color: "rgba(255,80,80,0.7)",
            fontSize: 12,
            fontWeight: 300,
            margin: "8px 0 0",
            textAlign: "center",
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
