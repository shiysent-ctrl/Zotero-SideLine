# 第三方软件与资源

Sideline 原创代码采用根目录 [MIT 许可证](LICENSE)。该许可证不替代以下上游声明。

## KaTeX 0.18.9

插件随包包含 KaTeX 浏览器分发的 `katex.min.js`、`katex.min.css` 与 CSS 使用的 WOFF2 字体，用于离线数学排版。来源为 npm 包 `katex@0.18.9`，本地供应清单声明未修改；见 [vendor README](src/vendor/katex/README.md)。

原许可证为 MIT，署名：`Copyright (c) 2013-2020 Khan Academy and other contributors`。完整许可证在 [src/vendor/katex/LICENSE](src/vendor/katex/LICENSE)。打包与再次分发必须同时保留该文件及对应资源。

## 外部运行环境与服务

Zotero、Codex、OpenCode、DeepSeek Harness、Node.js、Python 及模型服务不是 Sideline 随包代码；用户另行安装或使用，并遵循各自许可与服务条款。插件通过宿主接口、固定 CLI 或 ACP 与其交互；对协议的兼容不表示包含该应用的源代码或授予其许可。

Sideline 为自主实现，不包含 Awesome GPT 的代码。本清单依据当前 `src/vendor/` 与源码资源扫描；今后新增第三方代码、字体或图标时，需补来源、版本、修改情况和完整许可，再纳入安装包。
