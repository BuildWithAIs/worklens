export const RENAME_LIMIT = 60;
const DISPLAY_LIMIT = 23;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function titleCharacters(title: string) {
  return Array.from(segmenter.segment(title), ({ segment }) => segment);
}

export function shortTitle(title: string) {
  const characters = titleCharacters(title);
  return characters.length > DISPLAY_LIMIT
    ? `${characters.slice(0, DISPLAY_LIMIT).join("")}…`
    : title;
}
