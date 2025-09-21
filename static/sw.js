// static/sw.js

self.addEventListener('install', () => { console.log('[SW] install'); self.skipWaiting(); });
self.addEventListener('activate', (event) => { console.log('[SW] activate'); event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Walkie-Talkie', body: 'New ping' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Walkie-Talkie', {
      body: data.body || '',
      icon: '/icons/chat_icon192.png',   // PNG 192x192
      badge: '/icons/chat_icon72.png',    // PNG 72x72 (monochrome)
      tag: 'walkie-msg',                // collapses older notifications of same tag
      renotify: true,
      data
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] notificationclick');
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) { if ('focus' in client) return client.focus(); }
    if (clients.openWindow) return clients.openWindow('/');
  })());
});

// Optional: when the browser rotates the push subscription, re-subscribe
self.addEventListener('pushsubscriptionchange', async (event) => {
  try {
    const keyResp = await fetch('/vapid-public-key');
    const { publicKey } = await keyResp.json();
    const appServerKey = (function urlB64ToUint8Array(base64String){
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = atob(base64); const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
      return outputArray;
    })(publicKey);

    const newSub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey
    });

    await fetch('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: newSub, alias: 'unknown', user_id: null })
    });
  } catch(e) {
    // ignore
  }
});

