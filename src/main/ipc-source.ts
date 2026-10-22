interface RequestWindow {
  webContents: { mainFrame: unknown };
}
interface RequestSource {
  sender: unknown;
  senderFrame: unknown;
}
/** The same main-window/main-frame check is used for existing and permission IPC. */
export function assertRequestSource(
  window: RequestWindow | undefined,
  source: RequestSource,
): void {
  if (
    !window ||
    source.sender !== window.webContents ||
    source.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("不受信任的调用来源");
}
