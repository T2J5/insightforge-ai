import { describe, expect, it } from "vitest";

import { classifySourceQuality } from "./source-quality";

describe("classifySourceQuality", () => {
  it.each([
    ["https://openai.com/research", ["openai.com"], "official", 1],
    ["https://investor.openai.com/report", ["openai.com"], "official", 1],
    ["https://www.reuters.com/technology/story", [], "trusted_news", 0.8],
    ["https://medium.com/@author/opinion", [], "secondary", 0.5],
    ["https://unknown.example.org/post", [], "unknown", 0.25],
  ] as const)(
    "classifies %s deterministically",
    (url, officialDomains, category, priorityScore) => {
      expect(classifySourceQuality({ url, officialDomains })).toEqual(
        expect.objectContaining({ category, priorityScore }),
      );
    },
  );

  it("does not treat a suffix-confusion hostname as official", () => {
    expect(
      classifySourceQuality({
        url: "https://openai.com.attacker.example/report",
        officialDomains: ["openai.com"],
      }).category,
    ).toBe("unknown");
  });
});
