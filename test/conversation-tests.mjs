/* 会话生命周期测试：真实管理模块，持久化文件和 Agent 服务用可恢复的桩替换。 */
import { createHost } from "./agent-host.mjs";
export async function runConversationTests({ projectRoot, check, equal }) {
  const files = new Map(), sessions = new Map(), calls = [], deleted = [];
  let sequence = 0, submitted = 0, fail = "", deleteFails = false;
  const install = { id: "test-dsh", type: "dsh", path: "C:\\known\\dsh", command: "dsh.exe", args: [] };
  const options = { dataDirectory: "C:\\data\\sideline", normalize: (p) => String(p).replace(/\//g, "\\"),
    exists: (p) => files.has(p), read: (p) => files.get(p), write: (p, t) => files.set(p, t), mkdir: () => {},
    env: { USERPROFILE: "C:\\user" } };
  function host() {
    const { Sideline: s } = createHost(projectRoot, options);
    s.config.set("textChannel", "agent");
    s.agents.selected = async () => install;
    s.agentinstall.validateInstall = async (p) => {
      if (p !== install.path) throw new Error("unvalidated install"); return install;
    };
    s.agentacp.create = async () => { const id = `id-${++sequence}`; sessions.set(id, []); return id; };
    s.agentacp.discard = async (_, binding) => {
      if (deleteFails) throw new Error("delete failed");
      deleted.push(binding.sessionId); sessions.delete(binding.sessionId);
    };
    s.agentacp.run = async (_, o) => {
      calls.push({ id: o.sessionId, prompt: o.prompt, images: o.images });
      let id = o.sessionId;
      if (id && !sessions.has(id)) { const e = new Error("session missing"); e.resumeFailed = true; throw e; }
      if (!id) { id = `id-${++sequence}`; sessions.set(id, []); }
      await o.onSession(id);
      if (fail === "model") throw new Error("invalid model");
      await o.onPrompt();
      submitted++;
      sessions.get(id).push(o.prompt);
      if (fail === "stop") { const e = new Error("stopped"); e.cancelled = true; e.partialContent = "partial"; throw e; }
      return { content: "answer", model: "test", sessionId: id };
    };
    return s;
  }
  let s = host();
  let messages = [{ role: "system", content: "private material A" }, { role: "user", content: "Q1" }];
  const invoke = (ownerID = 1, warning) => s.agentconversation.execute(install, { ownerID, messages,
    model: "test", onWarning: warning });
  const first = await invoke();
  check("conversation: first request includes instructions and materials", calls.at(-1).prompt.includes("private material A"));
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "Q2" });
  const second = await invoke();
  equal("conversation: next turn reuses native ID", second.sessionId, first.sessionId);
  equal("conversation: unchanged context sends only new question", calls.at(-1).prompt, "Q2");
  const hiddenDigest = s.agentconversation.historyDigest(messages);
  messages[2].uiHidden = true;
  equal("conversation: UI hiding retains native history digest", s.agentconversation.historyDigest(messages), hiddenDigest);
  const discardCountBeforeHide = deleted.length;
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "Q3" });
  messages[0].content = "private material B";
  await invoke();
  equal("conversation: hiding previous reply does not rebuild native session", calls.at(-1).id, first.sessionId);
  equal("conversation: hiding previous reply does not discard native session", deleted.length, discardCountBeforeHide);
  check("conversation: changed material updates without replaying history", calls.at(-1).prompt.includes("private material B")
    && !calls.at(-1).prompt.includes("Q1") && !calls.at(-1).prompt.includes("private material A"));
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "Q4" });
  s = host();
  const restarted = await invoke();
  equal("conversation: restart restores persisted native ID", restarted.sessionId, first.sessionId);
  equal("conversation: restart sends incremental question", calls.at(-1).prompt, "Q4");
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "Q4-tail" });
  const full = messages;
  messages = [messages[0], ...messages.slice(-4)];
  s = host();
  equal("conversation: cropped Sideline history still resumes native context", (await invoke()).sessionId, first.sessionId);
  messages = full;
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "Q5" });
  fail = "stop";
  try { await invoke(); } catch (e) { check("conversation: stop retains partial output", e.cancelled && e.partialContent === "partial"); }
  fail = "";
  messages.push({ role: "assistant", content: "partial" }, { role: "user", content: "Q6" });
  equal("conversation: after stop resumes original native ID", (await invoke()).sessionId, first.sessionId);
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "Q7" });
  sessions.delete(first.sessionId);
  let warning = ""; const before = submitted;
  const recovered = await invoke(1, (w) => { warning = w; });
  check("conversation: missing session rebuilds and warns", recovered.sessionId !== first.sessionId
    && warning && recovered.sessionWarning === warning);
  check("conversation: recovery includes prior context", calls.at(-1).prompt.includes("Q1") && calls.at(-1).prompt.includes("Q7"));
  equal("conversation: recovery submits only one prompt", submitted - before, 1);
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "Q8" });
  fail = "model"; const beforeFailure = calls.length;
  try { await invoke(); } catch (e) { check("conversation: model error is not treated as resume failure", /invalid model/.test(e.message)); }
  equal("conversation: model failure does not start a replacement request", calls.length - beforeFailure, 1);
  fail = "";
  messages = messages.slice(0, 2); messages[1].content = "edited Q1";
  const edited = await invoke();
  check("conversation: edited branch rebuilds native context", edited.sessionId !== recovered.sessionId
    && !calls.at(-1).prompt.includes("Q7") && deleted.includes(recovered.sessionId));
  const other = await invoke(2);
  check("conversation: separate papers have different native IDs", other.sessionId !== edited.sessionId);
  const forced = await s.agentconversation.execute(install, { ownerID: 2, messages, model: "test", rebuild: true });
  check("conversation: explicit retry rebuilds even an identical branch", forced.sessionId !== other.sessionId);
  await s.agentconversation.reset(1);
  const blank = await s.agentconversation.binding(1);
  check("conversation: clear deletes old memory and creates blank ACP session", deleted.includes(edited.sessionId)
    && blank.sessionId !== edited.sessionId && sessions.get(blank.sessionId).length === 0);
  messages = [{ role: "system", content: "new material" }, { role: "user", content: "new Q" }];
  equal("conversation: first send after clear uses newly created session", (await invoke()).sessionId, blank.sessionId);
  deleteFails = true;
  try { await s.agentconversation.reset(1); } catch (e) { check("conversation: deletion failure is reported", /delete failed/.test(e.message)); }
  check("conversation: failed clear forbids restoring old context", (await s.agentconversation.binding(1)).resetPending === true);
  const beforeBlocked = calls.length;
  try { await invoke(); } catch (e) { check("conversation: cleanup failure blocks reuse", /delete failed/.test(e.message)); }
  equal("conversation: failed cleanup makes no model call", calls.length, beforeBlocked);
  deleteFails = false;
  const saved = [...files.values()].join("");
  check("conversation: mapping contains IDs and digests without text", !saved.includes("private material") && !saved.includes("edited Q1"));
  const image = "data:image/png;base64,AA==", otherImage = "data:image/png;base64,AQ==";
  messages = [{ role: "system", content: "看图" }, { role: "user", content: "图中是什么？", images: [image] }];
  const imageFirst = await invoke(3);
  equal("conversation images: first send includes image", calls.at(-1).images[0], image);
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "继续解释" });
  s = host();
  const imageSecond = await invoke(3);
  equal("conversation images: restart continues same native ID", imageSecond.sessionId, imageFirst.sessionId);
  equal("conversation images: existing image is not sent again", calls.at(-1).images.length, 0);
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "对比新图", images: [otherImage] });
  await invoke(3);
  check("conversation images: only new image is appended", calls.at(-1).images.length === 1 && calls.at(-1).images[0] === otherImage);
  sessions.delete(imageFirst.sessionId);
  messages.push({ role: "assistant", content: "answer" }, { role: "user", content: "重新解释" });
  await invoke(3);
  check("conversation images: recovery supplies retained images", calls.at(-1).images.length === 2 && calls.at(-1).images.includes(image));
  check("conversation images: bindings store digests without image bytes", ![...files.values()].join("").includes("data:image"));
}
