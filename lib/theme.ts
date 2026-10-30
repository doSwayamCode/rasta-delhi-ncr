"use client";

import { useEffect, useState } from "react";
import { THEME_KEY as KEY } from "./theme-boot";

/** "auto" follows the device; the choice is kept on this device only. */
export type ThemeMode = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

const EVENT = "rasta-theme";

function readMode(): ThemeMode {
  try {
    const m = localStorage.getItem(KEY);
    return m === "light" || m === "dark" ? m : "auto";
  } catch {
    return "auto";
  }
}

function resolve(mode: ThemeMode): Theme {
  if (mode !== "auto") return mode;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function setThemeMode(mode: ThemeMode) {
  try {
    if (mode === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  document.documentElement.dataset.theme = resolve(mode);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

/** Current mode and the theme it resolves to, kept in sync with the toggle and the OS setting. */
export function useTheme(): { mode: ThemeMode; theme: Theme } {
  const [state, setState] = useState<{ mode: ThemeMode; theme: Theme }>({ mode: "auto", theme: "dark" });
  useEffect(() => {
    const sync = (mode = readMode()) => {
      const theme = resolve(mode);
      document.documentElement.dataset.theme = theme;
      setState({ mode, theme });
    };
    sync();
    const onToggle = (e: Event) => sync((e as CustomEvent<ThemeMode>).detail);
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onSystem = () => readMode() === "auto" && sync("auto");
    window.addEventListener(EVENT, onToggle);
    mq.addEventListener("change", onSystem);
    return () => {
      window.removeEventListener(EVENT, onToggle);
      mq.removeEventListener("change", onSystem);
    };
  }, []);
  return state;
}
