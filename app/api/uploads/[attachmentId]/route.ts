/**
 * @file 附件下载接口
 * @description GET /api/uploads/[attachmentId] — 获取用户上传的附件文件内容
 */
import fs from "node:fs/promises";

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { findAttachmentForUser } from "@/lib/store";

type RouteContext = {
  params: Promise<{
    attachmentId: string;
  }>;
};

function isUtf8TextLikeMimeType(mimeType: string) {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/ld+json" ||
    normalized === "application/xml" ||
    normalized === "application/javascript" ||
    normalized === "application/x-javascript" ||
    normalized === "application/ecmascript" ||
    normalized === "application/sql" ||
    normalized === "application/x-sh" ||
    normalized === "application/x-httpd-php"
  );
}

function buildContentTypeHeader(mimeType: string) {
  if (/charset=/i.test(mimeType)) {
    return mimeType;
  }

  return isUtf8TextLikeMimeType(mimeType)
    ? `${mimeType}; charset=utf-8`
    : mimeType;
}

function buildContentDispositionHeader(filename: string) {
  const safeAsciiFilename = filename
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_") || "download";
  const encodedFilename = encodeURIComponent(filename);
  return `inline; filename="${safeAsciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

/**
 * 获取附件文件内容
 * @description 需要用户登录。从本地存储读取附件并以原始 MIME 类型返回。
 * @param _request - HTTP 请求对象（未使用）
 * @param context - 路由上下文，包含 attachmentId 路径参数
 * @returns 200 附件二进制数据 | 401 未登录 | 404 附件不存在或文件未找到
 */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { attachmentId } = await context.params;
  const attachment = await findAttachmentForUser(user.id, attachmentId);
  if (!attachment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!attachment.storagePath) {
    return NextResponse.json(
      { error: "Attachment is not stored locally." },
      { status: 404 },
    );
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(attachment.storagePath);
  } catch {
    return NextResponse.json(
      { error: "Attachment file not found on server." },
      { status: 404 },
    );
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": buildContentTypeHeader(attachment.mimeType),
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": buildContentDispositionHeader(attachment.name),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
