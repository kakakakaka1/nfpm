// ==UserScript==
// @name         NS-DF 私信完整历史备份版（草案）
// @namespace    https://www.nodeseek.com/
// @version      0.1.0
// @description  按 message_id 保存完整私信历史，而不是只保留每个联系人最后一条
// @author       OpenClaw
// @match        https://www.nodeseek.com/notification*
// @match        https://www.deepflood.com/notification*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      www.nodeseek.com
// @connect      www.deepflood.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const SiteRegistry = [
    {
      id: 'ns',
      label: 'NodeSeek',
      hosts: ['www.nodeseek.com'],
      apiBase: 'https://www.nodeseek.com/api',
      referer: 'https://www.nodeseek.com/',
      systemNotificationUserId: 5230,
    },
    {
      id: 'df',
      label: 'DeepFlood',
      hosts: ['www.deepflood.com'],
      apiBase: 'https://www.deepflood.com/api',
      referer: 'https://www.deepflood.com/',
      systemNotificationUserId: 10,
    },
  ];

  function detectActiveSite() {
    const host = window.location.hostname;
    return SiteRegistry.find((s) => s.hosts.includes(host));
  }

  const site = detectActiveSite();
  if (!site) return;

  class APIClient {
    constructor(site) {
      this.site = site;
      this.baseUrl = site.apiBase;
      this.referer = site.referer;
    }

    async request(url, options = {}) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: options.method || 'GET',
          url,
          headers: {
            Accept: 'application/json',
            Referer: this.referer,
            ...(options.headers || {}),
          },
          data: options.data,
          onload: (response) => {
            try {
              if (response.status !== 200) {
                reject(new Error(`HTTP ${response.status}: ${response.statusText}`));
                return;
              }
              resolve(JSON.parse(response.responseText));
            } catch (e) {
              reject(e);
            }
          },
          onerror: reject,
          ontimeout: () => reject(new Error('request timeout')),
        });
      });
    }

    async getMessageList() {
      return this.request(`${this.baseUrl}/notification/message/list`);
    }

    async getChatMessages(userId) {
      return this.request(`${this.baseUrl}/notification/message/with/${userId}`);
    }
  }

  class ChatDB {
    constructor(userId, site) {
      this.userId = userId;
      this.site = site;
      this.dbName = `${site.id}_chat_full_${userId}`;
      this.version = 1;
      this.db = null;
    }

    async init() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.version);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          this.db = request.result;
          resolve();
        };
        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          if (!db.objectStoreNames.contains('messages')) {
            const store = db.createObjectStore('messages', {
              keyPath: 'message_id',
            });
            store.createIndex('member_id', 'member_id', { unique: false });
            store.createIndex('created_at', 'created_at', { unique: false });
            store.createIndex('pair_key', 'pair_key', { unique: false });
          }

          if (!db.objectStoreNames.contains('dialogs')) {
            const store = db.createObjectStore('dialogs', {
              keyPath: 'member_id',
            });
            store.createIndex('last_created_at', 'last_created_at', { unique: false });
          }

          if (!db.objectStoreNames.contains('metadata')) {
            db.createObjectStore('metadata', { keyPath: 'key' });
          }
        };
      });
    }

    tx(storeNames, mode = 'readonly') {
      return this.db.transaction(storeNames, mode);
    }

    async putMessage(msg) {
      const tx = this.tx(['messages'], 'readwrite');
      const store = tx.objectStore('messages');
      return new Promise((resolve, reject) => {
        const req = store.put(msg);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }

    async putDialog(dialog) {
      const tx = this.tx(['dialogs'], 'readwrite');
      const store = tx.objectStore('dialogs');
      return new Promise((resolve, reject) => {
        const req = store.put(dialog);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }

    async getAllDialogs() {
      const tx = this.tx(['dialogs']);
      const store = tx.objectStore('dialogs');
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    }

    async exportAll() {
      const dialogs = await new Promise((resolve, reject) => {
        const req = this.tx(['dialogs']).objectStore('dialogs').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      const messages = await new Promise((resolve, reject) => {
        const req = this.tx(['messages']).objectStore('messages').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      return { dialogs, messages };
    }
  }

  function normalizeMessage(raw, currentUserId, memberId, memberName) {
    const pair = [raw.sender_id, raw.receiver_id].sort((a, b) => a - b).join(':');
    return {
      message_id: raw.message_id,
      member_id: memberId,
      member_name: memberName,
      sender_id: raw.sender_id,
      receiver_id: raw.receiver_id,
      direction: raw.sender_id === currentUserId ? 'out' : 'in',
      content: raw.content || '',
      viewed: raw.viewed ?? 0,
      updated_at: raw.updated_at || null,
      created_at: raw.created_at || null,
      pair_key: pair,
      raw,
    };
  }

  async function resolveCurrentUserId(api) {
    const systemUserId = site.systemNotificationUserId;
    const probe = await api.getChatMessages(systemUserId);
    if (probe?.success && Array.isArray(probe.msgArray)) {
      for (const msg of probe.msgArray) {
        if (msg.sender_id === systemUserId && Number.isFinite(msg.receiver_id)) return msg.receiver_id;
        if (msg.receiver_id === systemUserId && Number.isFinite(msg.sender_id)) return msg.sender_id;
      }
    }
    throw new Error('无法获取用户ID');
  }

  async function syncAllHistory() {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();

    const listData = await api.getMessageList();
    const dialogs = listData?.msgArray || listData?.list || listData?.data || [];

    let dialogCount = 0;
    let messageCount = 0;

    for (const dialog of dialogs) {
      const memberId = dialog.member_id || dialog.uid || dialog.user_id || dialog.id;
      if (!memberId) continue;
      const memberName = dialog.member_name || dialog.username || dialog.name || String(memberId);

      const detail = await api.getChatMessages(memberId);
      const msgArray = detail?.msgArray || detail?.data || [];

      let lastCreatedAt = null;
      let lastMessage = '';
      for (const raw of msgArray) {
        if (!raw?.message_id) continue;
        const msg = normalizeMessage(raw, currentUserId, memberId, memberName);
        await db.putMessage(msg);
        messageCount += 1;
        if (!lastCreatedAt || (msg.created_at && msg.created_at > lastCreatedAt)) {
          lastCreatedAt = msg.created_at;
          lastMessage = msg.content;
        }
      }

      await db.putDialog({
        member_id: memberId,
        member_name: memberName,
        last_created_at: lastCreatedAt,
        last_message: lastMessage,
        fetched_at: new Date().toISOString(),
      });
      dialogCount += 1;

      await new Promise((r) => setTimeout(r, 400));
    }

    alert(`完整历史同步完成\n会话: ${dialogCount}\n消息写入: ${messageCount}`);
  }

  async function exportHistoryJson() {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();
    const data = await db.exportAll();

    const payload = {
      metadata: {
        userId: currentUserId,
        siteId: site.id,
        exportTime: new Date().toISOString(),
        version: '0.1.0',
        type: 'full-history',
      },
      ...data,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${site.id}_chat_full_history_${currentUserId}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  GM_registerMenuCommand('完整同步私信历史', () => {
    syncAllHistory().catch((e) => alert(`同步失败: ${e.message}`));
  });

  GM_registerMenuCommand('导出完整历史 JSON', () => {
    exportHistoryJson().catch((e) => alert(`导出失败: ${e.message}`));
  });
})();
