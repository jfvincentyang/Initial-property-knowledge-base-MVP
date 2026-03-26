import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_STORE = { documents: [] };
const CLAUSE_START_RE = /(?:^|\n)\s*(第[一二三四五六七八九十百千万零〇0-9]+条)/g;

const STOP_WORDS = new Set([
  "怎么",
  "如何",
  "什么",
  "是否",
  "应该",
  "需要",
  "可以",
  "根据",
  "规定",
  "制度",
  "办法",
  "流程",
  "要求",
  "工作",
  "物业",
  "业主",
  "使用人",
  "我们",
  "你们",
  "请问",
]);

const GENERIC_TERMS = new Set(["管理", "流程", "规定", "制度", "办法", "要求", "工作"]);

const ACTION_HINTS = [
  "应当",
  "必须",
  "需要",
  "提交",
  "告知",
  "签订",
  "办理",
  "报备",
  "登记",
  "整改",
  "停工",
  "上报",
  "通知",
  "核实",
  "核验",
  "检查",
  "巡查",
  "配合",
  "补交",
  "移交",
  "备案",
  "申请",
];

const RISK_HINTS = [
  "禁止",
  "不得",
  "严禁",
  "不能",
  "无权",
  "违规",
  "违法",
  "超时",
  "责任",
  "追究",
  "停工",
  "整改",
  "劝阻",
  "制止",
];

const WEAK_TOPIC_HINTS = ["档案", "资料", "培训", "议事规则", "备案证明", "职责", "核定", "工作制度"];

const THEME_RULES = [
  { name: "装修管理", keywords: ["装修", "装饰装修", "施工", "管理协议", "装修协议", "施工时间", "垃圾清运", "巡查", "停工", "整改"] },
  { name: "收费管理", keywords: ["物业费", "收费", "交费", "催缴", "欠费", "收费标准", "清运费", "服务费"] },
  { name: "投诉处理", keywords: ["投诉", "举报", "调解", "纠纷", "受理", "处理机制", "12345"] },
  { name: "停车管理", keywords: ["停车", "车位", "车辆", "机动车", "停车场", "停车库"] },
  { name: "维修养护", keywords: ["维修", "养护", "保养", "电梯", "水箱", "渗漏", "共用设施", "设施设备"] },
  { name: "应急管理", keywords: ["应急", "突发", "救援", "事故", "消防", "安全责任"] },
  { name: "业主大会", keywords: ["业主大会", "业主委员会", "筹备组", "议事规则", "委员", "换届"] },
  { name: "专项维修资金", keywords: ["专项维修资金", "维修资金", "归集", "续筹"] },
  { name: "绿化环境", keywords: ["树木", "绿化", "修剪", "迁移", "环境卫生"] },
];

const QUESTION_THEME_RULES = [
  { name: "装修管理", pattern: /装修|装饰装修|施工|管理协议|整改通知书/ },
  { name: "收费管理", pattern: /物业费|收费|交费|缴费|欠费|催缴|费用/ },
  { name: "投诉处理", pattern: /投诉|举报|纠纷|受理|调解|反映/ },
  { name: "停车管理", pattern: /停车|车位|车辆|机动车/ },
  { name: "维修养护", pattern: /维修|养护|电梯|水箱|渗漏|设施设备/ },
  { name: "应急管理", pattern: /应急|突发|事故|消防|救援/ },
  { name: "业主大会", pattern: /业主大会|业主委员会|筹备组|换届/ },
  { name: "专项维修资金", pattern: /专项维修资金|维修资金/ },
  { name: "绿化环境", pattern: /树木|绿化|修剪|迁移|环境卫生/ },
];

const COMPOSITE_TITLE_RE = /(?:上海市[^。；\n]{4,80}?(?:规定|条例|办法|通知|协议|示范文本)|关于[^。；\n]{4,100}?(?:规定|通知|办法|意见|协议)|附件[0-9一二三四五六七八九十]+[^。；\n]{0,40}?(?:示范文本|通知书|回证|协议|表))/g;

