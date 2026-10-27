import { describe, expect, it } from "vitest";
import { metricsFromEvents, seededEvents, groupFeedback } from "./domain";

describe("synthetic product simulator", () => {
  it("reproduces the same run when seed and market are unchanged", () => {
    const market = { latency: 2, errors: 1, onboarding: 2, price: 1 };
    const start = new Date("2026-10-01T00:00:00.000Z");
    expect(seededEvents("run", 35, 74121, market, start)).toEqual(seededEvents("run", 35, 74121, market, start));
  });
  it("derives funnel metrics from successful persisted events", () => {
    const events = seededEvents("run", 35, 74121, { latency: 2, errors: 1, onboarding: 2, price: 1 });
    const metrics = metricsFromEvents(events);
    expect(metrics.visitors).toBe(35);
    expect(metrics.signups).toBeLessThanOrEqual(metrics.visitors);
    expect(metrics.activated).toBeLessThanOrEqual(metrics.signups);
    expect(metrics.converted).toBeLessThanOrEqual(metrics.activated);
    expect(metrics.errors).toBeGreaterThanOrEqual(0);
  });
  it("responds to harder onboarding and groups feedback by affected agent", () => {
    const easy = seededEvents("easy", 120, 75, { latency: 0, errors: 0, onboarding: 0, price: 0 });
    const hard = seededEvents("hard", 120, 75, { latency: 0, errors: 0, onboarding: 5, price: 0 });
    expect(metricsFromEvents(hard).activated).toBeLessThan(metricsFromEvents(easy).activated);
    const reports = groupFeedback(seededEvents("broken", 80, 4, { latency: 4, errors: 5, onboarding: 5, price: 0 }));
    expect(reports.some((r) => r.category === "Errores funcionales")).toBe(true);
    expect(reports.every((r) => r.frequency <= 80)).toBe(true);
  });
});
