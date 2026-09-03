// src/components/Logo.tsx — ported verbatim from the prototype's LOGO markup.
export function Logo(): JSX.Element {
  return (
    <span className="row" style={{ gap: 9, fontWeight: 700, fontSize: 19, letterSpacing: '-.03em' }}>
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" />
        <ellipse cx="16" cy="16" rx="6" ry="13" stroke="currentColor" strokeWidth="2" opacity=".45" />
        <path d="M3 16h26" stroke="currentColor" strokeWidth="2" opacity=".45" />
        <circle cx="16" cy="6" r="3.2" fill="#FFB23F" />
      </svg>
      Meridian
    </span>
  );
}
