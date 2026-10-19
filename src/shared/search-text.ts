// Case-insensitive matching that keeps UTF-16 offsets, so a match found in
// folded text maps back onto the original string and onto DOM text nodes.
export function foldSearchText(text: string): string {
  // Native lowercasing at native speed, kept to the per-character fold. Only
  // İ lowercases longer, so it is kept as is, and only Σ depends on its
  // neighbours, so it is always σ. No other character lowercases to another
  // length.
  if (text.includes("İ")) return text.split("İ").map(foldSearchText).join("İ");
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return foldEach(text);
  let result = "";
  let from = 0;
  for (let at = text.indexOf("Σ"); at >= 0; at = text.indexOf("Σ", at + 1)) {
    result += `${lower.slice(from, at)}σ`;
    from = at + 1;
  }
  return from ? result + lower.slice(from) : lower;
}

// Each character lowercased alone, unless that moves offsets.
function foldEach(text: string) {
  let result = "";
  for (const character of text) {
    const folded = character.toLowerCase();
    result += folded.length === character.length ? folded : character;
  }
  return result;
}

/** Index of the first match of an already folded needle, or -1. */
export function findSearchMatch(text: string, needle: string) {
  return needle ? foldSearchText(text).indexOf(needle) : -1;
}
