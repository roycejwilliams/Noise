// Shared sidebar nav — every one of the 5 pages calls renderSidebar(page)
// once, first thing, from its own entry file. Not a shared.ts export:
// shared.ts is a library of pure rendering helpers that take a container
// the *page* already owns; this owns a whole structural region of every
// page (brand + primary nav), closer to "a 6th thing every entry file
// bootstraps." Never a build:client esbuild entry point itself — picked up
// transitively via import, same as shared.ts is today.

export type SidebarPage = "dashboard" | "call" | "phone" | "results" | "prompt";

type NavItem = {
  key: SidebarPage;
  href: string;
  label: string;
  icon: string;
};

const ICONS = {
  dashboard: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  // Same handset path as the real call button in call.html — this nav item
  // links to the same feature, so it should read as the same glyph.
  call: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6.6 10.8c1.5 3 3.9 5.4 6.9 6.9l2.3-2.3c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V21c0 .6-.4 1-1 1C10.1 22 2 13.9 2 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.2 1.1L6.6 10.8z"/></svg>`,
  // Deliberately distinct from the call glyph above — this is the
  // Twilio-bridged real-phone flow, not the browser-mic call.
  phone: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>`,
  results: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="20" x2="4" y2="14"/><line x1="10" y1="20" x2="10" y2="10"/><line x1="16" y1="20" x2="16" y2="4"/></svg>`,
  prompt: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>`,
};

const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", href: "/checklist", label: "Dashboard", icon: ICONS.dashboard },
  { key: "call", href: "/call", label: "Browser call", icon: ICONS.call },
  { key: "phone", href: "/phone", label: "Phone test", icon: ICONS.phone },
  { key: "results", href: "#", label: "Results", icon: ICONS.results },
  { key: "prompt", href: "/prompt", label: "Prompt", icon: ICONS.prompt },
];

export function renderSidebar(active: SidebarPage): void {
  const container = document.getElementById("sidebar");
  if (!container) return;

  const navHtml = NAV_ITEMS.map((item) => {
    const isActive = item.key === active;
    // Results has no bare route (server.ts only serves it at
    // /call/:sessionId/results) — render it as an inert, non-clickable
    // item unless it's already the active page, rather than link to a
    // 404. Don't "fix" this into a real link without also adding the route.
    if (item.key === "results" && !isActive) {
      return `
        <span class="sidebar-item sidebar-item-inert" title="Reached via a results link after a call/text, not directly">
          <span class="sidebar-item-icon">${item.icon}</span>
          <span class="sidebar-item-label">${item.label}</span>
        </span>
      `;
    }
    return `
      <a class="sidebar-item${isActive ? " active" : ""}" href="${item.href}">
        <span class="sidebar-item-icon">${item.icon}</span>
        <span class="sidebar-item-label">${item.label}</span>
      </a>
    `;
  }).join("");

  const brandMark = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12.5 9.5 18 20 6"/></svg>`;

  container.innerHTML = `
    <div class="sidebar-brand">
      <span class="sidebar-brand-mark">${brandMark}</span>
      <span>Co (test)</span>
    </div>
    <nav class="sidebar-nav">${navHtml}</nav>
  `;

  // Off-canvas drawer toggle — only visible/relevant at the <=430px
  // breakpoint (styles.css), where .sidebar becomes position:fixed and
  // off-screen by default. Injected into .app-header rather than the
  // sidebar itself, since it needs to stay reachable while the drawer is
  // closed. Same class-toggle-driven transition idiom as
  // .transcript-panel.collapsed elsewhere in this codebase.
  const header = document.querySelector(".app-header");
  if (header && !document.getElementById("sidebar-toggle")) {
    const toggle = document.createElement("button");
    toggle.id = "sidebar-toggle";
    toggle.className = "sidebar-toggle";
    toggle.setAttribute("aria-label", "Toggle navigation");
    toggle.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
    toggle.addEventListener("click", () => container.classList.toggle("open"));
    header.insertBefore(toggle, header.firstChild);
  }
}
