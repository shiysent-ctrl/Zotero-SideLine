/* OpenCode ACP 适配器。输入/输出与 agentacp 相同；发现仅接受 opencode-ai 或原生桌面布局。 */
Sideline.opencode = {
  discover: async () => (await Sideline.agentinstall.discover()).filter((entry) => entry.type === "opencode"),
  validateInstall: Sideline.agentinstall.validateInstall,
  probe: Sideline.agentacp.probe, listModels: Sideline.agentacp.listModels,
  run: Sideline.agentacp.run, cancel: Sideline.agentacp.cancel,
};
