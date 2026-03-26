function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

export function createModelClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = String(env.MODEL_API_KEY || env.OPENAI_API_KEY || "").trim();
  const model = String(env.MODEL_NAME || env.OPENAI_MODEL || "").trim();
  const baseUrl = trimTrailingSlash(env.MODEL_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1");
  const enabled = Boolean(apiKey && model && typeof fetchImpl === "function");

  return {
    enabled,
    model,
    baseUrl,
    async answerQuestion({ question, matches, fallbackAnswer }) {
      if (!enabled || !Array.isArray(matches) || matches.length === 0) {
        return null;
      }

      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: buildMessages(question, matches, fallbackAnswer),
        }),
      });

      if (!response.ok) {
        const errorText = await safeReadText(response);
        const error = new Error(`Model request failed: ${response.status} ${errorText}`.trim());
        error.statusCode = 502;
        throw error;
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      const parsed = extractStructuredAnswer(content);
      return parsed ? normalizeModelAnswer(parsed) : null;
    },
  };
}

export function buildMessages(question, matches, fallbackAnswer) {
  const evidence = matches
    .slice(0, 6)
    .map((match, index) => {
      const label = [match.title, match.category ? `(${match.category})` : "", match.clauseLabel || ""]
        .filter(Boolean)
        .join(" ");
      return [`Evidence ${index + 1}: ${label}`, `Excerpt: ${match.excerpt}`].join("\n");
    })
    .join("\n\n");

  return [
    {
      role: "system",
      content: [
        "You are a property-management knowledge base assistant.",
        "Answer only from the provided evidence.",
        "Do not invent rules, steps, departments, deadlines, or penalties.",
        "Return strict JSON with keys summary, workGuide, steps, violationHandling, basis.",
        "steps and violationHandling and basis must be arrays of short strings.",
        "If evidence is insufficient, keep the answer conservative and say evidence is insufficient.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Question: ${question}`,
        "",
        "Evidence:",
        evidence,
        "",
        "Rule-based fallback answer for reference:",
        JSON.stringify({
          summary: fallbackAnswer?.summary ?? "",
          workGuide: fallbackAnswer?.workGuide ?? "",
          basis: fallbackAnswer?.basis ?? [],
        }),
      ].join("\n"),
    },
  ];
}

export function extractStructuredAnswer(content) {
  const text = Array.isArray(content)
    ? content.map((item) => item?.text ?? "").join("\n")
    : String(content ?? "");

  if (!text.trim()) {
    return null;
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : text;
  const direct = tryParseJson(candidate);
  if (direct) {
    return direct;
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseJson(candidate.slice(start, end + 1));
  }

  return null;
}

export function normalizeModelAnswer(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    summary: normalizeString(value.summary),
    workGuide: normalizeString(value.workGuide),
    steps: normalizeStringArray(value.steps),
    violationHandling: normalizeStringArray(value.violationHandling),
    basis: normalizeStringArray(value.basis),
  };
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function tryParseJson(value) {
  try {
    return JSON.parse(String(value ?? "").trim());
  } catch {
    return null;
  }
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
