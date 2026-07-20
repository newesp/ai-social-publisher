const MAX_RESULTS = 5;
const EXACT_KEYWORD_SCORE = 1_000;
const TOKEN_SCORE = 10;
const CATEGORY_SCORE = 50;

export function retrieveFaqs({ query, faqs, limit = MAX_RESULTS } = {}) {
  const normalizedQuery = normalize(query);
  const queryTokens = tokens(normalizedQuery);
  if (!normalizedQuery || !Array.isArray(faqs)) return [];

  return faqs
    .filter((faq) => faq?.enabled === true && typeof faq.id === "string")
    .map((faq) => ({ faq, ...scoreFaq(faq, normalizedQuery, queryTokens) }))
    .filter(({ matched }) => matched)
    .sort((left, right) => right.score - left.score
      || numericPriority(right.faq) - numericPriority(left.faq)
      || left.faq.id.localeCompare(right.faq.id))
    .slice(0, boundedLimit(limit))
    .map(({ faq, score }) => ({
      id: faq.id,
      question: String(faq.question ?? ""),
      answer: String(faq.answer ?? ""),
      category: String(faq.category ?? ""),
      score,
    }));
}

function scoreFaq(faq, query, queryTokens) {
  const keywords = Array.isArray(faq.keywords) ? faq.keywords.map(normalize).filter(Boolean) : [];
  const exactKeywordScore = keywords
    .filter((keyword) => query.includes(keyword))
    .reduce((total, keyword) => total + tokens(keyword).length, 0) * EXACT_KEYWORD_SCORE;
  const searchableTokens = new Set(tokens([
    faq.question,
    faq.category,
    ...keywords,
  ].map(normalize).join(" ")));
  const overlap = queryTokens.filter((token) => searchableTokens.has(token)).length;
  const categoryTokens = new Set(tokens(normalize(faq.category)));
  const categoryOverlap = queryTokens.some((token) => categoryTokens.has(token));

  const evidenceScore = exactKeywordScore
    + overlap * TOKEN_SCORE
    + (categoryOverlap ? CATEGORY_SCORE : 0);
  return {
    matched: evidenceScore > 0,
    score: evidenceScore + numericPriority(faq),
  };
}

function boundedLimit(value) {
  if (!Number.isInteger(value) || value < 1) return MAX_RESULTS;
  return Math.min(value, MAX_RESULTS);
}

function numericPriority(faq) {
  return Number.isFinite(faq?.priority) ? faq.priority : 0;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return value.split(" ").filter(Boolean);
}
