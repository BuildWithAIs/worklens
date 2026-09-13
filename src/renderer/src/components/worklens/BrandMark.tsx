/** Uses the same focus-frame geometry as build/icon.svg. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path
        d="M18 7H9L7 9v9M46 7h9l2 2v9M7 46v9l2 2h9M57 46v9l-2 2h-9"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="butt"
      />
      <path d="m15 22 8 23 9-18 9 18 8-23" stroke="currentColor" strokeWidth="5" strokeLinejoin="round" />
    </svg>
  );
}
