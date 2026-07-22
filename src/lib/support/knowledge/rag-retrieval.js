const MAX_RESULTS = 5;
const EXACT_KEYWORD_SCORE = 1_000;
const TOKEN_SCORE = 10;
const CATEGORY_SCORE = 50;

export function retrieveRagKnowledge({ query, knowledge, limit = MAX_RESULTS } = {}) {
  const normalizedQuery = normalize(query);
  const queryTokens = [...new Set(tokens(normalizedQuery))];
  if (!normalizedQuery || !Array.isArray(knowledge)) return [];

  return knowledge
    .filter((doc) => doc?.enabled === true && typeof doc.id === "string")
    .map((doc) => ({ doc, ...scoreDoc(doc, normalizedQuery, queryTokens) }))
    .filter(({ matched }) => matched)
    .sort((left, right) => right.tier - left.tier
      || right.score - left.score
      || numericPriority(right.doc) - numericPriority(left.doc)
      || left.doc.id.localeCompare(right.doc.id))
    .slice(0, boundedLimit(limit))
    .map(({ doc, score, matchedTerms }) => ({
      id: doc.id,
      title: String(doc.question ?? ""),
      customerAnswer: String(doc.answer ?? ""),
      category: String(doc.category ?? ""),
      score,
      matchedTerms,
    }));
}

function scoreDoc(doc, query, queryTokens) {
  const keywords = Array.isArray(doc.keywords) ? doc.keywords.map(normalize).filter(Boolean) : [];
  const exactKeywordMatches = keywords.filter((keyword) => (
    query.includes(keyword) || (query.length >= 2 && keyword.includes(query))
  ));
  const exactKeywordScore = exactKeywordMatches
    .reduce((total, keyword) => total + Math.max(1, tokens(keyword).length), 0) * EXACT_KEYWORD_SCORE;

  const questionCategoryKeywordsText = [doc.question, doc.category, ...keywords].map(normalize).join(" ");
  const fullSearchableText = [doc.question, doc.category, doc.answer, ...keywords].map(normalize).join(" ");
  const searchableTokens = new Set(tokens(questionCategoryKeywordsText));
  const categoryText = normalize(doc.category);
  const categoryTokens = new Set(tokens(categoryText));

  const overlap = queryTokens.filter((token) => {
    if (searchableTokens.has(token)) return true;
    if (token.length >= 2 && fullSearchableText.includes(token)) return true;
    return Array.from(searchableTokens).some((st) => (
      st.length >= 2 && (st.includes(token) || token.includes(st))
    ));
  });

  const categoryOverlap = Boolean(
    categoryText && (
      queryTokens.some((token) => (
        categoryTokens.has(token)
        || (token.length >= 2 && categoryText.includes(token))
        || (categoryText.length >= 2 && token.includes(categoryText))
      ))
      || (query.length >= 2 && (categoryText.includes(query) || query.includes(categoryText)))
    ),
  );

  const evidenceScore = exactKeywordScore
    + overlap.length * TOKEN_SCORE
    + (categoryOverlap ? CATEGORY_SCORE : 0);
    
  return {
    matched: evidenceScore > 0,
    tier: exactKeywordScore > 0 ? 1 : 0,
    score: evidenceScore + numericPriority(doc),
    matchedTerms: [...new Set([...exactKeywordMatches, ...overlap])],
  };
}

function boundedLimit(value) {
  if (!Number.isInteger(value) || value < 1) return MAX_RESULTS;
  return Math.min(value, MAX_RESULTS);
}

function numericPriority(doc) {
  return Number.isFinite(doc?.priority) ? doc.priority : 0;
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
