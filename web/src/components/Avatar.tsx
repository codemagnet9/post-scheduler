// src/components/Avatar.tsx
// The ported .av chip — a coloured circle (or rounded square) with monospace initials. Used for
// workspaces (square) and people (round) in the shell.
const PALETTE = ['#6B57C9', '#2C7355', '#B0623A', '#8A6216', '#0FA189', '#CC5B86', '#7F5BE0', '#C4831C'];

// Deterministic colour from a string, so the same workspace/person keeps its colour.
function colourFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) & 0xffffffff;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, seed, size = 30, square = false, color }: { name: string; seed?: string; size?: number; square?: boolean; color?: string }): JSX.Element {
  return (
    <span
      className={`av${square ? ' av-sq' : ''}`}
      style={{ width: size, height: size, background: color ?? colourFor(seed ?? name), fontSize: Math.round(size * 0.36) }}
    >
      {initialsOf(name)}
    </span>
  );
}
