export function shouldUseMaterialSymbols(icon: string): boolean {
  return icon.length > 1;
}

export function getIconFont(icon: string, fontSizeNumber: number): string {
  if (shouldUseMaterialSymbols(icon)) {
    return `${fontSizeNumber}px 'Material Symbols Outlined', -apple-system, system-ui, Arial`;
  }
  return `600 ${fontSizeNumber}px -apple-system, system-ui, Arial`;
}

export function getIconClassName(icon: string): string {
  return shouldUseMaterialSymbols(icon) ? "material-symbols-outlined" : "";
}

export function getIconStyle(icon: string, color: string, fontSize: number): React.CSSProperties {
  if (shouldUseMaterialSymbols(icon)) {
    return { color, fontSize };
  }
  return { color, fontSize: `${fontSize}px`, fontWeight: "600" };
}
