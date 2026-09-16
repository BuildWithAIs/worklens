// 200 lines fit below Pi read's 50 KiB byte limit, including multibyte text.
export function readableLines(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const chunks: string[] = [];
    let chunk = "";
    let bytes = 0;
    for (const character of line) {
      const size = Buffer.byteLength(character);
      if (bytes + size > 200) {
        chunks.push(chunk);
        chunk = "";
        bytes = 0;
      }
      chunk += character;
      bytes += size;
    }
    chunks.push(chunk);
    return chunks;
  });
}
