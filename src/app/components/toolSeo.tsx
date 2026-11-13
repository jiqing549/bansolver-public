import type { Metadata } from "next";
import JsonLd from "./JsonLd";

/**
 * 工具页 SEO 共享模块：zh / en 两组页面用它生成 per-route 元信息与
 * WebApplication 结构化数据。zh 页通过 enPath 与 en 页互挂 hreflang。
 */

export function zhPageMetadata(input: {
  path: string;
  title: string;
  description: string;
  enPath?: string;
}): Metadata {
  const { path, title, description, enPath } = input;
  return {
    title,
    description,
    alternates: {
      canonical: path,
      languages: enPath
        ? { "zh-CN": path, en: enPath, "x-default": enPath }
        : undefined,
    },
    openGraph: { title, description, url: path, type: "website" },
  };
}

export function enPageMetadata(input: {
  path: string;
  title: string;
  description: string;
  zhPath: string;
}): Metadata {
  const { path, title, description, zhPath } = input;
  return {
    title,
    description,
    alternates: {
      canonical: path,
      languages: { en: path, "zh-CN": zhPath, "x-default": path },
    },
    openGraph: {
      title,
      description,
      url: path,
      type: "website",
      locale: "en_US",
      alternateLocale: ["zh_CN"],
    },
  };
}

export function ToolJsonLd(input: {
  path: string;
  name: string;
  description: string;
  applicationCategory?: string;
  lang?: "zh-CN" | "en";
}) {
  const { path, name, description } = input;
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "WebApplication",
        name,
        url: `https://bansolver.com${path}`,
        applicationCategory: input.applicationCategory ?? "UtilitiesApplication",
        operatingSystem: "Any",
        browserRequirements: "Requires JavaScript",
        description,
        inLanguage: input.lang ?? "zh-CN",
        offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
        publisher: {
          "@type": "Organization",
          name: "千算Poker BanSolver",
          url: "https://bansolver.com",
        },
      }}
    />
  );
}
