// Case-insensitive matching that keeps UTF-16 offsets, so a match found in
// folded text maps back onto the original string and onto DOM text nodes.
export function foldSearchText(text: string) {
  let result = "";
  for (const character of text) {
    const lower = character.toLowerCase();
    result += lower.length === character.length ? lower : character;
  }
  return result;
}

/** Index of the first match of an already folded needle, or -1. */
export function findSearchMatch(text: string, needle: string) {
  return needle ? foldSearchText(text).indexOf(needle) : -1;
}
