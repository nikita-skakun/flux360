import { colorForDevice } from "./color";
import { createPortal } from "react-dom";
import { EMOJI_OPTIONS } from "./constants";
import { HexColorPicker } from "react-colorful";
import { useStore } from "@/store";
import React, { useState, useEffect, useRef } from "react";
import type { MotionProfileName } from "@/types";

type Props = {
    isOpen: boolean;
    onClose: () => void;
    type: "device" | "group";
    id: number;
};

const UnifiedEditModal: React.FC<Props> = ({ isOpen, onClose, type, id }) => {
    const device = useStore((state) => state.devices[id]);
    const group = useStore((state) => state.groups.find((g) => g.id === id));
    const updateDevice = useStore((state) => state.updateDevice);
    const updateGroup = useStore((state) => state.updateGroup);

    const target = type === "device" ? device : group;

    const [name, setName] = useState("");
    const [emoji, setEmoji] = useState("");
    const [color, setColor] = useState<string | null>(null);
    const [motionProfile, setMotionProfile] = useState<MotionProfileName | null>(null);

    const [isLoading, setIsLoading] = useState(false);
    const [showColorPicker, setShowColorPicker] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [popoverPos, setPopoverPos] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 });

    useEffect(() => {
        if (showColorPicker && triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const height = 240; // Approx height of picker

            if (spaceBelow < height) {
                setPopoverPos({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
            } else {
                setPopoverPos({ left: rect.left, top: rect.bottom + 8 });
            }
        }
    }, [showColorPicker]);

    // Calculate default color
    const rgb = colorForDevice(id);
    const defaultHex = `#${rgb[0].toString(16).padStart(2, '0')}${rgb[1].toString(16).padStart(2, '0')}${rgb[2].toString(16).padStart(2, '0')}`;

    useEffect(() => {
        if (isOpen && target) {
            setName(target.name);
            setEmoji(target.emoji);
            setColor(target.color);
            setMotionProfile(target.motionProfile);
        }
    }, [isOpen, target, type, id]);

    if (!isOpen || !target) return null;

    const handleSave = async () => {
        setIsLoading(true);
        try {
            const action = type === "device" ? updateDevice : updateGroup;
            await action(id, {
                name,
                emoji,
                color,
                motionProfile,
            });
            onClose();
        } catch (e) {
            console.error("Failed to update", e);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50" onClick={onClose} />
            <div className="relative bg-background text-foreground rounded-lg shadow-xl w-full max-w-md flex flex-col p-6 gap-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold">Edit {type === "device" ? "Device" : "Group"}</h2>
                    <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted text-2xl leading-none pb-1" aria-label="Close modal">×</button>
                </div>

                <div className="space-y-4">
                    {/* Identity Section */}
                    <div className="bg-muted/30 rounded-lg p-4 space-y-3">
                        <div className="flex items-center gap-3">
                            {/* Color Swatch */}
                            <div className="relative shrink-0">
                                <button
                                    ref={triggerRef}
                                    className="relative w-12 h-12 p-0 rounded-full border-2 shadow-sm transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                                    style={{ backgroundColor: color ?? defaultHex }}
                                    onClick={() => setShowColorPicker(!showColorPicker)}
                                    disabled={isLoading}
                                >
                                    {color === null && (
                                        <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white drop-shadow-md">Auto</div>
                                    )}
                                </button>
                                {showColorPicker && createPortal(
                                    <div className="fixed inset-0 z-[9999] isolate border-0">
                                        <div className="fixed inset-0" onClick={() => setShowColorPicker(false)} />
                                        <div
                                            className="fixed z-[10000] bg-background p-2 rounded-lg shadow-xl flex flex-col gap-2"
                                            style={{
                                                left: popoverPos.left,
                                                top: popoverPos.top,
                                                bottom: popoverPos.bottom
                                            }}
                                        >
                                            <HexColorPicker color={color ?? defaultHex} onChange={setColor} />
                                            <button
                                                onClick={() => {
                                                    setColor(null);
                                                    setShowColorPicker(false);
                                                }}
                                                className={`text-xs w-full py-1.5 rounded border transition-colors ${color === null
                                                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 border-blue-200 dark:border-blue-800 font-medium"
                                                    : "text-muted-foreground hover:bg-muted/50 border border-border"
                                                    }`}
                                            >
                                                Use Auto Color
                                            </button>
                                        </div>
                                    </div>,
                                    document.body
                                )}
                            </div>
                            {/* Name Input */}
                            <input
                                type="text"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="Name"
                                className="flex-1 border border-border rounded px-3 py-2 disabled:opacity-50 bg-background text-foreground"
                                disabled={isLoading}
                            />
                        </div>

                        {/* Icon Picker */}
                        <div className="flex flex-wrap gap-1.5 justify-center">
                            {EMOJI_OPTIONS.map(opt => (
                                <button
                                    key={opt}
                                    onClick={() => setEmoji(opt)}
                                    className={`w-9 h-9 flex items-center justify-center rounded hover:bg-background text-lg transition-all ${emoji === opt ? 'bg-background shadow ring-1 ring-blue-500' : ''}`}
                                    disabled={isLoading}
                                >
                                    <span className="material-symbols-outlined text-lg leading-none text-foreground">{opt}</span>
                                </button>
                            ))}
                        </div>
                        <input
                            type="text"
                            placeholder="Or type icon name (material symbols)"
                            value={emoji}
                            onChange={e => setEmoji(e.target.value)}
                            className="w-full text-xs border border-border rounded px-2 py-1 bg-background text-foreground"
                            disabled={isLoading}
                        />
                    </div>

                    {/* Motion Profile Section */}
                    <div className="bg-muted/30 rounded-lg p-4">
                        <label className="block text-sm font-medium mb-2">Motion Profile</label>
                        <div className="flex gap-2 w-full">
                            {[
                                { label: type === 'device' ? "Default (Person)" : "Auto", value: null },
                                { label: "Person", value: "person" },
                                { label: "Car", value: "car" }
                            ].map(opt => (
                                <button
                                    key={String(opt.value)}
                                    onClick={() => setMotionProfile(opt.value as MotionProfileName | null)}
                                    className={`py-2 px-3 rounded border text-sm font-medium transition-colors flex-auto ${motionProfile === opt.value
                                        ? "bg-blue-600 text-white border-blue-600"
                                        : "bg-background text-foreground hover:bg-muted/50 border-border"
                                        }`}
                                    disabled={isLoading}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                </div>

                <div className="flex justify-end gap-2 mt-2">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 rounded text-muted-foreground hover:bg-muted text-foreground"
                        disabled={isLoading}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => void handleSave()}
                        className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                        disabled={isLoading}
                    >
                        {isLoading ? "Saving..." : "Save Changes"}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default UnifiedEditModal;
