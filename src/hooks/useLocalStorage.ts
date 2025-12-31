import { useEffect, useState } from "react";

export function useLocalStorageBoolean(key: string, defaultValue: boolean) {
  const [value, setValue] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return defaultValue;
      const v = window.localStorage.getItem(key);
      if (v == null) return defaultValue;
      return v === "1";
    } catch (e) {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(key, value ? "1" : "0");
    } catch (e) {}
  }, [key, value]);

  return [value, setValue] as const;
}
