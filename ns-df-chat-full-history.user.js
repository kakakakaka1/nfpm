// ==UserScript==
// @name         NS-DF 私信完整历史备份版（草案）
// @namespace    https://www.nodeseek.com/
// @version      0.2.0
// @description  按 message_id 保存完整私信历史，支持增量同步、重试、导入导出
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

  const Utils = {
    sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    },
    async retry(fn, opts = {}) {
      const retries = opts.retries ?? 3;
      const baseDelay = opts.baseDelay ?? 800;
      let lastErr;
      for (let i = 0; i < retries; i++) {
        try {
          return await fn();
        } catch (e) {
          lastErr = e;
          if (i < retries - 1) {
            await this.sleep(baseDelay * (i + 1));
          }
        }
      }
      throw lastErr;
    },
    downloadJson(filename, payload) {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  };

  class APIClient {
    constructor(site) {
      this.site = site;
      this.baseUrl = site.apiBase;
      this.referer = site.referer;
    }

    async request(url, options = {}) {
      return Utils.retry(() => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: options.method || 'GET',
          url,
          timeout: options.timeout || 15000,
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
      }), { retries: options.retries ?? 3, baseDelay: options.baseDelay ?? 1000 });
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
      this.version = 2;
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

          if (!db.objectStoreNames.contains('sync_state')) {
            db.createObjectStore('sync_state', { keyPath: 'member_id' });
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

    async getSyncState(memberId) {
      const tx = this.tx(['sync_state']);
      const store = tx.objectStore('sync_state');
      return new Promise((resolve, reject) => {
        const req = store.get(memberId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }

    async putSyncState(state) {
      const tx = this.tx(['sync_state'], 'readwrite');
      const store = tx.objectStore('sync_state');
      return new Promise((resolve, reject) => {
        const req = store.put(state);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }

    async setMetadata(key, value) {
      const tx = this.tx(['metadata'], 'readwrite');
      const store = tx.objectStore('metadata');
      return new Promise((resolve, reject) => {
        const req = store.put({ key, value });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }

    async getMetadata(key) {
      const tx = this.tx(['metadata']);
      const store = tx.objectStore('metadata');
      return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result?.value ?? null);
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

  async function syncAllHistory(mode = 'incremental') {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();

    const listData = await api.getMessageList();
    const dialogs = listData?.msgArray || listData?.list || listData?.data || [];

    let dialogCount = 0;
    let messageCount = 0;
    let skippedDialogs = 0;

    for (const dialog of dialogs) {
      const memberId = dialog.member_id || dialog.uid || dialog.user_id || dialog.id;
      if (!memberId) continue;
      const memberName = dialog.member_name || dialog.username || dialog.name || String(memberId);
      const listCreatedAt = dialog.created_at || dialog.updated_at || null;
      const syncState = await db.getSyncState(memberId);

      if (mode === 'incremental' && syncState?.last_seen_created_at && listCreatedAt && syncState.last_seen_created_at === listCreatedAt) {
        skippedDialogs += 1;
        continue;
      }

      const detail = await api.getChatMessages(memberId);
      const msgArray = detail?.msgArray || detail?.data || [];

      let lastCreatedAt = null;
      let lastMessage = '';
      let localWrites = 0;
      for (const raw of msgArray) {
        if (!raw?.message_id) continue;
        const msg = normalizeMessage(raw, currentUserId, memberId, memberName);
        await db.putMessage(msg);
        messageCount += 1;
        localWrites += 1;
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
      await db.putSyncState({
        member_id: memberId,
        last_seen_created_at: listCreatedAt || lastCreatedAt || null,
        last_full_fetch_at: new Date().toISOString(),
        last_message_count: localWrites,
      });
      dialogCount += 1;

      await Utils.sleep(500);
    }

    await db.setMetadata('last_sync_summary', {
      mode,
      synced_at: new Date().toISOString(),
      dialogCount,
      skippedDialogs,
      messageCount,
    });

    alert(`同步完成\n模式: ${mode}\n抓取会话: ${dialogCount}\n跳过会话: ${skippedDialogs}\n消息写入: ${messageCount}`);
  }

  async function exportHistoryJson() {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();
    const data = await db.exportAll();
    const summary = await db.getMetadata('last_sync_summary');

    const payload = {
      metadata: {
        userId: currentUserId,
        siteId: site.id,
        exportTime: new Date().toISOString(),
        version: '0.2.0',
        type: 'full-history',
        lastSyncSummary: summary,
      },
      ...data,
    };

    Utils.downloadJson(`${site.id}_chat_full_history_${currentUserId}_${Date.now()}.json`, payload);
  }

  async function exportDialogsOnly() {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();
    const dialogs = await db.getAllDialogs();
    Utils.downloadJson(`${site.id}_dialogs_${currentUserId}_${Date.now()}.json`, {
      metadata: {
        userId: currentUserId,
        siteId: site.id,
        exportTime: new Date().toISOString(),
        version: '0.2.0',
        type: 'dialogs-only',
      },
      dialogs,
    });
  }

  async function importHistoryJson() {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const payload = JSON.parse(text);
      let importedMessages = 0;
      let importedDialogs = 0;

      for (const dialog of payload.dialogs || []) {
        await db.putDialog(dialog);
        importedDialogs += 1;
      }
      for (const msg of payload.messages || []) {
        await db.putMessage(msg);
        importedMessages += 1;
      }
      await db.setMetadata('last_import_summary', {
        importedAt: new Date().toISOString(),
        importedDialogs,
        importedMessages,
        sourceType: payload?.metadata?.type || 'unknown',
      });
      alert(`导入完成\n会话: ${importedDialogs}\n消息: ${importedMessages}`);
    };
    input.click();
  }

  GM_registerMenuCommand('增量同步私信历史', () => {
    syncAllHistory('incremental').catch((e) => alert(`增量同步失败: ${e.message}`));
  });

  GM_registerMenuCommand('全量同步私信历史', () => {
    syncAllHistory('full').catch((e) => alert(`全量同步失败: ${e.message}`));
  });

  GM_registerMenuCommand('导出完整历史 JSON', () => {
    exportHistoryJson().catch((e) => alert(`导出失败: ${e.message}`));
  });

  GM_registerMenuCommand('导出会话摘要 JSON', () => {
    exportDialogsOnly().catch((e) => alert(`导出失败: ${e.message}`));
  });

  GM_registerMenuCommand('导入完整历史 JSON', () => {
    importHistoryJson().catch((e) => alert(`导入失败: ${e.message}`));
  });
})();
