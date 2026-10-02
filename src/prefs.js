/*
 * Zotero Sideline 默认首选项。
 * Zotero 会在插件启用时把本文件作为默认首选项载入（分支 extensions.zotero.sideline），
 * 禁用或卸载时清除；因此这里只放默认值，不写用户数据。
 */

pref("extensions.zotero.sideline.api", "https://api.deepseek.com/v1");
pref("extensions.zotero.sideline.model", "deepseek-chat");
pref("extensions.zotero.sideline.secretKey", "");
pref("extensions.zotero.sideline.temperature", "0.7");
pref("extensions.zotero.sideline.maxTokens", 4096);
pref("extensions.zotero.sideline.stream", true);
pref("extensions.zotero.sideline.requestTimeoutMs", 120000);
pref("extensions.zotero.sideline.visionRequestTimeoutMs", 120000);
pref("extensions.zotero.sideline.systemPrompt", "你是 Zotero 中的文献阅读助手。只依据提供的条目上下文回答；上下文没有的信息要明确说明未见，不要补写。输出简体中文，使用 Markdown，公式用 $...$ 或 $$...$$。");
pref("extensions.zotero.sideline.contextMode", "metadata+fulltext");
pref("extensions.zotero.sideline.maxContextChars", 24000);
pref("extensions.zotero.sideline.historyTurns", 4);
pref("extensions.zotero.sideline.prompts", "");
pref("extensions.zotero.sideline.noteHeading", "Sideline");
pref("extensions.zotero.sideline.readerEnabled", true);
pref("extensions.zotero.sideline.readerTemplates", "translate,explain,summarize");
pref("extensions.zotero.sideline.readerAnnotationWrite", true);
pref("extensions.zotero.sideline.readerAnnotationColor", "#ffd400");
pref("extensions.zotero.sideline.persistSessions", true);
pref("extensions.zotero.sideline.maxStoredItems", 200);
pref("extensions.zotero.sideline.maxStoredMessages", 60);
pref("extensions.zotero.sideline.codexPath", "");
pref("extensions.zotero.sideline.codexModel", "");
pref("extensions.zotero.sideline.codexEffort", "low");
pref("extensions.zotero.sideline.codexTimeoutMs", 180000);
pref("extensions.zotero.sideline.provider", "deepseek");
pref("extensions.zotero.sideline.deepseekVisionModel", "");
pref("extensions.zotero.sideline.promptSummarize", "");
pref("extensions.zotero.sideline.promptExplain", "");
pref("extensions.zotero.sideline.promptTranslate", "");
pref("extensions.zotero.sideline.promptHighlight", "");
pref("extensions.zotero.sideline.readerPanelEnabled", true);
pref("extensions.zotero.sideline.readerPanelWidth", 380);
pref("extensions.zotero.sideline.highlightMaxItems", 12);
pref("extensions.zotero.sideline.noteSearchMaxHits", 3);
pref("extensions.zotero.sideline.fileMaxChars", 20000);
pref("extensions.zotero.sideline.coverageMaxPages", 0);
pref("extensions.zotero.sideline.ocrEnabled", true);
pref("extensions.zotero.sideline.historySearchMaxHits", 20);

// 0.9.0: independent API channels and validated Agent registry; legacy keys remain.
pref("extensions.zotero.sideline.textChannel", "");
pref("extensions.zotero.sideline.textApi", "");
pref("extensions.zotero.sideline.textSecretKey", "");
pref("extensions.zotero.sideline.textModel", "");
pref("extensions.zotero.sideline.visionUseText", true);
pref("extensions.zotero.sideline.visionApi", "");
pref("extensions.zotero.sideline.visionSecretKey", "");
pref("extensions.zotero.sideline.visionModel", "");
pref("extensions.zotero.sideline.agentInstallId", "");
pref("extensions.zotero.sideline.agentInstalls", "[]");
pref("extensions.zotero.sideline.agentModel", "");
pref("extensions.zotero.sideline.agentEffort", "");
pref("extensions.zotero.sideline.agentTimeoutMs", 180000);
pref("extensions.zotero.sideline.agentSearch", false);