export function createKnowledgeBase(databasePath, options = {}) {
  const db = new DatabaseSync(databasePath);
  initializeDatabase(db);
  migrateLegacyJsonIfNeeded(db, options.legacyJsonPath);

  return {
    databasePath,
    async listDocuments() {
      return loadDocuments(db).map((document) => ({
        id: document.id,
        title: document.title,
        category: document.category,
        chunkCount: Array.isArray(document.chunks) ? document.chunks.length : 0,
        preview: String(document.content ?? "").slice(0, 120),
        createdAt: document.createdAt,
      }));
    },

    async addDocument(input) {
      const title = String(input.title ?? "").trim();
      const content = String(input.content ?? "").trim();
      const category = String(input.category ?? "").trim();

      if (!title || !content) {
        throw new Error("制度名称和内容不能为空");
      }

      const document = buildDocument({
        id: createId(),
        title,
        category,
        content,
        createdAt: new Date().toISOString(),
      });

      saveDocument(db, document);
      return document;
    },

    async deleteDocument(documentId) {
      const cleanId = String(documentId ?? "").trim();
      if (!cleanId) {
        throw new Error("制度标识不能为空");
      }

      const result = db.prepare("DELETE FROM documents WHERE id = ?").run(cleanId);
      if (result.changes === 0) {
        const error = new Error("未找到要删除的制度");
        error.statusCode = 404;
        throw error;
      }

      return { id: cleanId };
    },

    async answerQuestion(question) {
      const context = await this.buildAnswerContext(question);
      return context.answer;
    },

    async buildAnswerContext(question) {
      const cleanQuestion = String(question ?? "").trim();
      if (!cleanQuestion) {
        throw new Error("问题不能为空");
      }

      const documents = await this.ensureNormalizedStore();
      const matches = findRelevantChunks(documents, cleanQuestion);

      if (matches.length === 0 || matches[0].score < 3) {
        return {
          question: cleanQuestion,
          matches: [],
          answer: {
          summary: "知识库中没有找到足够匹配的制度依据，暂时不能给出可靠处理意见。",
          workGuide: "建议先补充对应制度，再按照知识库依据处理。",
          applicableRule: "",
          versionNote: "",
          basis: [],
          steps: [
            "先补充与该场景相关的制度、通知或标准流程。",
            "补充后重新提问，系统才可以根据现有依据给出更准确建议。",
          ],
          violationHandling: [],
          references: [],
          },
        };
      }

      return {
        question: cleanQuestion,
        matches,
        answer: buildAnswer(cleanQuestion, matches),
      };
    },

    async ensureNormalizedStore() {
      let documents = loadDocuments(db);
      const expanded = expandCompositeDocuments(db, documents);
      if (expanded.changed) {
        documents = loadDocuments(db);
      }
      let changed = false;

      for (const document of documents) {
        const normalized = buildDocument(document);
        if (
          normalized.content !== String(document.content ?? "") ||
          JSON.stringify(normalized.chunks) !== JSON.stringify(Array.isArray(document.chunks) ? document.chunks : [])
        ) {
          saveDocument(db, normalized);
          changed = true;
        }
      }

      return changed ? loadDocuments(db) : documents;
    },
  };
}

function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      chunks_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_documents_created_at
    ON documents(created_at DESC);
  `);
}

function migrateLegacyJsonIfNeeded(db, legacyJsonPath) {
  if (!legacyJsonPath || !existsSync(legacyJsonPath)) {
    return;
  }

  const countRow = db.prepare("SELECT COUNT(*) AS count FROM documents").get();
  if ((countRow?.count ?? 0) > 0) {
    return;
  }

  const raw = readFileSync(legacyJsonPath, "utf8");
  const parsed = JSON.parse(raw);
  const documents = Array.isArray(parsed.documents) ? parsed.documents : [];

  for (const document of documents) {
    saveDocument(db, buildDocument(document));
  }

  const backupPath = `${legacyJsonPath}.migrated-backup`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, raw, "utf8");
  }

  try {
    unlinkSync(legacyJsonPath);
  } catch {
    // Ignore cleanup failure and keep the backup.
  }
}

function loadDocuments(db) {
  const rows = db.prepare(`
    SELECT id, title, category, content, chunks_json, created_at, updated_at
    FROM documents
    ORDER BY datetime(created_at) DESC, rowid DESC
  `).all();

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    content: row.content,
    chunks: normalizeChunks(JSON.parse(row.chunks_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function expandCompositeDocuments(db, documents) {
  let changed = false;

  for (const document of documents) {
    const parts = splitCompositeDocument(document);
    if (parts.length <= 1) {
      continue;
    }

    db.prepare("DELETE FROM documents WHERE id = ?").run(document.id);
    for (const part of parts) {
      saveDocument(db, part);
    }
    changed = true;
  }

  return { changed };
}

function saveDocument(db, document) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO documents (id, title, category, content, chunks_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      category = excluded.category,
      content = excluded.content,
      chunks_json = excluded.chunks_json,
      updated_at = excluded.updated_at
  `).run(
    document.id,
    document.title,
    document.category,
    document.content,
    JSON.stringify(document.chunks),
    document.createdAt ?? now,
    now
  );
}

