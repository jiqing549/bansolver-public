/* ================================================================
   荣耀致谢名单 —— Ban2Note 左侧宽屏留白区滚动栏数据
   ================================================================
   改名单只动这个文件，不用碰组件和样式。

   字段：
     name   微信昵称（必填；头像缺省时取首字符做金环占位）
     avatar 头像路径（可选）：微信群头像图另存为 jpg/png，
            丢进 public/credits/，这里填 "/credits/文件名.jpg"。
            不填或图片 404 时自动降级为首字母金环。
     note   第二行小字：贡献说明，如「提供 EV 跑马对拍样本」。

   ⚠️ 名单不足一屏时荣耀栏自动静态展示（不滚动），
   条目高度超过滚动视窗后自动开始无缝循环滚动。
   ================================================================ */

export interface CreditEntry {
  name: string;
  avatar?: string;
  note: string;
}

export const CREDITS: CreditEntry[] = [
  { name: "信念🔥", avatar: "/credits/xinian.jpg", note: "协助开发立大功" },
  { name: "Lowry", avatar: "/credits/lowry.jpg", note: "debug高手" },
  { name: "七么么么", avatar: "/credits/qimememe.jpg", note: "debug高手" },
  // 🩵 = U+1FA75 Light Blue Heart（Unicode 15.0，2022），emoji 本身即 ID
  { name: "🩵", avatar: "/credits/blueheart.jpg", note: "新功能建议" },
  { name: "瓜子", avatar: "/credits/guazi.jpg", note: "debug高手" },
  { name: "萬士撲克", avatar: "/credits/wanshi.jpg", note: "新功能建议" },
];
