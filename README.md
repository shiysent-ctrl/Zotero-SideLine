# Zotero Sideline

在 Zotero PDF 阅读器中与文献对话，按需加入正文、选区、笔记或图片，并把选中的回答保存为子笔记。支持 OpenAI 兼容 API，以及本机 Codex、OpenCode、DeepSeek Harness。

**1.0.0 · 首次公开发布 · Windows＋Zotero 10。** 支持 Markdown 与离线公式排版。首发业务代码基于已在 Zotero 10.0.5 验证的 0.11.0 候选，覆盖安装、API 文字/视觉、三个 Agent 的文字/图片和侧栏基本对话；完整范围及待验证项见[验收记录](docs/验收.md)。

[下载安装包](https://github.com/shiysent-ctrl/Zotero-SideLine/releases/tag/v1.0.0) · [提交问题](https://github.com/shiysent-ctrl/Zotero-SideLine/issues) · [开发说明](docs/设计.md)

## 安装

1. 下载 [zotero-sideline-1.0.0.xpi](https://github.com/shiysent-ctrl/Zotero-SideLine/releases/download/v1.0.0/zotero-sideline-1.0.0.xpi)。不要把 GitHub 的源码 ZIP 当作插件安装。
2. 在 Zotero 的“工具 → 插件”中选择“从文件安装插件”，选中 XPI，重启 Zotero。
3. 打开“设置 → Sideline”，选择默认处理通道并完成配置。

1.0.0 保留插件 ID，可覆盖安装已有版本。升级时手动下载并重新安装 XPI。仓库中的 `updates.json` 是 Zotero 所需的 HTTPS 更新清单，保持空更新列表。

使用 API 需自行准备支持相应模型的服务商账户；使用 Agent 需先在本机安装并完成对应 Agent 的登录或服务商配置。插件不附带模型、账户或外部 Agent 程序。

## 配置通道

| 默认通道 | 文字问题 | 图片问题 |
|---|---|---|
| API | 文字接口 | 视觉接口 |
| Agent | 当前 Agent | 当前 Agent 的图片输入 |

**API**：填写文字接口的基址、密钥与模型；图片使用视觉接口，可沿用文字接口的基址与密钥，但仍需指定支持图片的模型并独立测试。文字、视觉的超时可分别设置。刷新模型读取目录，测试连接会发送最小模型请求；顶部综合检测只有文字和视觉均通过才显示绿色。

**Agent**：先自行安装并配置 Codex、OpenCode 或 DeepSeek Harness，再在 Sideline 扫描选择，或添加安装路径。按顺序操作：

1. 离线检测模型，刷新模型列表。
2. 从列表选择模型。
3. 验证请求协议，读取所选模型的思考强度能力。
4. 选择思考强度，“默认 / 不指定”也可。
5. 测试连接。

Agent 模式下文字和图片均交给当前 Agent，不使用视觉 API，也不自动回退 API。图片能力取决于模型和 Agent 的实际支持。联网检索默认关闭，可在设置中启用；它与调用远端模型是不同能力。

## 阅读与对话

打开 PDF，点击阅读器工具栏或侧栏的“AI”显示 Sideline。输入问题，Enter 发送，Shift+Enter 换行。

- **功能**：全文总结、解释选区、文本翻译、自动高亮。设置中可逐项改写提示词，留空使用内置；提示词不显示在对话里。划词弹窗的翻译与侧栏文本翻译使用同一提示词。
- **＋**：加入当前页、加入全文、选择文件、检索笔记。也可直接粘贴图片。普通文本粘贴仍进入输入框。
- **回答**：支持 Markdown 与离线公式渲染。点选一条或多条回答，再点“加入子笔记”，新建一条带来源链接的子笔记。回答菜单提供重试、修改提问、复制；高亮候选另有预览入口。
- **会话**：每篇文献一场 Sideline 会话，对应一个 Agent 原生会话。后续问题继续原会话；恢复失败时新建并补入上下文，状态行红字提示。清空会话同时重置本篇 Agent 会话，保留已经写入的笔记和批注。顶栏菜单可导出 Markdown 或 JSON。

划选 PDF 文字后，弹窗可翻译、提问或把选区加入侧栏。存为批注需要有效坐标与相应设置开关；没有坐标时仍可保存为笔记。

## 定位与高亮

回答中的页码可点击跳转。带逐字原文锚点时，插件在对应页核验完整原文，再跳转并短暂高亮；匹配失败会说明原因并只跳页。

自动高亮由模型建议原文片段，插件在 PDF 中计算位置，再由用户预览、选择并确认写入。当前高亮候选允许短前缀近似匹配，会标明“近似匹配”；确认前请检查范围。模型不提供批注坐标，定位失败的候选不能写入。

## 数据与边界

- 会话保存为文献条目下的 JSON 附件；没有父条目的独立 PDF 会话只保存在内存。图片会随会话保存。升级旧版多会话数据时，只保留最近一场，其余删除。
- Agent 会话映射保存在本机，不随 Zotero 会话附件同步。Agent 默认只读，文件、终端和未知工具请求拒绝；启用检索后仅允许经过校验的搜索及网页读取。
- 服务商密钥保存在 Zotero 首选项，不是加密保管库。模型请求会发送选定材料及所需上下文给对应服务商或 Agent。
- 扫描 PDF 没有文字层时需先取得 OCR 正文。外部 PDF 文件不能当作已索引全文读取；已导入的 PDF 请用“加入全文”。网络链接不会由材料入口自动下载。
- 本机 HTTP 端点由 Zotero 提供，默认地址为 `127.0.0.1:23119`；端点不回显密钥，但没有独立鉴权，本机程序可调用。写入端点也保留，调用者应显式授权具体写入。见[接口说明](docs/接口.md)。

## 开发与许可

需 Windows PowerShell、Node.js 与 Python 3；检查和构建脚本不需要安装 npm 或 pip 依赖。CI 使用 Node.js 22、Python 3.12。

```powershell
git clone https://github.com/shiysent-ctrl/Zotero-SideLine.git
cd Zotero-SideLine
```

在项目根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

源码位于 `src/`，构建产物位于 `runtime/`。构建输出 `runtime/zotero-sideline.xpi` 与版本化 XPI。

独立发布候选通过以下命令生成，`-ListOnly` 可只读查看导出清单：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1
```

每次输出新的 `runtime/release-1.0.0-<唯一后缀>/`，内含独立 `source/`、版本化 XPI、源码 ZIP、`validation.json` 和 `SHA256SUMS.txt`。脚本在独立树检查、测试并重复构建；Windows CI 只上传候选产物，不自动发布 GitHub Release。

开发结构、发布流程见[开发说明](docs/设计.md)，版本变化见[CHANGELOG](CHANGELOG.md)。Git 保留文件原始换行，使 Windows 检出后的构建与发布包字节一致。

## 反馈与贡献

请在 [Issues](https://github.com/shiysent-ctrl/Zotero-SideLine/issues) 中提供 Zotero/插件版本、使用的 API 或 Agent、模型、复现步骤和错误原文。分享诊断前去除密钥、认证信息、私人路径和文献内容。

提交改动前运行检查、回归和构建；涉及设置、阅读器或 Agent 的变化同时说明实际真机验证范围。欢迎通过 Pull Request 提交修复。

Sideline 原创代码采用 [MIT](LICENSE)。随包分发的 KaTeX 及字体保留其原许可证，见[第三方声明](THIRD_PARTY_NOTICES.md)。外部 Agent 与模型服务不随插件分发。
