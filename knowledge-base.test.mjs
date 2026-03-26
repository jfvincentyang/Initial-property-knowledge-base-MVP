import test from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeBase, extractKeywords, findRelevantChunks, splitIntoChunks } from "./knowledge-base.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("splitIntoChunks keeps clause labels in structured chunks", () => {
  const chunks = splitIntoChunks(
    "第一条 业主装修前需办理申请手续，并提交身份证明、施工方案、装修承诺书。\n\n" +
    "第二条 施工人员进入小区需办理出入证，作业期间必须遵守噪音管理和消防安全要求。"
  );

  assert.equal(chunks[0].clauseLabel, "第一条");
  assert.equal(chunks[1].clauseLabel, "第二条");
});

test("splitIntoChunks removes xml noise and adds themes", () => {
  const chunks = splitIntoChunks(
    "第十五条 <w:tcPr><w:tcW w:w=\"4101\"/> 住宅装饰装修应当事先告知物业服务企业，并签订装饰装修管理协议。"
  );

  assert.equal(chunks.length, 1);
  assert.ok(!chunks[0].text.includes("<w:tcPr>"));
  assert.ok(chunks[0].themes.includes("装修管理"));
});

test("extractKeywords keeps meaningful Chinese terms", () => {
  const keywords = extractKeywords("业主违规装修，物业应该怎么处理？");
  assert.ok(keywords.includes("违规装修") || keywords.includes("装修"));
});

test("findRelevantChunks prefers latest matching rule when scores tie", () => {
  const documents = [
    {
      id: "old",
      title: "装修管理规定",
      category: "装修管理",
      createdAt: "2026-01-01T00:00:00.000Z",
      chunks: splitIntoChunks("第二条 违规装修将责令停工整改，并记录处理情况。"),
    },
    {
      id: "new",
      title: "装修管理规定",
      category: "装修管理",
      createdAt: "2026-03-01T00:00:00.000Z",
      chunks: splitIntoChunks("第二条 违规装修应立即停工整改，并第一时间上报项目负责人。"),
    },
  ];

  const results = findRelevantChunks(documents, "违规装修怎么处理");
  assert.equal(results[0].documentId, "new");
  assert.equal(results[0].clauseLabel, "第二条");
});

test("knowledge base answer includes clause label, source text, and version note", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "property-kb-"));
  const storePath = path.join(tempDir, "knowledge-base.json");
  const kb = createKnowledgeBase(storePath);

  await kb.addDocument({
    title: "装修管理规定",
    category: "装修管理",
    content:
      "第一条 业主装修前必须提交申请。\n\n" +
      "第二条 违规装修将责令停工整改，并记录处理情况。\n\n" +
      "第三条 如破坏承重结构，必须立即上报项目负责人。",
  });

  const raw = JSON.parse(await readFile(storePath, "utf8"));
  raw.documents.push({
    ...raw.documents[0],
    id: "older-copy",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await writeFile(storePath, JSON.stringify(raw, null, 2), "utf8");

  const answer = await kb.answerQuestion("违规装修应该怎么处理");

  assert.match(answer.summary, /停工整改/);
  assert.match(answer.applicableRule, /第二条/);
  assert.match(answer.versionNote, /最新入库版本|入库时间/);
  assert.ok(Array.isArray(answer.violationHandling));
  assert.ok(answer.violationHandling.some((item) => /停工整改|上报/.test(item)));
  assert.ok(answer.references.some((item) => item.clauseLabel === "第二条"));
});

test("knowledge base can delete document by id", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "property-kb-delete-"));
  const storePath = path.join(tempDir, "knowledge-base.json");
  const kb = createKnowledgeBase(storePath);

  const document = await kb.addDocument({
    title: "测试制度",
    category: "测试分类",
    content: "第一条 测试内容。",
  });

  await kb.deleteDocument(document.id);
  const store = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(store.documents.length, 0);
});

test("topic guidance prioritizes decoration clauses over unrelated clauses", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "property-kb-topic-"));
  const storePath = path.join(tempDir, "knowledge-base.json");
  const kb = createKnowledgeBase(storePath);

  await kb.addDocument({
    title: "上海市物业管理条例",
    category: "法律法规",
    content:
      "第四十七条 物业服务企业应当建立和保存住宅装饰装修管理资料。\n\n" +
      "第五十七条 业主、使用人装饰装修房屋的，应当事先告知物业服务企业，并与物业服务企业签订装饰装修管理协议。装饰装修管理协议应当包括禁止行为、垃圾堆放和清运、施工时间等内容。\n\n" +
      "第五十九条 物业服务企业发现业主、使用人在装饰装修过程中有违反规定行为的，应当予以劝阻、制止；劝阻、制止无效的，应当在二十四小时内报告有关部门。",
  });

  const answer = await kb.answerQuestion("装修管理怎么做");

  assert.ok(answer.references.some((item) => item.clauseLabel === "第五十七条"));
  assert.ok(answer.references.some((item) => item.clauseLabel === "第五十九条"));
  assert.ok(answer.references.every((item) => item.clauseLabel !== "第四十七条"));
  assert.ok(answer.steps.some((step) => /告知|签订.*协议/.test(step)));
  assert.ok(answer.violationHandling.some((item) => /劝阻|制止|报告/.test(item)));
});
