# Zotero Sideline

在 Zotero PDF 阅读器中与文献对话，并把有用的回答保存为子笔记。支持 OpenAI 兼容 API，以及本机 Codex、OpenCode、DeepSeek Harness；可加入正文、选区、笔记和图片，沿用每篇文献自己的会话。

**支持环境：Windows + Zotero 10。当前版本：1.0.0，2026-10-05 覆盖更新。** 本次保留版本号，更新源码、安装包及现有发布页；已安装早期 1.0.0 的用户需手动重新下载并覆盖安装。当前代码通过静态与假宿主检查，自动高亮、撤销及最新交互修复仍需真实 Zotero 验收，见[验收清单](docs/验收.md)。

[已发布安装包](https://github.com/shiysent-ctrl/Zotero-SideLine/releases/tag/v1.0.0) · [反馈问题](https://github.com/shiysent-ctrl/Zotero-SideLine/issues) · [开发说明](docs/设计.md)

## 功能

| 功能 | 当前源码中的行为 |
| --- | --- |
| 文献对话 | 全文总结、解释选区、文本翻译和自由提问；按需加入当前页、全文、选区、笔记、文件或图片 |
| 文字与图片 | API 分别配置文字与视觉接口；Agent 使用当前选定程序及模型，不静默切换通道 |
| 原文定位 | 点击页码跳页，完整引文核验后定位；自动高亮从实际 PDF 字符生成批注位置 |
| 笔记与撤销 | 从回复菜单保存该回答及提问为新子笔记；普通回复可隐藏，高亮回复按所属批次撤销并保护已编辑批注 |
| 会话使用 | 每篇文献一场会话；检索可见内容并定位命中气泡，正文可拖选，右键全选/复制，支持 Markdown/JSON 导出 |
| 离线排版 | Markdown、代码和本地 KaTeX 公式渲染，公式资源随插件分发 |

自动高亮由用户显式执行，直接创建可靠匹配的批注。失败在原回复中说明，不自动发起修复请求；长文按预算分段，重试只处理失败段。该功能及撤销修复仍待真机验收，请先使用专用测试文献。

## 安装

1. 下载已发布的 [zotero-sideline-1.0.0.xpi](https://github.com/shiysent-ctrl/Zotero-SideLine/releases/download/v1.0.0/zotero-sideline-1.0.0.xpi)，或按下方开发命令构建当前源码。源码 ZIP 不能直接作为插件安装。
2. 在 Zotero“工具 → 插件”中选择“从文件安装插件”，选中 XPI 后重启。
3. 打开“设置 → Sideline”，选择 API 或 Agent 通道并配置连接。

插件不附带模型账户或外部 Agent。API 需要对应服务商账户；Agent 需要提前安装并完成自己的登录或服务商配置。升级采用手动安装，`updates.json` 保留空更新列表。

## 配置与使用

**API**：填写文字接口的基址、密钥和模型；图片问题另选支持图片的视觉模型。视觉接口可沿用文字基址与密钥，但仍需独立测试。文字和视觉超时分别配置，综合检测只有两者实际请求均成功才显示绿色。

**Agent**：先扫描选择安装，或添加有效的安装目录；再依次执行“离线检测模型 → 选择模型 → 验证请求协议 → 选择思考强度 → 测试连接”。Agent 模型从已读目录选择，支持图片的能力按具体模型验证。重新打开设置保留选择，不自动扫描或请求模型。

1. 打开 PDF，在阅读器侧栏点击 **AI**。
2. 用回形针“添加材料”，或在 PDF 中划词后加入对话。
3. 选择功能或直接提问；Enter 发送，Shift+Enter 换行，可粘贴图片。
4. 从已完成回复的 `⋯` 菜单保存子笔记、修改提问或撤销回复。正文右键“全选”只选择当前气泡，“复制”优先取选中文字，没有选区时取整段正文。

输入关键词后点击放大镜“检索对话”，结果只包含当前文献的可见消息；点击命中定位到对应气泡。四项功能的提示词在设置中单独修改。划词弹窗的快捷功能为文本翻译。

## 数据与边界

- 会话作为父文献下的 JSON 附件保存；独立 PDF 没有父条目时只能保留内存会话，自动高亮需要父文献及启用会话保存。旧多会话数据加载后只保留最近一场。
- Agent 原生会话映射存于本机，不随 Zotero 附件同步。停止保留问题及已生成内容；清空聊天重置本篇会话，保留已写入的笔记和批注。
- 隐藏普通回复只改变界面，不删除模型历史。Markdown/JSON 导出保留原始历史契约，可能包含隐藏回答和高亮原始数据。
- 模型请求会把选定材料与必要上下文发送给对应服务商或 Agent。密钥保存在 Zotero 首选项；Agent 默认拒绝文件写入、终端和未知工具，联网开关只开放经过校验的搜索与网页读取。
- 扫描页需先获得带位置的文字层；插件不增加 OCR。缺少可靠几何或有歧义时不给出伪位置，正文相似度不能证明公式语义等价。
- 本机 HTTP 接口没有独立鉴权，本机程序可调用；写入接口保留，调用者应明确授权具体操作。见[接口说明](docs/接口.md)。

本次更新保留插件 ID、存档 v3 和有效旧配置，可读取初始 1.0.0 记录。安装前保留旧 XPI，并备份需要验证的实际 Sideline 会话 JSON 附件。初始发布包会丢弃新增的隐藏与批次字段，回退后继续保存可能失去撤销信息；同名包应按发布日期及 SHA-256 区分，重新安装旧 XPI 不等于恢复会话数据。

## 开发

需要 Windows PowerShell、Node.js 和 Python 3；无需安装 npm 或 pip 依赖。CI 使用 Node.js 22、Python 3.12。

```powershell
git clone https://github.com/shiysent-ctrl/Zotero-SideLine.git
cd Zotero-SideLine
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

构建生成 `runtime/zotero-sideline.xpi` 和版本化 XPI。`runtime/` 是自动生成的忽略目录，不属于源码仓库。

```text
src/        插件源码、资源和随包许可证
test/       假宿主回归与项目内夹具
scripts/    检查、测试、构建及独立导出
docs/       设计、接口和验收说明
.github/    Windows 候选构建 CI
```

运行 `scripts/release.ps1` 可从允许清单导出独立源码、重新检查和测试、连续构建两次并核对包内字节，生成 XPI、源码 ZIP、验证摘要和 SHA-256；加 `-ListOnly` 仅查看清单。GitHub Actions 上传候选产物，不自动创建 Release。源码、测试和文档随 Git 提交，安装包、日志、会话、索引及本机配置排除。

[开发说明](docs/设计.md)介绍模块职责与数据约定，[CHANGELOG](CHANGELOG.md)记录版本变化。提交问题时请提供版本、通道、模型、复现步骤和错误原文，并移除密钥、私人路径和文献内容。

原创代码采用 [MIT](LICENSE)；随包 KaTeX 及字体保留上游许可证，见[第三方声明](THIRD_PARTY_NOTICES.md)。
