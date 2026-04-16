export function shouldUseMaterialSymbols(emoji: string): boolean {
  return emoji.length > 1;
}

export function getEmojiFont(emoji: string, fontSizeNumber: number): string {
  if (shouldUseMaterialSymbols(emoji)) {
    return `${fontSizeNumber}px 'Material Symbols Outlined', -apple-system, system-ui, Arial`;
  }
  return `600 ${fontSizeNumber}px -apple-system, system-ui, Arial`;
}

export function getEmojiClassName(emoji: string): string {
  return shouldUseMaterialSymbols(emoji) ? "material-symbols-outlined" : "";
}

export function getEmojiStyle(emoji: string, color: string, fontSize: number): React.CSSProperties {
  if (shouldUseMaterialSymbols(emoji)) {
    return { color, fontSize };
  }
  return { color, fontSize: `${fontSize}px`, fontWeight: "600" };
}
