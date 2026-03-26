import test from "node:test";
import assert from "node:assert/strict";
import { extractImportedDocument } from "./file-import.js";

test("extractImportedDocument imports txt content", async () => {
  const payload = await extractImportedDocument({
    filename: "装修管理规定.txt",
    contentBase64: Buffer.from("第一条 装修前应提交申请。", "utf8").toString("base64"),
  });

  assert.equal(payload.title, "装修管理规定");
  assert.equal(payload.sourceType, "txt");
  assert.match(payload.content, /提交申请/);
});

test("extractImportedDocument handles unsupported pdf according to platform", async () => {
  const action = () =>
    extractImportedDocument({
      filename: "制度.pdf",
      contentBase64: Buffer.from("fake", "utf8").toString("base64"),
    });

  if (process.platform === "win32") {
    await assert.rejects(action, /暂不支持|建议优先上传 DOCX 或 TXT/);
    return;
  }

  await assert.rejects(action, /pdftotext|DOCX\/TXT/);
});
