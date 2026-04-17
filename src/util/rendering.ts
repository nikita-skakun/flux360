import { getIconFont } from "@/util/icon";
import { rgbaString } from "@/util/color";
import type { Color } from "@/util/color";

export const PIN_R = 14;

/**
 * Draws a standardized pin-shaped marker on a 2D canvas.
 * Proportions are derived from the original SVG design.
 */
export function drawPin(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  pinRadius: number,
  iconText: string,
  iconColor: Color,
  darkMode: boolean,
  isSelected = false,
  badgeText: string | null = null
) {
  const bodyHeight = pinRadius * 1.5;
  const headY = tipY - bodyHeight;

  ctx.save();
  ctx.beginPath();

  // Head
  ctx.moveTo(tipX - pinRadius, headY);
  ctx.arc(tipX, headY, pinRadius, Math.PI, 0);

  // Right side curve to tip
  ctx.bezierCurveTo(
    tipX + pinRadius,
    headY + pinRadius * 0.9,
    tipX + pinRadius * 0.35,
    headY + bodyHeight * 0.65,
    tipX,
    tipY
  );

  // Left side curve from tip
  ctx.bezierCurveTo(
    tipX - pinRadius * 0.35,
    headY + bodyHeight * 0.65,
    tipX - pinRadius,
    headY + pinRadius * 0.9,
    tipX - pinRadius,
    headY
  );

  ctx.closePath();

  // Background
  ctx.fillStyle = darkMode ? "rgb(40,40,40)" : "rgb(255,255,255)";
  ctx.fill();

  // Outline
  ctx.lineWidth = isSelected ? 3 : 2;
  ctx.strokeStyle = rgbaString(iconColor, 0.7);
  ctx.lineJoin = "round";
  ctx.stroke();

  // Icon
  if (iconText) {
    ctx.save();
    ctx.fillStyle = rgbaString(iconColor, 1);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = getIconFont(iconText, pinRadius);
    ctx.fillText(String(iconText), tipX, headY + 1);
    ctx.restore();
  }

  // Cluster Badge
  if (badgeText) {
    const badgeRadius = 10;
    const bx = tipX + pinRadius * 0.75;
    const by = headY + pinRadius * 0.6;
    ctx.beginPath();
    ctx.fillStyle = darkMode ? "rgb(30,30,30)" : "rgb(230, 230, 230)";
    ctx.arc(bx, by, badgeRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = darkMode ? "rgb(255,255,255)" : "rgb(0,0,0)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(badgeRadius)}px -apple-system, system-ui, Arial`;
    ctx.fillText(String(badgeText), bx, by);
  }

  ctx.restore();
}