function buildDocument(input) {
  const content = cleanImportedContent(String(input.content ?? ""));

  return {
    id: String(input.id ?? createId()),
    title: String(input.title ?? "").trim(),
    category: String(input.category ?? "").trim(),
    content,
    chunks: splitIntoChunks(content),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function splitCompositeDocument(document) {
  const content = String(document.content ?? "");
  if (!isCompositePolicyDocument(document, content)) {
    return [document];
  }

  const markers = [];
  for (const match of content.matchAll(COMPOSITE_TITLE_RE)) {
    const title = String(match[0] ?? "").trim();
    const start = Number(match.index ?? -1);
    if (start < 0) continue;

    const rest = content.slice(start + title.length, start + title.length + 30);
    if (!/(第一条|第一章|一、|号|室（|室\()/u.test(rest)) {
      continue;
    }

    const previous = markers[markers.length - 1];
    if (previous && start - previous.start < 200) {
      continue;
    }

    markers.push({ title, start });
  }

  if (markers.length <= 1) {
    return [document];
  }

  const parts = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const next = markers[index + 1];
    const partContent = content.slice(marker.start, next ? next.start : content.length).trim();
    if (partContent.length < 120) {
      continue;
    }

    parts.push(buildDocument({
      id: `${document.id}-part-${index + 1}`,
      title: normalizeCompositeTitle(marker.title),
      category: inferCompositeCategory(marker.title, partContent),
      content: partContent,
      createdAt: document.createdAt,
    }));
  }

  return parts.length > 1 ? parts : [document];
}

function isCompositePolicyDocument(document, content) {
  return (
    String(document.title ?? "").includes("政策法规") &&
    content.length > 50000 &&
    (content.match(COMPOSITE_TITLE_RE) ?? []).length > 2
  );
}

function normalizeCompositeTitle(title) {
  return String(title ?? "")
    .replace(/上海市房屋管理局办公室\d{4}年\d{1,2}月\d{1,2}日印发/g, "")
    .replace(/沪房规范〔\d{4}〕\d+\s*号/g, "")
    .trim();
}

function inferCompositeCategory(title, content) {
  const detectedThemes = detectQuestionThemes(`${title} ${content.slice(0, 200)}`);
  return detectedThemes[0] ?? "政策法规";
}

export function splitIntoChunks(content) {
  const text = cleanImportedContent(content);
  if (!text) {
    return [];
  }

  const clausePieces = splitByClause(text);
  if (clausePieces.length > 0) {
    return clausePieces.flatMap((piece, index) => splitLargeClause(piece, index));
  }

  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => createChunk(index, index, block));
}

export function findRelevantChunks(documents, question) {
  const keywords = extractKeywords(question);
  const intent = detectIntent(question);
  const topicTerms = extractTopicTerms(question);
  const questionThemes = detectQuestionThemes(question);
  const normalizedQuestion = normalizeText(question);
  const results = [];

  for (const document of documents) {
    const titleText = normalizeText(`${document.title} ${document.category ?? ""}`);
    const chunks = normalizeChunks(document.chunks);

    for (const chunk of chunks) {
      const themeAnchorHits = countThemeAnchorHits(chunk.text, questionThemes);
      const score = scoreChunk({
        chunk,
        keywords,
        topicTerms,
        questionThemes,
        normalizedQuestion,
        titleText,
        intent,
        createdAt: document.createdAt,
      });

      if (score > 0) {
        results.push({
          documentId: document.id,
          title: document.title,
          category: document.category,
          createdAt: document.createdAt,
          clauseLabel: chunk.clauseLabel,
          excerpt: chunk.text,
          themes: chunk.themes,
          score,
          topicHits: countTopicHits(chunk.text, topicTerms),
          themeHits: countThemeHits(chunk.themes, questionThemes),
          themeAnchorHits,
          actionSentences: extractActionSentences(chunk.text),
          riskSentences: extractRiskSentences(chunk.text),
        });
      }
    }
  }

  const themedResults = questionThemes.length > 0 ? results.filter((item) => item.themeHits > 0) : results;
  return (themedResults.length > 0 ? themedResults : results).sort(compareMatches);
}

export function extractKeywords(question) {
  const normalized = normalizeText(question);
  const tokens = new Set();

  for (const word of normalized.match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}/gi) ?? []) {
    if (!STOP_WORDS.has(word)) {
      tokens.add(word);
    }
  }

  const compact = normalized.replace(/\s+/g, "");
  for (let size = 4; size >= 2; size -= 1) {
    for (let index = 0; index <= compact.length - size; index += 1) {
      const gram = compact.slice(index, index + size);
      if (/^[\u4e00-\u9fff]{2,4}$/.test(gram) && !STOP_WORDS.has(gram)) {
        tokens.add(gram);
      }
    }
  }

  return [...tokens].sort((left, right) => right.length - left.length);
}

