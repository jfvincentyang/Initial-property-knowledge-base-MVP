import test from "node:test";
import assert from "node:assert/strict";
import { buildMessages, createModelClient, extractStructuredAnswer, normalizeModelAnswer } from "./model-client.js";

test("extractStructuredAnswer reads fenced json", () => {
  const parsed = extractStructuredAnswer('```json\n{"summary":"a","workGuide":"b","steps":["1"],"violationHandling":[],"basis":["x"]}\n```');
  assert.equal(parsed.summary, "a");
  assert.deepEqual(parsed.steps, ["1"]);
});

test("normalizeModelAnswer keeps only string arrays", () => {
  const normalized = normalizeModelAnswer({
    summary: " test ",
    workGuide: " guide ",
    steps: ["  step1 ", "", null],
    violationHandling: [" item "],
    basis: [" rule "],
  });

  assert.equal(normalized.summary, "test");
  assert.deepEqual(normalized.steps, ["step1"]);
  assert.deepEqual(normalized.violationHandling, ["item"]);
  assert.deepEqual(normalized.basis, ["rule"]);
});

test("createModelClient disables itself without config", async () => {
  const client = createModelClient({ env: {}, fetchImpl: async () => ({}) });
  assert.equal(client.enabled, false);
  const answer = await client.answerQuestion({ question: "x", matches: [], fallbackAnswer: {} });
  assert.equal(answer, null);
});

test("model client requests model answer and parses structured json", async () => {
  let called = false;
  const client = createModelClient({
    env: {
      MODEL_API_KEY: "test-key",
      MODEL_NAME: "test-model",
      MODEL_BASE_URL: "https://example.test/v1/",
    },
    fetchImpl: async (url, options) => {
      called = true;
      assert.equal(url, "https://example.test/v1/chat/completions");
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, "test-model");
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: '{"summary":"模型总结","workGuide":"按制度执行","steps":["先登记"],"violationHandling":["发现违规先制止"],"basis":["装修管理规定 第二条"]}',
                },
              },
            ],
          };
        },
      };
    },
  });

  const answer = await client.answerQuestion({
    question: "装修管理怎么做",
    matches: [
      { title: "装修管理规定", category: "装修管理", clauseLabel: "第二条", excerpt: "施工前应登记并签订协议。" },
    ],
    fallbackAnswer: { summary: "规则总结", workGuide: "规则指引", basis: ["装修管理规定 第二条"] },
  });

  assert.equal(called, true);
  assert.equal(answer.summary, "模型总结");
  assert.deepEqual(answer.steps, ["先登记"]);
});

test("buildMessages includes question and evidence", () => {
  const messages = buildMessages(
    "装修管理怎么做",
    [{ title: "装修管理规定", category: "装修管理", clauseLabel: "第二条", excerpt: "施工前应登记并签订协议。" }],
    { summary: "规则总结", workGuide: "规则指引", basis: ["装修管理规定 第二条"] }
  );

  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /Question: 装修管理怎么做/);
  assert.match(messages[1].content, /Evidence 1: 装修管理规定/);
});
