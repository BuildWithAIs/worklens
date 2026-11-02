// Same focus-frame geometry as build/icon.svg.
const CORNERS = [
  ["tl", "M18 7H9L7 9v9"],
  ["tr", "M46 7h9l2 2v9"],
  ["bl", "M7 46v9l2 2h9"],
  ["br", "M57 46v9l-2 2h-9"],
] as const;
const LETTER = "m15 22 8 23 9-18 9 18 8-23";

export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={CORNERS.map(([, d]) => d).join("")}
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="butt"
      />
      <path
        d={LETTER}
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * New-chat mark: the frame focuses once on mount, then stays still. Corners
 * are separate paths so each can close in; motion lives in CSS behind
 * reduced-motion.
 */
export function WelcomeMark() {
  return (
    <svg
      className="welcome-mark"
      data-slot="welcome-mark"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      {CORNERS.map(([corner, d]) => (
        <path
          key={corner}
          className="welcome-mark-corner"
          data-corner={corner}
          d={d}
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="butt"
        />
      ))}
      <path
        className="welcome-mark-letter"
        d={LETTER}
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
