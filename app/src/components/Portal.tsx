"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Render outside the tree, at the end of `<body>`.
 *
 * Not a nicety. The nav bar carries `backdrop-filter`, and a filter of any kind makes an
 * element the containing block for `position: fixed` descendants — so an overlay opened
 * from the wallet button was being positioned against the bar rather than the window, and
 * appeared trapped inside it. Every overlay this app opens from the chrome goes through
 * here.
 */
export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  // There is no document during the static export, so nothing renders until the client
  // takes over.
  useEffect(() => setMounted(true), []);

  return mounted ? createPortal(children, document.body) : null;
}
