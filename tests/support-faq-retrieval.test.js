import assert from "node:assert/strict";
import { test } from "node:test";

import { retrieveFaqs } from "../src/lib/support/knowledge/faq-retrieval.js";

test("retrieval normalizes Unicode, casing, whitespace, and punctuation for exact keywords", () => {
  const faqs = [
    faq({ id: "exact", question: "How do I reset my password?", keywords: ["Reset Password"], priority: 1 }),
    faq({ id: "overlap", question: "Password help", keywords: ["password"], priority: 100 }),
  ];

  const results = retrieveFaqs({ query: "  RESET—password!!  ", faqs });

  assert.deepEqual(results.map((result) => result.id), ["exact", "overlap"]);
  assert.ok(results[0].score > results[1].score);
  assert.deepEqual(Object.keys(results[0]).sort(), ["answer", "category", "id", "question", "score"]);
});

test("retrieval includes category matches, excludes disabled FAQs, and caps results at five", () => {
  const faqs = [
    faq({ id: "disabled", category: "billing", enabled: false, priority: 100 }),
    faq({ id: "category", category: "billing", priority: 2 }),
    faq({ id: "five", category: "billing", priority: 5 }),
    faq({ id: "four", category: "billing", priority: 4 }),
    faq({ id: "three", category: "billing", priority: 3 }),
    faq({ id: "two", category: "billing", priority: 2 }),
    faq({ id: "one", category: "billing", priority: 1 }),
  ];

  const results = retrieveFaqs({ query: "BILLING", faqs, limit: 99 });

  assert.deepEqual(results.map((result) => result.id), ["five", "four", "three", "category", "two"]);
  assert.equal(results.some((result) => result.id === "disabled"), false);
});

test("retrieval uses priority then FAQ id as deterministic score tie breakers", () => {
  const results = retrieveFaqs({
    query: "shipping",
    faqs: [
      faq({ id: "z-low", keywords: ["shipping"], priority: 1 }),
      faq({ id: "b-high", keywords: ["shipping"], priority: 2 }),
      faq({ id: "a-high", keywords: ["shipping"], priority: 2 }),
    ],
  });

  assert.deepEqual(results.map((result) => result.id), ["a-high", "b-high", "z-low"]);
});

test("retrieval returns only matched enabled FAQs and honors a smaller limit", () => {
  const results = retrieveFaqs({
    query: "returns",
    limit: 1,
    faqs: [
      faq({ id: "matched", keywords: ["returns"] }),
      faq({ id: "unmatched", keywords: ["shipping"] }),
    ],
  });

  assert.deepEqual(results.map((result) => result.id), ["matched"]);
});

test("retrieval retains a matched FAQ with negative priority without admitting unmatched priority-only records", () => {
  const results = retrieveFaqs({
    query: "shipping",
    faqs: [
      faq({ id: "negative-match", category: "shipping", priority: -100 }),
      faq({ id: "positive-unmatched", category: "billing", priority: 100 }),
    ],
  });

  assert.deepEqual(results.map((result) => result.id), ["negative-match"]);
});

test("an exact keyword tier outranks repeated token overlap regardless of priority", () => {
  const results = retrieveFaqs({
    query: ["shipping", ...Array.from({ length: 101 }, () => "returns")].join(" "),
    faqs: [
      faq({ id: "exact-shipping", keywords: ["shipping"], priority: -100 }),
      faq({ id: "repeated-returns", question: "Returns policy", priority: 100 }),
    ],
  });

  assert.deepEqual(results.map((result) => result.id), ["exact-shipping", "repeated-returns"]);
});

function faq({
  id,
  question = "General question",
  answer = "General answer",
  category = "general",
  keywords = [],
  enabled = true,
  priority = 0,
}) {
  return { id, question, answer, category, keywords, enabled, priority };
}
