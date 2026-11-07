import { describe, test, expect } from "vitest";
import { lifeStage, ageOn, formatDate } from "../src/lib/age.js";

const j = { dob: "2026-10-18", due_date: "2026-10-10" };

describe("lifeStage", () => {
  test("pregnancy weeks count 280 days ending on the due date", () => {
    expect(lifeStage("2026-10-10", { due_date: "2026-10-10" }).label).toBe("Pregnancy, week 40");
    expect(lifeStage("2026-01-04", { due_date: "2026-10-10" }).label).toBe("Pregnancy, week 1"); // day 0 = 280 days before
    expect(lifeStage("2026-07-04", { due_date: "2026-10-10" }).label).toBe("Pregnancy, week 26"); // 98 days to go = 14 weeks to go
    expect(lifeStage("2026-06-01", { due_date: "2026-10-10" }).label).toMatch(/^Pregnancy, week \d+$/);
    expect(lifeStage("2025-12-01", { due_date: "2026-10-10" }).label).toBe("Before pregnancy");
  });
  test("a baby born after the due date keeps pregnancy weeks up to 42", () => {
    expect(lifeStage("2026-10-17", j).label).toBe("Pregnancy, week 41");
  });
  test("birth day, early weeks, months, years", () => {
    expect(lifeStage("2026-10-18", j).label).toBe("Birth day");
    expect(lifeStage("2026-10-19", j).label).toBe("Week 1");
    expect(lifeStage("2026-10-25", j).label).toBe("Week 2");
    expect(lifeStage("2027-01-18", j).label).toBe("Month 3");
    expect(lifeStage("2027-01-17", j).label).toBe("Month 2");
    expect(lifeStage("2028-10-18", j).label).toBe("2 years");
    expect(lifeStage("2029-01-20", j).label).toBe("2 years, 3 months");
  });
  test("groups sort chronologically", () => {
    const order = ["2026-08-01", "2026-10-18", "2026-10-30", "2027-03-01", "2029-01-01"].map((d) => lifeStage(d, j).sort);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  test("month arithmetic is safe at month ends and leap days", () => {
    expect(lifeStage("2028-02-29", { dob: "2028-01-31" }).label).toBe("Week 5"); // 29 days
    expect(lifeStage("2028-03-30", { dob: "2028-01-31" }).label).toBe("Month 1");
    expect(lifeStage("2026-03-01", { dob: "2025-12-31" }).label).toBe("Month 2");
  });
  test("no dates at all: a plain journal", () => {
    expect(lifeStage("2026-05-05", {}).label).toBe("Journal");
    expect(lifeStage("garbage", j).label).toBe("Undated");
  });
});

describe("ageOn and formatDate", () => {
  test("child age in plain words", () => {
    expect(ageOn("2026-10-18", j)).toBe("Born today");
    expect(ageOn("2026-10-19", j)).toBe("1 day old");
    expect(ageOn("2026-11-08", j)).toBe("3 weeks old");
    expect(ageOn("2027-02-18", j)).toBe("4 months old");
    expect(ageOn("2026-10-01", j)).toBe("");
  });
  test("a calendar date prints the same day in every time zone", () => {
    expect(formatDate("2026-10-18", "en-GB")).toBe("18 Oct 2026");
  });
});