export function scoreChunk({
  chunk,
  keywords,
  topicTerms,
  questionThemes,
  normalizedQuestion,
  titleText,
  intent,
  createdAt,
}) {
  const normalizedChunk = normalizeText(chunk.text);
  const topicHits = countTopicHits(chunk.text, topicTerms);
  const themeHits = countThemeHits(chunk.themes, questionThemes);
  const themeAnchorHits = countThemeAnchorHits(chunk.text, questionThemes);
  const actionSentences = extractActionSentences(chunk.text);
  const riskSentences = extractRiskSentences(chunk.text);
  const strongGuidance = hasStrongGuidance(chunk.text);
  const weakTopicOnly = hasWeakTopicOnly(chunk.text, actionSentences, riskSentences);
  let score = 0;

  for (const keyword of keywords) {
    if (normalizedChunk.includes(keyword)) {
      score += keyword.length >= 4 ? 5 : keyword.length === 3 ? 4 : 2;
    }

    if (titleText.includes(keyword)) {
      score += keyword.length >= 4 ? 4 : 2;
    }
  }

  score += topicHits * 5;
  score += themeHits * 12;
  score += themeAnchorHits * 8;
  score += actionSentences.length * 2;
  score += riskSentences.length * 2;

  if (normalizedQuestion.length >= 4 && normalizedChunk.includes(normalizedQuestion.slice(0, 4))) {
    score += 2;
  }

  if (intent === "how_to_handle" && actionSentences.length > 0) {
    score += 4;
  }

  if (intent === "topic_guidance" && topicHits > 0) {
    score += 5;
  }

  if (intent === "topic_guidance" && strongGuidance) {
    score += 10;
  }

  if (intent === "topic_guidance" && weakTopicOnly) {
    score -= 12;
  }

  if (intent === "topic_guidance" && isReferenceOnlyClause(chunk.text)) {
    score -= 20;
  }

  if ((intent === "topic_guidance" || intent === "how_to_handle") && isGovernanceOnlyClause(chunk.text)) {
    score -= 16;
  }

  if (intent === "is_allowed" && riskSentences.length > 0) {
    score += 4;
  }

  if (questionThemes.length > 0 && themeHits === 0) {
    score -= 18;
  }

  if (questionThemes.length > 0 && themeAnchorHits === 0) {
    score -= 24;
  }

  if (questionThemes.length === 1 && themeHits > 0 && (chunk.themes?.length ?? 0) === 1) {
    score += 10;
  }

  if (questionThemes.length === 1 && themeHits > 0 && (chunk.themes?.length ?? 0) > 1) {
    score -= 4;
  }

  if (chunk.clauseLabel) {
    score += 2;
  }

  if (containsAny(normalizedChunk, ["应当", "必须", "不得", "禁止"])) {
    score += 1;
  }

  if (topicTerms.length > 0 && topicHits === 0) {
    score -= 6;
  }

  if (chunk.text.length < 18) {
    score -= 2;
  }

  score += recencyBonus(createdAt);
  return score;
}

function buildAnswer(question, matches) {
  const intent = detectIntent(question);
  const questionThemes = detectQuestionThemes(question);
  const filteredByTheme = questionThemes.length > 0
    ? matches.filter((match) => countThemeHits(match.themes, questionThemes) > 0)
    : matches;
  if (questionThemes.length > 0 && filteredByTheme.length === 0) {
    return buildNoMatchAnswer(question);
  }
  const filteredByQuality = (filteredByTheme.length > 0 ? filteredByTheme : matches)
    .filter((match) => !isReferenceOnlyClause(match.excerpt))
    .filter((match) => !isGovernanceOnlyClause(match.excerpt));
  const evidenceMatches = filteredByQuality.filter((match) => hasSufficientThemeEvidence(match, questionThemes, intent));
  const effectiveMatches = evidenceMatches.length > 0
    ? evidenceMatches
    : (filteredByQuality.length > 0 ? filteredByQuality : (filteredByTheme.length > 0 ? filteredByTheme : matches));

  if (questionThemes.length > 0 && effectiveMatches.every((match) => countThemeHits(match.themes, questionThemes) === 0)) {
    return buildNoMatchAnswer(question);
  }

  if (questionThemes.length > 0 && evidenceMatches.length === 0) {
    return buildNoMatchAnswer(question);
  }

  if (intent === "topic_guidance") {
    return buildTopicAnswer(question, effectiveMatches);
  }

  return buildDirectAnswer(question, effectiveMatches);
}

