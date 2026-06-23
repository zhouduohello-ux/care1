"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface Profile {
  nickname: string | null;
  phoneNumber: string;
  nextVisitAt: string | null;
  medications: { baseline?: Array<{ name: string; type: string }> } | null;
}

interface Observation {
  id: string;
  category: string;
  concept: string;
  value: unknown;
  timestamp: string;
}

interface CheckIn {
  id: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  completedAt: string | null;
}

interface Cycle {
  id: string;
  status: string;
  startedAt: string;
  nextCheckinAt: string | null;
  checkIns: CheckIn[];
  observations: Observation[];
}

interface RecordsData {
  profile: Profile;
  cycles: Cycle[];
  observations: Observation[];
}

export default function RecordsPage() {
  return (
    <Suspense fallback={<RecordsSkeleton />}>
      <RecordsContent />
    </Suspense>
  );
}

function RecordsSkeleton() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
      <p>Loading your records…</p>
    </main>
  );
}

function RecordsContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("t");
  const [data, setData] = useState<RecordsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError("Missing access token");
      return;
    }
    fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3055"}/api/records?t=${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Invalid or expired link");
        return res.json() as Promise<RecordsData>;
      })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [token]);

  if (error) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
        <h1>Access denied</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
        <p>Loading your records…</p>
      </main>
    );
  }

  const profile = data.profile;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
      <h1>Your records</h1>
      <p style={{ color: "#6b7280" }}>
        {profile.nickname ?? profile.phoneNumber} · Next review: {profile.nextVisitAt ? new Date(profile.nextVisitAt).toLocaleDateString("en-GB") : "Not set"}
      </p>

      {profile.medications?.baseline && profile.medications.baseline.length > 0 && (
        <section style={{ marginBottom: "1.5rem" }}>
          <h2>Medications</h2>
          <ul>
            {profile.medications.baseline.map((med, idx) => (
              <li key={idx}>{med.name}</li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Recent observations</h2>
        {data.observations.length === 0 ? (
          <p>No observations yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {data.observations.map((obs) => (
              <li
                key={obs.id}
                style={{
                  background: "#fff",
                  borderRadius: 8,
                  padding: "0.75rem 1rem",
                  marginBottom: "0.5rem",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                }}
              >
                <strong>{obs.concept}</strong> · {String(obs.value)}
                <br />
                <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
                  {new Date(obs.timestamp).toLocaleString("en-GB")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Cycles</h2>
        {data.cycles.map((cycle) => (
          <div
            key={cycle.id}
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: "1rem",
              marginBottom: "1rem",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
            }}
          >
            <p>
              <strong>Status:</strong> {cycle.status} · <strong>Started:</strong>{" "}
              {new Date(cycle.startedAt).toLocaleDateString("en-GB")}
            </p>
            <p>Check-ins: {cycle.checkIns.length}</p>
            <p>Observations: {cycle.observations.length}</p>
          </div>
        ))}
      </section>

      <footer style={{ fontSize: "0.85rem", color: "#6b7280", borderTop: "1px solid #e5e7eb", paddingTop: "1rem", marginTop: "2rem" }}>
        <p>These records are based on your reported information only.</p>
        <p>If you&apos;re having severe breathing problems, call 999 or follow your asthma action plan.</p>
      </footer>
    </main>
  );
}
