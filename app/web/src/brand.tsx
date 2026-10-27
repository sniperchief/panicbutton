// The mark: a market line that breaks down, and the orange exit that leaves it
// horizontally before the fall completes. The same motif runs through the site.

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M6 11 L12 9 L16 14 L21 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" opacity="0.55" />
      <path d="M16 14 H26" fill="none" stroke="var(--orange)" strokeWidth="3" strokeLinecap="square" />
      <rect x="24" y="11" width="5" height="6" fill="var(--orange)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Mark />
      <span className="wordmark-text">
        Panic<span>Button</span>
      </span>
    </span>
  );
}