function buildNoMatchAnswer(question) {
  return {
    summary: `针对“${question}”，当前知识库中没有找到足够明确且主题一致的制度依据。`,
    workGuide: "建议先补充该专题的制度文件，或换一个更具体的问题再查询。",
    applicableRule: "",
    versionNote: "",
    basis: [],
    steps: [
      "先确认该问题对应的制度是否已经入库。",
      "如果未入库，优先补充本专题制度后再查询。",
    ],
    violationHandling: [],
    references: [],
  };
}

function buildTopicAnswer(question, matches) {
  const actionableMatches = matches.filter((match) => isOperationalTopicMatch(match));
  const effectiveMatches = actionableMatches.length > 0 ? actionableMatches : matches;
  const selectedMatches = uniqueByRule(effectiveMatches).slice(0, 4);
  const primary = selectedMatches[0];
  const actionPool = unique(selectedMatches.flatMap((match) => match.actionSentences));
  const riskPool = unique(selectedMatches.flatMap((match) => match.riskSentences));

  return {
    summary: `针对“${question}”，知识库里更相关的是办理前置手续、现场管理要求和发现违规后的处理要求。`,
    workGuide: "建议按“先确认申请或告知，再核对协议或条件，再做现场巡查，最后按违规条款处置”的顺序执行。",
    applicableRule: formatRuleLabel(primary),
    versionNote: buildVersionNote(primary, matches),
    basis: selectedMatches.map((match) => formatRuleLabel(match)),
    steps: buildTopicSteps(actionPool, riskPool),
    violationHandling: buildViolationHandling(selectedMatches),
    references: selectedMatches.map((match) => formatReference(match)),
  };
}

function buildDirectAnswer(question, matches) {
  const primary = matches[0];
  const sameRuleMatches = matches.filter((match) => isSameRule(match, primary)).slice(0, 3);
  const supportingMatches = matches.filter((match) => !isSameRule(match, primary)).slice(0, 2);
  const selectedMatches = [...sameRuleMatches, ...supportingMatches];
  const actionPool = unique(selectedMatches.flatMap((match) => match.actionSentences));
  const riskPool = unique(selectedMatches.flatMap((match) => match.riskSentences));

  return {
    summary: buildSummary(question, primary, actionPool, riskPool),
    workGuide: buildDirectGuide(actionPool, riskPool),
    applicableRule: formatRuleLabel(primary),
    versionNote: buildVersionNote(primary, matches),
    basis: unique(selectedMatches.map((match) => formatRuleLabel(match))),
    steps: buildDirectSteps(primary, actionPool, riskPool),
    violationHandling: buildViolationHandling(selectedMatches),
    references: selectedMatches.map((match) => formatReference(match)),
  };
}

function buildSummary(question, primary, actionPool, riskPool) {
  const firstAction = actionPool[0];
  const firstRisk = riskPool[0];
  const clauseText = primary.clauseLabel ? `${primary.clauseLabel} ` : "";

  if (firstAction && firstRisk) {
    return `针对“${question}”，当前优先适用《${primary.title}》${clauseText}的内容。建议先“${trimSentence(firstAction)}”，同时注意“${trimSentence(firstRisk)}”。`;
  }

  if (firstAction) {
    return `针对“${question}”，当前优先适用《${primary.title}》${clauseText}的内容。建议先“${trimSentence(firstAction)}”。`;
  }

  return `针对“${question}”，当前优先适用《${primary.title}》${clauseText}的原文条款处理。`;
}

function buildTopicSteps(actionPool, riskPool) {
  const steps = [];
  const orderedHints = [
    /事先告知|提交|申请|报备|登记/,
    /签订.*协议|管理协议/,
    /巡查|施工时间|垃圾清运|现场|配合/,
    /劝阻|制止|整改|停工|上报|报告|禁止/,
  ];

  for (const hint of orderedHints) {
    const match = actionPool.find((sentence) => hint.test(sentence)) || riskPool.find((sentence) => hint.test(sentence));
    if (match) {
      steps.push(trimSentence(match));
    }
  }

  if (steps.length === 0) {
    steps.push(...actionPool.slice(0, 3).map(trimSentence));
  }

  steps.push("对照命中条款逐项执行，并保留申请、巡查、整改或上报记录。");
  return unique(steps).slice(0, 5);
}

