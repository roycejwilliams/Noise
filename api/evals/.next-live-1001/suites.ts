export async function loadSuite(s: string): Promise<any[]> {
  switch (s) {
    case "delivery": return (await import("./suite-delivery.js")).delivery;
    case "matching": return (await import("./suite-matching.js")).matching;
    case "events": return (await import("./suite-events.js")).events;
    case "loops": return (await import("./suite-loops.js")).loops;
    case "onboarding": return (await import("./suite-onboarding.js")).onboarding;
    case "search": return (await import("./suite-search.js")).search;
    case "context": return (await import("./suite-context.js")).context;
    case "tiers": return (await import("./suite-tiers.js")).tiers;
  }
  throw new Error(`unknown suite ${s}`);
}
