const MAX_RESULTS = 5;
const EXACT_KEYWORD_SCORE = 1_000;
const TOKEN_SCORE = 10;
const CATEGORY_SCORE = 50;
const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

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
    return false;
  });
  const meaningfulOverlap = overlap.filter(isMeaningfulToken);

  const categoryOverlap = Boolean(
    categoryText && (
      queryTokens.some((token) => isMeaningfulToken(token) && (
        categoryTokens.has(token)
        || categoryText.includes(token)
        || (categoryText.length >= 2 && token.includes(categoryText))
      ))
      || (query.length >= 2 && (categoryText.includes(query) || query.includes(categoryText)))
    ),
  );

  const evidenceScore = exactKeywordScore
    + overlap.length * TOKEN_SCORE
    + (categoryOverlap ? CATEGORY_SCORE : 0);
    
  return {
    matched: exactKeywordScore > 0 || categoryOverlap || meaningfulOverlap.length > 0,
    tier: exactKeywordScore > 0 ? 1 : 0,
    score: evidenceScore + numericPriority(doc),
    matchedTerms: [...new Set([...exactKeywordMatches, ...overlap])],
  };
}

function isMeaningfulToken(token) {
  return token.length >= 2 || !CJK_RANGE.test(token);
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

/**
 * Tokenize text for search matching.
 * For Latin/alphanumeric text: split on whitespace (standard word tokenization).
 * For CJK text: emit individual characters AND 2-character bigrams.
 * This enables character-level intersection matching for Chinese, Japanese,
 * and Korean text where there are no word boundaries.
 */
function tokens(value) {
  const result = [];
  const parts = value.split(" ").filter(Boolean);
  for (const part of parts) {
    if (CJK_RANGE.test(part)) {
      const chars = [...part].filter((ch) => CJK_RANGE.test(ch));
      for (const ch of chars) result.push(ch);
      for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
    } else {
      result.push(part);
    }
  }
  return result;
}
