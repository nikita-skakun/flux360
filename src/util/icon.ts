export function getIconFont(icon: string, fontSizeNumber: number): string {
  if (icon.length > 1) {
    return `${fontSizeNumber}px 'Material Symbols Outlined', -apple-system, system-ui, Arial`;
  }
  return `600 ${fontSizeNumber}px -apple-system, system-ui, Arial`;
}

export function getIconClassName(icon: string): string {
  return icon.length > 1 ? "material-symbols-outlined" : "";
}

export function getIconStyle(icon: string, color: string, fontSize: number): React.CSSProperties {
  if (icon.length > 1) return { color, fontSize };
  return { color, fontSize: `${fontSize}px`, fontWeight: "600" };
}
