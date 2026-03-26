import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function extractImportedDocument({ filename, contentBase64, tempRoot }) {
  const safeFilename = String(filename ?? "").trim();
  if (!safeFilename) {
    throw createImportError("文件名不能为空");
  }

  const ext = path.extname(safeFilename).toLowerCase();
  const baseTitle = path.basename(safeFilename, ext).trim() || "未命名制度";
  const buffer = Buffer.from(String(contentBase64 ?? ""), "base64");

  if (buffer.length === 0) {
    throw createImportError("上传文件内容为空");
  }

  if (ext === ".txt" || ext === ".md") {
    return {
      title: baseTitle,
      category: "",
      content: buffer.toString("utf8"),
      sourceType: ext.slice(1),
    };
  }

  if (ext === ".docx") {
    const content = await extractDocxText(buffer, tempRoot);
    return { title: baseTitle, category: "", content, sourceType: "docx" };
  }

  if (ext === ".pdf") {
    const content = await extractPdfText(buffer, tempRoot);
    return { title: baseTitle, category: "", content, sourceType: "pdf" };
  }

  throw createImportError("当前仅支持 TXT、MD、DOCX 和 PDF 文件");
}

async function extractDocxText(buffer, tempRoot) {
  const root = tempRoot || path.join(os.tmpdir(), "property-kb-import-");
  await mkdir(root, { recursive: true });
  const tempDir = await mkdtemp(path.join(root, "docx-"));
  const zipPath = path.join(tempDir, "upload.zip");
  const extractDir = path.join(tempDir, "unzipped");

  try {
    await writeFile(zipPath, buffer);

    if (process.platform === "win32") {
      await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        "Expand-Archive",
        "-Path",
        zipPath,
        "-DestinationPath",
        extractDir,
        "-Force",
      ], { windowsHide: true });
    } else {
      await mkdir(extractDir, { recursive: true });
      await execFileAsync("unzip", ["-qq", zipPath, "-d", extractDir], { windowsHide: true });
    }

    const documentXml = await readFile(path.join(extractDir, "word", "document.xml"), "utf8");
    const text = decodeXmlEntities(
      (documentXml.match(/<w:t[^>]*>(.*?)<\/w:t>/g) ?? [])
        .map((part) => part.replace(/<\/?w:t[^>]*>/g, ""))
        .join("\n")
    ).replace(/\r\n?/g, "\n").trim();

    if (!text) {
      throw createImportError("DOCX 中没有提取到正文内容");
    }

    return text;
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }

    const message = process.platform === "win32"
      ? "DOCX 提取失败，请确认文件未损坏"
      : "DOCX 提取失败，请确认服务器已安装 unzip 且文件未损坏";
    throw createImportError(message);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extractPdfText(buffer, tempRoot) {
  const root = tempRoot || path.join(os.tmpdir(), "property-kb-import-");
  await mkdir(root, { recursive: true });
  const tempDir = await mkdtemp(path.join(root, "pdf-"));
  const pdfPath = path.join(tempDir, "upload.pdf");

  try {
    await writeFile(pdfPath, buffer);

    if (process.platform === "win32") {
      throw createImportError("Windows 环境暂不支持 PDF 自动提取，建议优先上传 DOCX 或 TXT");
    }

    const { stdout } = await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });

    const text = String(stdout ?? "").replace(/\r\n?/g, "\n").trim();
    if (!text) {
      throw createImportError("PDF 中没有提取到正文内容");
    }

    return text;
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }

    throw createImportError("PDF 提取失败，请确认服务器已安装 pdftotext 或先将文件转成 DOCX/TXT");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function decodeXmlEntities(text) {
  return String(text ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function createImportError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
