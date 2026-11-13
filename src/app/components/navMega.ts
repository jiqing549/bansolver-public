import { TOOLS, type Tool } from "./tools";

export type MegaCategory = {
  id: string;
  num: string;
  title: string;
  en: string;
  desc: string;
  tools: Tool[];
};

type CategoryDef = Omit<MegaCategory, "tools"> & { ids: string[] };

const DEFS: CategoryDef[] = [
  {
    id: "review",
    num: "01",
    title: "牌局复盘",
    en: "REVIEW",
    desc: "曲线、统计、去重，先分清技术问题和波动。",
    ids: ["ban2note"],
  },
  {
    id: "range",
    num: "02",
    title: "范围与训练",
    en: "RANGE & DRILL",
    desc: "查 GTO 范围、做随机出题，把翻前决策练成肌肉记忆。",
    ids: ["preflop", "pftrain"],
  },
  {
    id: "calc",
    num: "03",
    title: "计算与求解",
    en: "CALC & SOLVE",
    desc: "胜率、EV、结算和翻后求解，该算的都在这。",
    ids: ["solver", "squid", "equity"],
  },
  {
    id: "play",
    num: "04",
    title: "专注与娱乐",
    en: "FOCUS & PLAY",
    desc: "控制节奏、管理心态，顺手玩一把。",
    ids: ["pomodoro", "lifesim"],
  },
];

export const MEGA_CATEGORIES: MegaCategory[] = DEFS.map(({ ids, ...rest }) => ({
  ...rest,
  tools: ids
    .map((id) => TOOLS.find((t) => t.id === id))
    .filter((t): t is Tool => Boolean(t)),
}));

/** 顶栏常驻的三个核心入口里，两个站内工具（Solver 是弹窗按钮） */
export const CORE_NAV_TOOLS = ["ban2note", "preflop"]
  .map((id) => TOOLS.find((t) => t.id === id))
  .filter((t): t is Tool => Boolean(t));
