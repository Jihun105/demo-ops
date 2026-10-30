import { Capacitor, registerPlugin } from '@capacitor/core';
const secure = registerPlugin('DemoSession');
export function sessionStorage(store) {
  const native =
    Capacitor.isNativePlatform() && ['android', 'ios'].includes(Capacitor.getPlatform());
  return {
    async getItem(key) {
      return native ? (await secure.get({ key })).value : ((await store.get(key)) ?? null);
    },
    async setItem(key, value) {
      if (native) await secure.set({ key, value });
      else await store.set(key, value);
    },
    async removeItem(key) {
      if (native) await secure.remove({ key });
      else await store.remove(key);
    },
  };
}
export const sessionKey = (url) => `demo-auth-${new URL(url).hostname}`;
