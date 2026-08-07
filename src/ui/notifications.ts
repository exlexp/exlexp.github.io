export async function requestLocalNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in globalThis)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export function showLocalMessageNotification(
  profileName: string,
  conversationTitle: string,
  body: string,
  showPreview: boolean,
): boolean {
  if (!('Notification' in globalThis) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return false;
  const notification = new Notification(`${conversationTitle} · ${profileName}`, {
    body: showPreview ? body : 'New message — preview hidden locally',
    icon: `${import.meta.env.BASE_URL}icon.svg`,
    tag: `relayless:${profileName}:${conversationTitle}`,
    silent: false,
  });
  notification.onclick = () => window.focus();
  return true;
}
