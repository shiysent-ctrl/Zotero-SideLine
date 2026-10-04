/* DeepSeek Harness ACP 适配器。只启动官方固定 Node 模式入口，禁止 headless 长参数及桌面 GUI。 */
Sideline.dsh = {
  discover: async () => (await Sideline.agentinstall.discover()).filter((entry) => entry.type === "dsh"),
  validateInstall: Sideline.agentinstall.validateInstall,
  probe: Sideline.agentacp.probe, listModels: Sideline.agentacp.listModels,
  run: Sideline.agentacp.run, cancel: Sideline.agentacp.cancel,
};
