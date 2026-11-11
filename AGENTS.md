# AGENTS.md — dualtran-vscode 协作者铁律

本文件对在本仓库工作的任何 agent/协作者生效。完整产品规范见
`DualTran-manage/host-conformance/SPEC.md` v2；本仓库的 `conformance.json` 声明了
宿主 id、payload 生成器与平台上限。

## 宿主一致性铁律（最高优先级）

任何翻译/设置 UI 改动必须满足五条产品规则：

1. 目标语言、AI provider、AI model 三处一律选择器；禁止让用户输语言代码/provider id/model id。
2. **provider 列表 = 内建 + models.dev 合并成单一字母序列表**；禁止 divider / disabled 分隔项 /
   `──── More ────`；别名去重；自定义 provider 最后。model 列表按 provider 联动、按标签排序，
   自定义 model 最后。
3. endpoint 的 **value**（不是 placeholder）随 provider 自动带入；用户改过的值不被覆盖。
4. 推理强度默认哨兵 `lowest`，请求前解析 `none → minimal → low`；模型未声明则不发参数。
5. 界面文字全部走 i18n；平台上限只能写进 `conformance.json` 的 `platformLimits` 并给证据。

## 门禁

```bash
node --test tests/*.test.js
npm run conformance
npm run package
```

- 改设置 UI 必须同时更新 payload 测试；禁止删除断言来“修绿”。
- `npm run conformance` 先跑 12 个内置反例（阴性对照），再校验真实控件；CI 必须运行。
- 旧分组「内建 → 分隔 → models.dev」已于 2026-11-11 被用户口径废止，不要恢复。
- 平台限制只能写在 `conformance.json`，不能口头豁免；新宿主没有 gate 不得发版。
