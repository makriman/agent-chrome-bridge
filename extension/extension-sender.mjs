// Page scripts cannot forge chrome.runtime messages. This check is the
// content-script gate: accept only this extension, and reject any sender
// whose origin or URL is a web page.
export function isTrustedExtensionSender(sender, extensionId) {
  if (!sender || !extensionId || sender.id !== extensionId) return false;
  const extensionOrigin = `chrome-extension://${extensionId}`;
  if (typeof sender.origin === "string" && sender.origin && sender.origin !== extensionOrigin) return false;
  if (typeof sender.url === "string" && sender.url && !sender.url.startsWith(`${extensionOrigin}/`)) return false;
  return true;
}
