import { getColorForDevice } from "@/util/color";
import { getEmojiClassName, getEmojiStyle } from "@/util/emoji";
import React from "react";
import type { AppDevice, DevicePoint } from "@/types";

type ClusterPopupProps = {
  x: number;
  y: number;
  items: DevicePoint[];
  animationState: 'idle' | 'entering' | 'visible' | 'exiting';
  onClose: () => void;
  onSelectDevice: (id: number) => void;
  darkMode: boolean;
  entities: Record<number, AppDevice>;
};

export const ClusterPopup = React.memo(({
  x, y, items, animationState, onClose, onSelectDevice,
  darkMode, entities
}: ClusterPopupProps) => {
  const CLUSTER_ANIM_MS = 150;
  const ITEM_STAGGER_MS = 60;

  const backdropStyle: React.CSSProperties = {
    position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
    background: 'transparent',
    transition: `opacity ${CLUSTER_ANIM_MS}ms ${animationState === 'exiting' ? 'ease-in' : 'cubic-bezier(0.16,1,0.3,1)'}`,
  };

  const anchorScale = animationState === 'entering' ? 0.6 : 1;
  const anchorStyle: React.CSSProperties = {
    position: 'absolute', left: `${x}px`, top: `${y}px`,
    width: 14, height: 14, borderRadius: 9999, background: 'rgba(0,0,0,0.06)',
    opacity: animationState === 'entering' ? 0 : (animationState === 'visible' ? 1 : 0),
    transformOrigin: 'center', transition: `transform ${CLUSTER_ANIM_MS}ms cubic-bezier(0.2,1.1,0.22,1), opacity ${CLUSTER_ANIM_MS}ms ease`,
    transform: `translate(-50%, -50%) scale(${anchorScale})`
  };

  const baseStyle: React.CSSProperties = {
    position: 'absolute', left: `${x}px`, top: `${y}px`, transform: 'translate(-50%, -56%)', opacity: 1,
    transition: `opacity ${CLUSTER_ANIM_MS}ms ease, transform ${CLUSTER_ANIM_MS}ms cubic-bezier(0.16,1,0.3,1)`
  };

  if (animationState === 'entering') {
    baseStyle.opacity = 0;
    baseStyle.transform = 'translate(-50%, -46%) scale(0.98)';
  } else if (animationState === 'exiting') {
    baseStyle.opacity = 0;
    baseStyle.transform = 'translate(-50%, -66%) scale(0.98)';
    baseStyle.transition = `opacity ${CLUSTER_ANIM_MS}ms ease-in, transform ${CLUSTER_ANIM_MS}ms ease-in`;
  }

  return (
    <>
      <div className="pointer-events-auto z-[1001]" style={backdropStyle} onClick={onClose} />
      <div style={anchorStyle} className="pointer-events-none z-[1002]" />

      <div
        className="pointer-events-auto z-[1002]"
        style={baseStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ position: 'relative', width: 0, height: 0 }}>
          {items.filter(Boolean).map((it, i) => {
            const n = items.length;
            const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
            const radius = Math.max(33, 18 + n * 5);
            const left = Math.round(radius * Math.cos(angle));
            const top = Math.round(radius * Math.sin(angle));

            const entity = entities[it.device];
            const col: [number, number, number] = getColorForDevice(it.device, entity?.color ?? '#3b82f6');
            const colorStr = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
            const borderColorStr = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.7)`;

            const enterDelay = i * ITEM_STAGGER_MS;
            let itemOpacity = 0;
            let itemScale = 1;
            let delay = enterDelay;
            if (animationState === 'entering') {
              itemScale = 0.6;
            } else if (animationState === 'visible') {
              itemOpacity = 1;
              itemScale = 1;
            } else if (animationState === 'exiting') {
              itemScale = 0.85;
              delay = (n - i - 1) * ITEM_STAGGER_MS;
            }

            const innerStyle: React.CSSProperties = {
              transform: `scale(${itemScale})`,
              opacity: itemOpacity,
              transition: `transform 360ms cubic-bezier(0.2,1.1,0.22,1) ${delay}ms, opacity 220ms ease ${delay}ms`,
              willChange: 'transform, opacity'
            };

            return (
              <div key={`${it.device}-${i}`} style={{ position: 'absolute', left: `${left}px`, top: `${top}px`, transform: 'translate(-50%, -50%)' }}>
                <div
                  // PIN_R = 14 in createPinImage → circle diameter = 28 px at icon-size 1
                  className="rounded-full shadow flex items-center justify-center cursor-pointer hover:scale-110 border-2"
                  style={{ ...innerStyle, width: 28, height: 28, backgroundColor: darkMode ? 'rgb(40,40,40)' : 'rgb(255,255,255)', borderColor: borderColorStr }}
                  onClick={(e) => { e.stopPropagation(); onSelectDevice(it.device); onClose(); }}
                  title={entity?.name ?? String(it.device)}
                >
                  <span className={`${getEmojiClassName(entity?.emoji ?? "")} select-none`} style={{ ...getEmojiStyle(entity?.emoji ?? "", colorStr, 14), lineHeight: 1, WebkitUserSelect: 'none', MozUserSelect: 'none', msUserSelect: 'none' }}>{entity?.emoji ?? String(it.device).charAt(0).toUpperCase()}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
});
