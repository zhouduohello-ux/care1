import * as Sentry from "@sentry/nextjs";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CareMemory",
  description: "Your personal Disease Card and visit brief",
};

function ErrorFallback({
  error,
  resetError,
}: {
  error: unknown;
  resetError: () => void;
}) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return (
    <div style={{ padding: 24, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1>Something went wrong</h1>
      <p>We have been notified. Please try refreshing the page.</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{message}</pre>
      <button onClick={resetError} type="button">
        Try again
      </button>
    </div>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif", background: "#f3f4f6" }}>
        <Sentry.ErrorBoundary fallback={ErrorFallback} showDialog={false}>
          {children}
        </Sentry.ErrorBoundary>
      </body>
    </html>
  );
}
