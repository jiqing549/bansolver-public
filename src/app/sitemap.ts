import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const BASE = "https://bansolver.com";

type Entry = {
  path: string;
  priority: number;
  langs?: Record<string, string>;
};

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: Entry[] = [
    { path: "/", priority: 1, langs: { "zh-CN": "/", en: "/en", "x-default": "/en" } },
    { path: "/en", priority: 0.9, langs: { en: "/en", "zh-CN": "/", "x-default": "/en" } },
    { path: "/tools/ban2note", priority: 0.9, langs: { "zh-CN": "/tools/ban2note", en: "/en/tools/ban2note", "x-default": "/en/tools/ban2note" } },
    { path: "/en/tools/ban2note", priority: 0.8, langs: { en: "/en/tools/ban2note", "zh-CN": "/tools/ban2note", "x-default": "/en/tools/ban2note" } },
    { path: "/tools/preflop", priority: 0.9, langs: { "zh-CN": "/tools/preflop", en: "/en/tools/preflop", "x-default": "/en/tools/preflop" } },
    { path: "/en/tools/preflop", priority: 0.8, langs: { en: "/en/tools/preflop", "zh-CN": "/tools/preflop", "x-default": "/en/tools/preflop" } },
    { path: "/guide", priority: 0.8, langs: { "zh-CN": "/guide", en: "/en/guide", "x-default": "/en/guide" } },
    { path: "/en/guide", priority: 0.7, langs: { en: "/en/guide", "zh-CN": "/guide", "x-default": "/en/guide" } },
    { path: "/tools/odds", priority: 0.7, langs: { "zh-CN": "/tools/odds", en: "/en/tools/odds", "x-default": "/en/tools/odds" } },
    { path: "/en/tools/odds", priority: 0.6, langs: { en: "/en/tools/odds", "zh-CN": "/tools/odds", "x-default": "/en/tools/odds" } },
    { path: "/tools/preflop-train", priority: 0.6 },
    { path: "/tools/pomodoro", priority: 0.5 },
    { path: "/tools/lifesim", priority: 0.5 },
    { path: "/lifesim/poker-life-sim", priority: 0.4 },
  ];
  return entries.map((e) => ({
    url: BASE + e.path,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: e.priority,
    ...(e.langs
      ? {
          alternates: {
            languages: Object.fromEntries(
              Object.entries(e.langs).map(([k, v]) => [k, BASE + v])
            ),
          },
        }
      : {}),
  }));
}