function buildDirectGuide(actionPool, riskPool) {
  const firstAction = actionPool[0];
  const firstRisk = riskPool[0];

  if (firstAction && firstRisk) {
    return `先按“${trimSentence(firstAction)}”执行；如发现违规或限制情形，再按“${trimSentence(firstRisk)}”处理。`;
  }

  if (firstAction) {
    return `优先按“${trimSentence(firstAction)}”执行。`;
  }

  return "建议先核对命中条款，再按制度流程处理。";
}

function buildDirectSteps(primary, actionPool, riskPool) {
  const steps = [];

  if (actionPool[0]) {
    steps.push(trimSentence(actionPool[0]));
  }
  if (actionPool[1] && actionPool[1] !== actionPool[0]) {
    steps.push(trimSentence(actionPool[1]));
  }
  if (riskPool[0]) {
    steps.push(`执行时注意：${trimSentence(riskPool[0])}`);
  }

  steps.push(`处理完成后保留记录；如现场情况与《${primary.title}》不完全一致，先上报主管确认。`);
  return unique(steps).slice(0, 4);
}

function buildViolationHandling(matches) {
  const items = [];
  const sentences = unique(matches.flatMap((match) => splitSentences(match.excerpt)));

  for (const sentence of sentences) {
    if (/[劝阻制止整改停工报告上报禁止]/.test(sentence) || /劝阻|制止|整改|停工|报告|上报|禁止/.test(sentence)) {
      items.push(trimSentence(sentence));
    }
  }

  return unique(items).slice(0, 4);
}

function buildVersionNote(primary, matches) {
  const sameTitleMatches = matches.filter((match) => match.title === primary.title);
  const hasOlderVersion = sameTitleMatches.some(
    (match) => match.createdAt && primary.createdAt && match.createdAt < primary.createdAt
  );

  if (hasOlderVersion) {
    return `知识库中存在同名制度的多个版本，本次优先采用最新入库版本：${formatDate(primary.createdAt)}。`;
  }

  return primary.createdAt ? `本次依据的制度入库时间为 ${formatDate(primary.createdAt)}。` : "";
}

function isOperationalTopicMatch(match) {
  if (isReferenceOnlyClause(match.excerpt) || isGovernanceOnlyClause(match.excerpt)) {
    return false;
  }

  if (match.themeHits > 0 && (match.actionSentences.length > 0 || match.riskSentences.length > 0)) {
    return true;
  }

  return hasStrongGuidance(match.excerpt);
}

function hasWeakTopicOnly(text, actionSentences, riskSentences) {
  return containsAny(text, WEAK_TOPIC_HINTS) && actionSentences.length === 0 && riskSentences.length === 0;
}

function hasStrongGuidance(text) {
  return containsAny(text, ["事先告知", "签订", "管理协议", "施工时间", "垃圾清运", "巡查", "劝阻", "制止", "报告", "上报", "停工", "整改"]);
}

function isReferenceOnlyClause(text) {
  const normalized = String(text ?? "");
  const hasReferenceWords = /档案|资料|保存|建立和保存|留存|装饰装修管理资料/.test(normalized);
  const hasOperationalWords = /事先告知|申请|签订|管理协议|巡查|施工时间|垃圾清运|劝阻|制止|整改|停工|报告|上报|禁止/.test(normalized);
  return /建立和保存下列档案和资料/.test(normalized) || (hasReferenceWords && !hasOperationalWords);
}

function isGovernanceOnlyClause(text) {
  const normalized = String(text ?? "");
  const hasGovernanceWords = /职责|拟订|议事规则|行业协会|人民政府|街道办事处|业主大会|业主委员会|候选人|备案|核定/.test(normalized);
  const hasOperationalWords = /装修|装饰装修|施工|告知|签订|管理协议|巡查|整改|停工|上报|报告|禁止|劝阻|制止|投诉|举报|调解|收费|停车|维修/.test(normalized);
  const hasOperationalVerbs = /告知|签订|巡查|整改|停工|上报|报告|制止|劝阻|催缴|受理|办理/.test(normalized);
  return hasGovernanceWords && (!hasOperationalWords || !hasOperationalVerbs);
}

function detectIntent(question) {
  if (/(能否|是否|可不可以|准不准|允许|可以吗)/.test(question)) {
    return "is_allowed";
  }
  if (/(怎么做|如何做|怎么开展|如何开展|怎么管理|如何管理)/.test(question)) {
    return "topic_guidance";
  }
  if (/(怎么|如何|怎么办|处理)/.test(question)) {
    return "how_to_handle";
  }
  return "general";
}

