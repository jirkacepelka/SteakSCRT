"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Light and dark, remembered.
 *
 * Defaults to whatever the operating system asks for rather than imposing dark, and only
 * pins a choice once the user makes one. The attribute is written to `<html>` so the CSS
 * tokens switch in one place.
 */

type Theme = "dark" | "light";
const KEY = "secret-lst.theme";

const Ctx = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "dark",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = (() => {
      try {
        return window.localStorage.getItem(KEY) as Theme | null;
      } catch {
        return null;
      }
    })();

    const preferred: Theme =
      stored ??
      (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");

    setTheme(preferred);
    document.documentElement.dataset.theme = preferred;
  }, []);

  const toggle = () => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        window.localStorage.setItem(KEY, next);
      } catch {
        // Not persisting is survivable.
      }
      return next;
    });
  };

  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
