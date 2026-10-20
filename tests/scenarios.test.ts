import { expect, test } from "bun:test";
import { scenarios, scenarioOptions } from "../src/scenarios";

test("scenario catalog has unique choices, valid destinations and editable multi-step goals", () => {
  const choices = scenarios(new Date("2026-12-20T23:59:59Z"));
  expect(new Set(choices.map((item) => item.id)).size).toBe(choices.length);
  expect(
    choices.filter((item) => item.group === "Google Flights"),
  ).toHaveLength(4);
  expect(
    choices.filter((item) => item.group === "Practice websites"),
  ).toHaveLength(4);
  expect(
    choices.filter((item) => item.group === "Research on real websites"),
  ).toHaveLength(7);
  for (const item of choices.filter((item) => item.id !== "custom")) {
    expect(item.goal.length).toBeGreaterThan(20);
    expect(item.goal.length).toBeLessThanOrEqual(2000);
    expect(new URL(item.url, "http://127.0.0.1:8766").protocol).toMatch(
      /^https?:$/,
    );
  }
  expect(
    choices.find((item) => item.id === "flights-round-trip")!.goal,
  ).toContain("2027-02-03");
  expect(
    choices.find((item) => item.id === "flights-round-trip")!.goal,
  ).toContain("2027-02-10");
  expect(scenarioOptions()).toContain("data-goal=");
  expect(scenarioOptions()).toContain('<optgroup label="Google Flights">');
  expect(scenarioOptions()).toContain('<optgroup label="Practice websites">');
});