function extractTopicTerms(question) {
  const topicSource = String(question ?? "")
    .replace(/(怎么做|如何做|怎么开展|如何开展|怎么管理|如何管理|怎么办|怎么处理|如何处理)/g, " ")
    .replace(/[？?]/g, " ")
    .trim();

  const terms = extractKeywords(topicSource).filter((term) => !GENERIC_TERMS.has(term));
  return unique(terms.filter((term) => term.length >= 2)).slice(0, 6);
}

function countTopicHits(text, topicTerms) {
  const normalized = normalizeText(text);
  return topicTerms.filter((term) => normalized.includes(term)).length;
}

function countThemeHits(chunkThemes, questionThemes) {
  if (!questionThemes.length) {
    return 0;
  }
  const themeSet = new Set(chunkThemes ?? []);
  return questionThemes.filter((theme) => themeSet.has(theme)).length;
}

function countThemeAnchorHits(text, questionThemes) {
  const source = String(text ?? "");
  let hits = 0;

  for (const theme of questionThemes) {
    const rule = THEME_RULES.find((item) => item.name === theme);
    if (!rule) {
      continue;
    }

    for (const keyword of rule.keywords) {
      if (source.includes(keyword)) {
        hits += 1;
      }
    }
  }

  return hits;
}

function extractActionSentences(chunkText) {
  return splitSentences(chunkText).filter((sentence) => containsAny(sentence, ACTION_HINTS));
}

function extractRiskSentences(chunkText) {
  return splitSentences(chunkText).filter((sentence) => containsAny(sentence, RISK_HINTS));
}

