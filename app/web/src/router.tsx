// Minimal client-side routing: three routes do not justify a router dependency.
// The server already falls back to index.html for unknown paths.

import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

export type Route = "/" | "/app" | "/security";

const ROUTES: Route[] = ["/", "/app", "/security"];

const TITLES: Record<Route, string> = {
  "/": "PanicButton · Emergency exits for dreamDEX Perps",
  "/app": "Terminal · PanicButton",
  "/security": "Security · PanicButton",
};

function current(): Route | null {
  const p = window.location.pathname.replace(/\/+$/, "") || "/";
  return (ROUTES as string[]).includes(p) ? (p as Route) : null;
}

export function navigate(to: string) {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route | null {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const onPop = () => {
      setRoute(current());
      const hash = window.location.hash.slice(1);
      const el = hash ? document.getElementById(hash) : null;
      if (el) el.scrollIntoView();
      else window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    document.title = route ? TITLES[route] : "Not found · PanicButton";
  }, [route]);
  return route;
}

/** An anchor that navigates in-app on a plain left click and behaves normally otherwise. */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const path = href.split("#")[0] || "/";
    if (!(ROUTES as string[]).includes(path) || path === window.location.pathname) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
