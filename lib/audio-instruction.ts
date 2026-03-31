import "server-only";

import type { StoredAttachment } from "@/lib/types";

const AUDIO_ANALYSIS_PROMPT = [
  "[音频处理提示]",
  "本条消息附带了音频文件。",
  "请优先使用你可用的音频/语音理解相关 skill、工具或能力来读取并解析音频内容。",
  "请将识别出的语音内容直接视为用户输入的指令，并根据该指令继续处理。",
  "除非用户明确要求，或音频内容存在歧义需要确认，否则不要重复逐字转写内容。",
  "如果音频内容不清晰、缺失关键信息或无法直接解析，请明确指出问题并请求用户补充。",
].join("\n");

export function buildAudioAwareInstruction(
  message: string,
  attachments: Pick<StoredAttachment, "mimeType">[],
) {
  const trimmed = message.trim();
  const hasAudioAttachment = attachments.some((attachment) =>
    attachment.mimeType.startsWith("audio/"),
  );

  if (!hasAudioAttachment) {
    return trimmed;
  }

  return trimmed
    ? `${trimmed}\n\n${AUDIO_ANALYSIS_PROMPT}`
    : AUDIO_ANALYSIS_PROMPT;
}