function splitSentences(text) {
  return String(text ?? "")
    .split(/[。！？；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitByClause(text) {
  const matches = [...text.matchAll(CLAUSE_START_RE)];
  if (matches.length === 0) {
    return [];
  }

  return matches.map((match, index) => {
    const start = match.index + match[0].length - match[1].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return text.slice(start, end).trim();
  }).filter(Boolean);
}

function splitLargeClause(piece, order) {
  const clauseLabel = extractClauseLabel(piece);
  if (piece.length <= 260) {
    return [createChunk(`${order}`, order, piece, clauseLabel)];
  }

  const segments = splitSentences(piece);
  const chunks = [];
  let current = "";
  let subOrder = 0;

  for (const segment of segments) {
    const next = current ? `${current}。${segment}` : segment;
    if (next.length > 260 && current) {
      chunks.push(createChunk(`${order}-${subOrder}`, order, ensureClausePrefix(current, clauseLabel), clauseLabel));
      current = segment;
      subOrder += 1;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(createChunk(`${order}-${subOrder}`, order, ensureClausePrefix(current, clauseLabel), clauseLabel));
  }

  return chunks;
}

function createChunk(id, order, text, clauseLabel = extractClauseLabel(text)) {
  const cleanText = cleanChunkText(text);
  return {
    id: String(id),
    order: Number(order),
    clauseLabel,
    text: cleanText,
    themes: inferThemes(cleanText),
  };
}

function ensureClausePrefix(text, clauseLabel) {
  if (!clauseLabel || text.startsWith(clauseLabel)) {
    return text;
  }
  return `${clauseLabel} ${text}`;
}

function normalizeChunks(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((chunk, index) => {
      if (typeof chunk === "string") {
        return createChunk(index, index, chunk);
      }

      return createChunk(
        String(chunk.id ?? index),
        Number(chunk.order ?? index),
        String(chunk.text ?? ""),
        chunk.clauseLabel ? String(chunk.clauseLabel) : extractClauseLabel(chunk.text)
      );
    })
    .filter((chunk) => chunk.text);
}

function extractClauseLabel(text) {
  const match = String(text ?? "").match(/第[一二三四五六七八九十百千万零〇0-9]+条/);
  return match ? match[0] : "";
}

function inferThemes(text) {
  const normalized = normalizeText(text);
  return THEME_RULES
    .filter((rule) => rule.keywords.some((keyword) => normalized.includes(normalizeText(keyword))))
    .map((rule) => rule.name);
}

function detectQuestionThemes(text) {
  const source = String(text ?? "");
  const detected = QUESTION_THEME_RULES
    .filter((rule) => rule.pattern.test(source))
    .map((rule) => rule.name);

  if (detected.length > 0) {
    return detected;
  }

  return inferThemes(source);
}

function hasSufficientThemeEvidence(match, questionThemes, intent) {
  if (questionThemes.length === 0) {
    return true;
  }

  const primaryTheme = questionThemes[0];
  const text = String(match.excerpt ?? "");
  const anchorHits = Number(match.themeAnchorHits ?? 0);

  const guardPatterns = {
    "装修管理": /(装修|装饰装修|施工|管理协议|整改|巡查|停工)/,
    "收费管理": /(物业费|收费|收费标准|交纳|缴纳|催缴|收支情况|市场调节价)/,
    "投诉处理": /(投诉|举报|受理|调查处理|反馈|调解)/,
    "停车管理": /(停车|车位|车辆|机动车|停车场|停车库)/,
    "维修养护": /(维修|养护|保养|电梯|水箱|渗漏|设施设备)/,
    "应急管理": /(应急|救援|事故|消防)/,
    "业主大会": /(业主大会|业主委员会|筹备组|换届)/,
    "专项维修资金": /(专项维修资金|维修资金|归集|续筹)/,
    "绿化环境": /(树木|绿化|修剪|迁移|环境卫生)/,
  };

  const guard = guardPatterns[primaryTheme];
  if (!guard) {
    return true;
  }

  if (!guard.test(text)) {
    return false;
  }

  if (intent === "topic_guidance" || intent === "how_to_handle") {
    return anchorHits >= 2 || match.actionSentences.length > 0 || match.riskSentences.length > 0;
  }

  return anchorHits >= 1;
}

function formatRuleLabel(match) {
  const categoryText = match?.category ? `（${match.category}）` : "";
  const clauseText = match?.clauseLabel ? ` ${match.clauseLabel}` : "";
  return `${match?.title ?? ""}${categoryText}${clauseText}`.trim();
}

function formatReference(match) {
  return {
    title: match.title,
    category: match.category,
    clauseLabel: match.clauseLabel,
    excerpt: match.excerpt,
    createdAt: match.createdAt,
    themes: match.themes ?? [],
  };
}

function uniqueByRule(matches) {
  const seen = new Set();
  const output = [];

  for (const match of matches) {
    const key = `${match.title}|${match.clauseLabel}|${match.excerpt}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(match);
    }
  }

  return output;
}

function isSameRule(left, right) {
  return left.title === right.title && left.createdAt === right.createdAt;
}

function compareMatches(left, right) {
  if (left.title === right.title && left.clauseLabel && left.clauseLabel === right.clauseLabel) {
    const rightTime = Date.parse(right.createdAt ?? 0);
    const leftTime = Date.parse(left.createdAt ?? 0);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
  }

  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.themeHits !== left.themeHits) {
    return right.themeHits - left.themeHits;
  }
  if (right.topicHits !== left.topicHits) {
    return right.topicHits - left.topicHits;
  }

  const rightTime = Date.parse(right.createdAt ?? 0);
  const leftTime = Date.parse(left.createdAt ?? 0);
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }

  return 0;
}

function cleanImportedContent(value) {
  const raw = String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\u3000]+/g, " ")
    .replace(/\u0007/g, " ")
    .trim();

  if (!raw) {
    return "";
  }

  const paragraphs = [];
  let current = "";

  for (const sourceLine of raw.split("\n")) {
    const line = cleanChunkText(sourceLine);
    if (!line) {
      if (current) {
        paragraphs.push(current);
        current = "";
      }
      continue;
    }

    const isHeading = /^第[一二三四五六七八九十百千万零〇0-9]+[章节编]/.test(line);
    const isClause = /^第[一二三四五六七八九十百千万零〇0-9]+条/.test(line);

    if (isHeading || isClause) {
      if (current) {
        paragraphs.push(current);
      }
      current = line;
      continue;
    }

    current = current ? `${current}${line}` : line;
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs
    .map((paragraph) => cleanChunkText(paragraph))
    .filter(Boolean)
    .join("\n\n");
}

function cleanChunkText(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\u3000]+/g, " ")
    .replace(/([，。；：！？、“”‘’（）])\s+/g, "$1")
    .replace(/\s+([，。；：！？、“”‘’（）])/g, "$1")
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/。{2,}/g, "。")
    .replace(/；{2,}/g, "；")
    .replace(/\s+/g, " ")
    .trim();
}

function recencyBonus(createdAt) {
  const timestamp = Date.parse(createdAt ?? "");
  if (Number.isNaN(timestamp)) {
    return 0;
  }
  const ageInDays = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  if (ageInDays <= 30) return 2;
  if (ageInDays <= 180) return 1;
  return 0;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知时间";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[，。！？；：“”"'‘’（）()\[\]【】《》、,.!?:;\-]/g, " ")
    .replace(/\s+/g, " ");
}

function containsAny(text, words) {
  return words.some((word) => text.includes(word));
}

function trimSentence(sentence) {
  return String(sentence).replace(/[。！？；]+$/g, "");
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}
