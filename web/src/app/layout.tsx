import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CoPatible",
  description: "Your life concierge.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
