import { Button } from "@/components/ui/button";
import { colorForDevice } from "@/util/color";
import { createPortal } from "react-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { EMOJI_OPTIONS } from "@/util/constants";
import { HexColorPicker } from "react-colorful";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    const deleteGroup = useStore((state) => state.deleteGroup);

    const target = type === "device" ? device : group;

    const [name, setName] = useState("");
    const [emoji, setEmoji] = useState("");
    const [color, setColor] = useState<string | null>(null);
    const [motionProfile, setMotionProfile] = useState<MotionProfileName | null>(null);

    const [isLoading, setIsLoading] = useState(false);
    const [showColorPicker, setShowColorPicker] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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

    const rgb = colorForDevice(id);
    const defaultHex = `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;

    useEffect(() => {
        if (isOpen && target) {
            setName(target.name);
            setEmoji(target.emoji);
            setColor(target.color);
            setMotionProfile(target.motionProfile);
        }
    }, [isOpen, target, type, id]);

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

    const handleDelete = async () => {
        setIsLoading(true);
        try {
            await deleteGroup(id);
            onClose();
        } catch (e) {
            console.error("Failed to delete group", e);
        } finally {
            setIsLoading(false);
            setShowDeleteConfirm(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto z-[3000]">
                <DialogHeader>
                    <DialogTitle>Edit {type === "device" ? "Device" : "Group"}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    {/* Identity Section */}
                    <div className="bg-muted/30 rounded-lg p-4 space-y-3">
                        <div className="flex items-center gap-3">
                            {/* Color Swatch */}
                            <div className="relative shrink-0">
                                <button
                                    ref={triggerRef}
                                    className="relative w-12 h-12 p-0 rounded-full border-2 shadow-sm transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring"
                                    style={{ backgroundColor: color ?? defaultHex }}
                                    onClick={() => setShowColorPicker(!showColorPicker)}
                                    disabled={isLoading}
                                >
                                    {color === null && (
                                        <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white drop-shadow-md">Auto</div>
                                    )}
                                </button>
                                {showColorPicker && createPortal(
                                    <div className="fixed inset-0 z-[9999]" style={{ pointerEvents: 'auto' }}>
                                        <div className="fixed inset-0" onClick={() => setShowColorPicker(false)} />
                                        <div
                                            className="fixed z-[10000] bg-background p-2 rounded-lg shadow-xl flex flex-col gap-2 border border-border"
                                            style={{
                                                left: popoverPos.left,
                                                top: popoverPos.top,
                                                bottom: popoverPos.bottom
                                            }}
                                            onClick={e => e.stopPropagation()}
                                        >
                                            <HexColorPicker color={color ?? defaultHex} onChange={setColor} />
                                            <Button
                                                variant={color === null ? "default" : "outline"}
                                                size="sm"
                                                onClick={() => {
                                                    setColor(null);
                                                    setShowColorPicker(false);
                                                }}
                                                className="w-full text-xs"
                                            >
                                                Use Auto Color
                                            </Button>
                                        </div>
                                    </div>,
                                    document.body
                                )}
                            </div>
                            {/* Name Input */}
                            <Input
                                type="text"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="Name"
                                disabled={isLoading}
                                className="flex-1"
                            />
                        </div>

                        {/* Icon Picker */}
                        <div className="flex flex-wrap gap-1.5 justify-center">
                            {EMOJI_OPTIONS.map(opt => (
                                <Button
                                    key={opt}
                                    variant={emoji === opt ? "default" : "ghost"}
                                    size="icon"
                                    onClick={() => setEmoji(opt)}
                                    disabled={isLoading}
                                    className="w-9 h-9"
                                >
                                    <span className="material-symbols-outlined text-lg leading-none">{opt}</span>
                                </Button>
                            ))}
                        </div>
                        <Input
                            type="text"
                            placeholder="Or type icon name (material symbols)"
                            value={emoji}
                            onChange={e => setEmoji(e.target.value)}
                            disabled={isLoading}
                            className="text-xs"
                        />
                    </div>

                    {/* Motion Profile Section */}
                    <div className="bg-muted/30 rounded-lg p-4">
                        <Label className="block text-sm font-medium mb-2">Motion Profile</Label>
                        <div className="flex gap-2 w-full">
                            {[
                                { label: type === 'device' ? "Default (Person)" : "Auto", value: null },
                                { label: "Person", value: "person" },
                                { label: "Car", value: "car" }
                            ].map(opt => (
                                <Button
                                    key={String(opt.value)}
                                    variant={motionProfile === opt.value ? "default" : "outline"}
                                    onClick={() => setMotionProfile(opt.value as MotionProfileName | null)}
                                    disabled={isLoading}
                                    className="flex-auto"
                                    size="sm"
                                >
                                    {opt.label}
                                </Button>
                            ))}
                        </div>
                    </div>

                </div>

                <DialogFooter>
                    {type === "group" && (
                        <Button
                            variant="destructive"
                            onClick={() => setShowDeleteConfirm(true)}
                            disabled={isLoading}
                            className="mr-auto dark:bg-red-700 dark:hover:bg-red-800"
                        >
                            Delete
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        disabled={isLoading}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={() => void handleSave()}
                        disabled={isLoading}
                    >
                        {isLoading ? "Saving..." : "Save Changes"}
                    </Button>
                </DialogFooter>

                <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
                    <AlertDialogContent className="z-[3001]">
                        <AlertDialogHeader>
                            <AlertDialogTitle>Delete Group</AlertDialogTitle>
                            <AlertDialogDescription>
                                Are you sure you want to delete this group? This action cannot be undone.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogAction variant="destructive" onClick={() => void handleDelete()} disabled={isLoading} className="dark:bg-red-700 dark:hover:bg-red-800">
                                Delete
                            </AlertDialogAction>
                            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </DialogContent>
        </Dialog>
    );
};

export default UnifiedEditModal;
