import { useEffect, useRef, useState } from "react";
import { Wordmark } from "./brand";
import { Link } from "./router";

const NAV = [
  { href: "/#problem", label: "Why" },
  { href: "/#how", label: "How it works" },
  { href: "/#trust", label: "Verification" },
  { href: "/security", label: "Security" },
];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    const onResize = () => window.innerWidth > 860 && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <header className={`site-nav${open ? " is-open" : ""}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="site-nav-inner">
        <Link href="/" className="nav-brand" aria-label="PanicButton home">
          <Wordmark />
        </Link>
        <nav aria-label="Primary" className="nav-links">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href}>
              {n.label}
            </Link>
          ))}
        </nav>
        <Link href="/app" className="btn btn-primary btn-sm nav-cta">
          Open PanicButton
        </Link>
        <button
          ref={toggle}
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
          <span className="nav-toggle-bars" aria-hidden />
        </button>
      </div>
      <nav id="mobile-menu" aria-label="Mobile" className="mobile-menu" hidden={!open}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} onClick={() => setOpen(false)}>
            {n.label}
          </Link>
        ))}
        <Link href="/app" className="btn btn-primary btn-lg" onClick={() => setOpen(false)}>
          Open PanicButton <span className="arrow">→</span>
        </Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="site-foot-inner">
        <div className="foot-brand">
          <Wordmark />
          <p className="muted small">Emergency exits for dreamDEX perpetual positions. Prepared, confirmed, verified.</p>
        </div>
        <nav aria-label="Footer" className="foot-cols">
          <div>
            <h2 className="foot-h">Product</h2>
            <Link href="/app">Terminal</Link>
            <Link href="/#how">How it works</Link>
            <Link href="/#trust">Verification</Link>
          </div>
          <div>
            <h2 className="foot-h">Trust</h2>
            <Link href="/security">Security model</Link>
            <Link href="/security#limits">Known limitations</Link>
            <Link href="/security#telegram">Telegram linking</Link>
          </div>
        </nav>
      </div>
      <div className="foot-legal">
        <p className="small muted">
          Hideki testnet (chain 50383) only. PanicButton never asks for your wallet key. It signs with a dedicated bot key you authorize in
          dreamDEX and can remove at any time. That key cannot withdraw, but the protocol does not limit it to closing. Nothing here is
          financial advice.
        </p>
      </div>
    </footer>
  );
}
