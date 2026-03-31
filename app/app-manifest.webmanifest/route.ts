/**
 * @file PWA Web App Manifest 接口
 * @description GET /app-manifest.webmanifest — 返回 PWA 清单 JSON，定义应用名称、图标、主题色等
 */
import { NextResponse } from "next/server";

const manifest = {
  name: "ChatBot",
  short_name: "ChatBot",
  description: "Multi-panel chat workspace for a passive provider-style channel.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#f4efe6",
  theme_color: "#f4efe6",
  icons: [
    {
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
    },
    {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
    },
    {
      src: "/icons/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};

/**
 * 返回 PWA Web App Manifest
 * @description 无需认证。返回 application/manifest+json 格式的 PWA 配置。
 * @returns 200 PWA manifest JSON
 */
export function GET() {
  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
    },
  });
}
