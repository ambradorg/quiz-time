import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/auth";
import { isMaintenanceMode } from "@/lib/maintenance";
import { MaintenanceScreen } from "@/components/maintenance";
import { MaintenanceBanner } from "@/components/maintenance-banner";
import { RegisterServiceWorker } from "@/components/register-sw";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuizTime – Flashcard Quiz Maker",
  description: "Scan your PDFs or screenshots and turn them into fun flashcard quizzes!",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "QuizTime",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#4F46E5",
};

// MAINTENANCE_MODE is read from process.env per request (see
// src/lib/maintenance.ts). Forcing the page tree to render dynamically keeps
// Next from baking a build-time snapshot into prerendered HTML, so flipping
// the toggle + restarting the server is enough — no rebuild needed.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const maintenance = isMaintenanceMode();
  // Only touch the session (and its cookies) when maintenance is on:
  // signed-out visitors get the maintenance page, signed-in owners get the
  // normal app plus a banner.
  const session = maintenance ? await auth() : null;
  const signedIn = Boolean(session?.user?.id);

  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/logo.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Sora = display/headings, Inter = body UI — distinctive pairing, still highly legible.
            Stylesheet <link> on purpose: next/font would hard-fail when Google Fonts is unreachable. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {/* Keeps installed home-screen apps in sync with every deploy. */}
        <RegisterServiceWorker />
        <SessionProvider>
          {maintenance && !signedIn ? (
            <MaintenanceScreen />
          ) : (
            <>
              {maintenance && signedIn && (
                <MaintenanceBanner name={session?.user?.name} />
              )}
              {children}
            </>
          )}
        </SessionProvider>
      </body>
    </html>
  );
}
