/**
 * @file 全屏图片预览组件。
 *
 * 以模态叠加层方式展示图片大图，支持下载到本地和点击遮罩关闭。
 * 打开时会禁止页面滚动。
 */
"use client";

import { useEffect } from "react";

/**
 * ImageViewer 的 Props。
 *
 * @property url - 要预览的图片 URL
 * @property onClose - 关闭预览的回调
 */
interface ImageViewerProps {
  url: string;
  onClose: () => void;
}

/**
 * 全屏图片预览查看器。
 *
 * 渲染一个占满视口的半透明遮罩层，居中展示图片大图。
 * 顶部提供"保存到本地"和"关闭"两个操作按钮。
 * 点击遮罩区域即可关闭。
 *
 * @param props.url - 图片 URL
 * @param props.onClose - 关闭回调
 */
export function ImageViewer({ url, onClose }: ImageViewerProps) {
  // Prevent scrolling on the body when the modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "auto";
    };
  }, []);

  const handleDownload = async () => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      // Extract filename from URL or use a default
      const filename = url.split("/").pop() || "image";
      link.download = filename.includes(".") ? filename : `${filename}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error("Failed to download image:", error);
      // Fallback: open in new tab if blob download fails
      window.open(url, "_blank");
    }
  };

  return (
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div 
        className="relative max-h-[90vh] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img 
          src={url} 
          alt="Preview" 
          className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
        />
        
        <div className="absolute -top-12 left-0 right-0 flex justify-between px-2">
          <button
            onClick={handleDownload}
            className="flex h-9 items-center gap-2 rounded-full bg-white/10 px-4 text-xs font-medium text-white backdrop-blur transition hover:bg-white/20"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            保存到本地
          </button>
          
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
