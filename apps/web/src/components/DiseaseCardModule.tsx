export interface Module {
  id: string;
  title: string;
  type: string;
  content: unknown;
  confidence?: number;
}

export function ModuleContent({ module }: { module: Module }) {
  if (module.type === "headline" || module.type === "safety") {
    return <p>{String(module.content)}</p>;
  }

  if (module.type === "control_status") {
    const content = module.content as { status: string; reason: string };
    return (
      <>
        <StatusBadge status={content.status} />
        <p>{content.reason}</p>
      </>
    );
  }

  if (module.type === "symptom_trend" || module.type === "medication" || module.type === "subjective") {
    const content = module.content as { latest: unknown; values?: unknown[] };
    return (
      <>
        <p>
          <strong>Latest:</strong> {String(content.latest)}
        </p>
        {content.values && content.values.length > 1 && (
          <p>
            <strong>History:</strong> {content.values.map(String).join(" → ")}
          </p>
        )}
      </>
    );
  }

  if (module.type === "triggers" || module.type === "questions") {
    const items = Array.isArray(module.content) ? module.content : [];
    return (
      <ul>
        {items.map((item, idx) => (
          <li key={idx}>{String(item)}</li>
        ))}
      </ul>
    );
  }

  return <pre>{JSON.stringify(module.content, null, 2)}</pre>;
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    "Well controlled": { bg: "#d1fae5", color: "#065f46" },
    "Needs attention": { bg: "#fef3c7", color: "#92400e" },
    Unstable: { bg: "#fee2e2", color: "#991b1b" },
  };
  const style = colors[status] ?? { bg: "#f3f4f6", color: "#374151" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.25rem 0.75rem",
        borderRadius: 9999,
        background: style.bg,
        color: style.color,
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}
