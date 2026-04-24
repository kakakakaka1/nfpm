// ==UserScript==
// @name         NodeSeek / DeepFlood 私信备份助手
// @namespace    https://www.nodeseek.com/
// @version      0.5.9
// @description  按 message_id 保存完整私信历史，支持R2/WebDAV备份、分片导出、自动备份
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
    async pickFile(accept = 'application/json,.json') {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = () => resolve(input.files?.[0] || null);
        input.click();
      });
    },
    basicAuth(username, password) {
      return `Basic ${btoa(`${username}:${password}`)}`;
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
      this.version = 3;
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

          if (!db.objectStoreNames.contains('search_cache')) {
            const store = db.createObjectStore('search_cache', { keyPath: 'id', autoIncrement: true });
            store.createIndex('keyword', 'keyword', { unique: false });
            store.createIndex('created_at', 'created_at', { unique: false });
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

    async getMessagesByMemberId(memberId, limit = 500) {
      const tx = this.tx(['messages']);
      const store = tx.objectStore('messages');
      const index = store.index('member_id');
      return new Promise((resolve, reject) => {
        const req = index.getAll(IDBKeyRange.only(memberId));
        req.onsuccess = () => {
          const rows = (req.result || [])
            .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
            .slice(-limit);
          resolve(rows);
        };
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

    async searchMessages(keyword, limit = 200) {
      const all = await new Promise((resolve, reject) => {
        const req = this.tx(['messages']).objectStore('messages').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      const q = String(keyword || '').toLowerCase();
      return all
        .filter((m) => (m.content || '').toLowerCase().includes(q) || (m.member_name || '').toLowerCase().includes(q))
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, limit);
    }
  }

  function extractDialogs(listData) {
    if (Array.isArray(listData)) return listData;
    if (Array.isArray(listData?.msgArray)) return listData.msgArray;
    if (Array.isArray(listData?.list)) return listData.list;
    if (Array.isArray(listData?.data)) return listData.data;
    if (Array.isArray(listData?.messageList)) return listData.messageList;
    if (Array.isArray(listData?.msg_list)) return listData.msg_list;
    if (Array.isArray(listData?.result)) return listData.result;
    if (Array.isArray(listData?.rows)) return listData.rows;
    return [];
  }

  function extractMessages(detail) {
    if (Array.isArray(detail)) return detail;
    if (Array.isArray(detail?.msgArray)) return detail.msgArray;
    if (Array.isArray(detail?.data)) return detail.data;
    if (Array.isArray(detail?.messages)) return detail.messages;
    if (Array.isArray(detail?.list)) return detail.list;
    if (Array.isArray(detail?.result)) return detail.result;
    if (Array.isArray(detail?.rows)) return detail.rows;
    return [];
  }

  function resolveDialogPeer(dialog, currentUserId) {
    const senderId = dialog.sender_id ?? dialog.senderId ?? dialog.from_uid ?? dialog.fromUid;
    const receiverId = dialog.receiver_id ?? dialog.receiverId ?? dialog.to_uid ?? dialog.toUid;

    if (senderId === currentUserId) {
      return {
        memberId: receiverId,
        memberName: dialog.receiver_name || dialog.receiverName || String(receiverId),
      };
    }
    if (receiverId === currentUserId) {
      return {
        memberId: senderId,
        memberName: dialog.sender_name || dialog.senderName || String(senderId),
      };
    }

    return {
      memberId: dialog.member_id || dialog.uid || dialog.user_id || dialog.id || senderId || receiverId,
      memberName: dialog.member_name || dialog.username || dialog.name || dialog.sender_name || dialog.receiver_name || '',
    };
  }

  function normalizeMessage(raw, currentUserId, memberId, memberName) {
    const senderId = raw.sender_id ?? raw.senderId ?? raw.from_uid ?? raw.fromUid;
    const receiverId = raw.receiver_id ?? raw.receiverId ?? raw.to_uid ?? raw.toUid;
    const messageId = raw.message_id ?? raw.messageId ?? raw.id;
    const pair = [senderId, receiverId].filter((x) => x !== undefined && x !== null).sort((a, b) => a - b).join(':');
    return {
      message_id: messageId,
      member_id: memberId,
      member_name: memberName,
      sender_id: senderId,
      receiver_id: receiverId,
      direction: senderId === currentUserId ? 'out' : 'in',
      content: raw.content || raw.message || raw.body || '',
      viewed: raw.viewed ?? raw.is_read ?? 0,
      updated_at: raw.updated_at || raw.updatedAt || null,
      created_at: raw.created_at || raw.createdAt || null,
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

  async function syncAllHistory(mode = 'incremental', options = {}) {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();

    const listData = await api.getMessageList();
    const dialogs = extractDialogs(listData);

    let dialogCount = 0;
    let messageCount = 0;
    let skippedDialogs = 0;
    const checkpoint = await db.getMetadata('resume_checkpoint');
    let resumePassed = !checkpoint?.member_id;

    for (const dialog of dialogs) {
      const peer = resolveDialogPeer(dialog, currentUserId);
      const memberId = peer.memberId;
      if (!memberId) continue;
      if (!resumePassed) {
        if (String(memberId) === String(checkpoint.member_id)) {
          resumePassed = true;
        } else {
          skippedDialogs += 1;
          continue;
        }
      }

      const memberName = peer.memberName || String(memberId);
      const listCreatedAt = dialog.created_at || dialog.updated_at || null;
      const syncState = await db.getSyncState(memberId);

      if (mode === 'incremental' && syncState?.last_seen_created_at && listCreatedAt && syncState.last_seen_created_at === listCreatedAt) {
        skippedDialogs += 1;
        continue;
      }

      await db.setMetadata('resume_checkpoint', { member_id: memberId, at: new Date().toISOString(), mode });
      const detail = await api.getChatMessages(memberId);
      const msgArray = extractMessages(detail);
      const effectiveMemberId = detail?.talkTo?.member_id || memberId;
      const effectiveMemberName = detail?.talkTo?.member_name || memberName;

      let lastCreatedAt = null;
      let lastMessage = '';
      let localWrites = 0;
      for (const raw of msgArray) {
        const rawMessageId = raw?.message_id ?? raw?.messageId ?? raw?.id;
        if (!rawMessageId) continue;
        const msg = normalizeMessage(raw, currentUserId, effectiveMemberId, effectiveMemberName);
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
    await db.setMetadata('resume_checkpoint', null);

    const summaryText = `同步完成\n模式: ${mode}\n抓取会话: ${dialogCount}\n跳过会话: ${skippedDialogs}\n消息写入: ${messageCount}`;
    if (!options.silent) {
      alert(summaryText);
    }
    return {
      mode,
      dialogCount,
      skippedDialogs,
      messageCount,
      synced_at: new Date().toISOString(),
      summaryText,
    };
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
        version: '0.3.0',
        type: 'full-history',
        lastSyncSummary: summary,
      },
      ...data,
    };

    Utils.downloadJson(`${site.id}_chat_full_history_${currentUserId}_${Date.now()}.json`, payload);
  }

  async function importHistoryJson() {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();

    const file = await Utils.pickFile('application/json,.json');
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
  }

  async function searchAndExport() {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();
    const keyword = prompt('输入要搜索的关键词');
    if (!keyword) return;
    const results = await db.searchMessages(keyword, 500);
    Utils.downloadJson(`${site.id}_search_${keyword}_${Date.now()}.json`, {
      metadata: {
        userId: currentUserId,
        siteId: site.id,
        exportTime: new Date().toISOString(),
        version: '0.3.0',
        type: 'search-results',
        keyword,
        count: results.length,
      },
      results,
    });
    alert(`搜索完成，命中 ${results.length} 条，已导出 JSON`);
  }

  function buildHistoryPayload(currentUserId, data, extra = {}) {
    return {
      metadata: {
        userId: currentUserId,
        siteId: site.id,
        exportTime: new Date().toISOString(),
        version: '0.4.0',
        type: 'full-history',
        ...extra,
      },
      ...data,
    };
  }

  async function configureWebDAV() {
    return configureAutoBackup();
  }

  async function configureR2() {
    const current = GM_getValue(`r2_config_${site.id}`, null);
    let cfg = current ? JSON.parse(current) : {};
    cfg.workerUrl = prompt('R2 Worker URL', cfg.workerUrl || '') || cfg.workerUrl || '';
    cfg.token = prompt('R2 Token / Bearer', cfg.token || '') || cfg.token || '';
    cfg.prefix = prompt('R2 前缀路径', cfg.prefix || `${site.id}_chat_backup`) || cfg.prefix || `${site.id}_chat_backup`;
    GM_setValue(`r2_config_${site.id}`, JSON.stringify(cfg));
    alert('R2 配置已保存');
  }

  async function ensureWebDAVDirectory(cfg) {
    const serverBase = cfg.serverUrl.replace(/\/$/, '');
    const normalized = (cfg.backupPath || '/').replace(/\/+$/, '');
    const segments = normalized.split('/').filter(Boolean);
    let current = '';
    for (const seg of segments) {
      current += '/' + seg;
      const url = `${serverBase}${current}/`;
      await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'MKCOL',
          url,
          headers: {
            Authorization: Utils.basicAuth(cfg.username, cfg.password),
          },
          onload: (resp) => {
            if ((resp.status >= 200 && resp.status < 300) || resp.status === 405) resolve();
            else reject(new Error(`WebDAV MKCOL failed: ${resp.status} ${resp.statusText}`));
          },
          onerror: reject,
          ontimeout: () => reject(new Error('WebDAV MKCOL timeout')),
        });
      });
    }
  }

  async function backupToWebDAV() {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();
    let cfgRaw = GM_getValue(`webdav_config_${site.id}`, null);
    if (!cfgRaw) {
      const saved = await configureWebDAV();
      if (!saved) throw new Error('已取消 WebDAV 配置');
      cfgRaw = GM_getValue(`webdav_config_${site.id}`, null);
    }
    if (!cfgRaw) throw new Error('请先配置 WebDAV');
    const cfg = JSON.parse(cfgRaw);
    await ensureWebDAVDirectory(cfg);
    const data = await db.exportAll();
    const payload = buildHistoryPayload(currentUserId, data);
    const fileName = `${site.id}_chat_full_history_${currentUserId}_${Date.now()}.json`;
    const path = `${cfg.backupPath.replace(/\/$/, '')}/${fileName}`;
    const url = `${cfg.serverUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;
    await Utils.retry(() => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'PUT',
        url,
        headers: {
          Authorization: Utils.basicAuth(cfg.username, cfg.password),
          'Content-Type': 'application/json',
        },
        data: JSON.stringify(payload),
        onload: (resp) => {
          if (resp.status >= 200 && resp.status < 300) resolve();
          else reject(new Error(`WebDAV PUT failed: ${resp.status} ${resp.statusText}`));
        },
        onerror: reject,
        ontimeout: () => reject(new Error('WebDAV timeout')),
      });
    }), { retries: 3, baseDelay: 1500 });
    alert(`WebDAV 备份完成\n${url}`);
  }

  async function configureAutoBackup() {
    const currentWebDAV = GM_getValue(`webdav_config_${site.id}`, null);
    const webdavCfg = currentWebDAV ? JSON.parse(currentWebDAV) : {};
    const currentAuto = GM_getValue(`auto_backup_${site.id}`, null);
    const autoCfg = currentAuto ? JSON.parse(currentAuto) : {};
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();
    const lastSync = await db.getMetadata('last_sync_summary');

    return new Promise((resolve) => {
      const old = document.getElementById('nsdf-webdav-modal');
      if (old) old.remove();

      const style = document.createElement('style');
      style.id = 'nsdf-webdav-modal-style';
      style.textContent = `
        #nsdf-webdav-modal{position:fixed;inset:0;z-index:1000001;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);backdrop-filter:blur(4px)}
        .nsdf-webdav-card{width:min(620px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:18px;box-shadow:0 24px 80px rgba(15,23,42,.28);padding:20px}
        .nsdf-webdav-title{font-size:20px;font-weight:800;color:#0f172a;margin-bottom:6px}
        .nsdf-webdav-desc{font-size:13px;color:#64748b;margin-bottom:16px}
        .nsdf-webdav-section{margin-top:18px;padding-top:18px;border-top:1px solid #e2e8f0}
        .nsdf-webdav-grid{display:grid;grid-template-columns:1fr;gap:12px}
        .nsdf-webdav-field label{display:block;font-size:13px;font-weight:700;color:#334155;margin-bottom:6px}
        .nsdf-webdav-field input,.nsdf-webdav-field select{width:100%;padding:11px 12px;border-radius:12px;border:1px solid #cbd5e1;font-size:14px;outline:none;background:#fff}
        .nsdf-webdav-field input:focus,.nsdf-webdav-field select:focus{border-color:#3b82f6;box-shadow:0 0 0 4px rgba(59,130,246,.15)}
        .nsdf-webdav-inline{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:12px}
        .nsdf-webdav-inline input[type="checkbox"]{width:18px;height:18px}
        .nsdf-webdav-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap}
        .nsdf-webdav-actions-left,.nsdf-webdav-actions-right{display:flex;gap:10px;flex-wrap:wrap}
        .nsdf-webdav-btn{appearance:none;border:none;border-radius:12px;padding:10px 16px;font-size:14px;font-weight:700;cursor:pointer}
        .nsdf-webdav-btn.primary{background:#2563eb;color:#fff}
        .nsdf-webdav-btn.secondary{background:#e2e8f0;color:#0f172a}
        .nsdf-webdav-btn.ghost{background:#0f172a;color:#fff}
        @media (prefers-color-scheme: dark){
          .nsdf-webdav-card{background:#0f172a}
          .nsdf-webdav-title{color:#e5e7eb}
          .nsdf-webdav-desc{color:#94a3b8}
          .nsdf-webdav-section{border-color:#334155}
          .nsdf-webdav-field label{color:#cbd5e1}
          .nsdf-webdav-field input,.nsdf-webdav-field select,.nsdf-webdav-inline{background:#111827;color:#e5e7eb;border-color:#334155}
          .nsdf-webdav-btn.secondary{background:#334155;color:#e5e7eb}
        }
      `;
      if (!document.getElementById('nsdf-webdav-modal-style')) {
        document.head.appendChild(style);
      }

      const modal = document.createElement('div');
      modal.id = 'nsdf-webdav-modal';
      modal.innerHTML = `
        <div class="nsdf-webdav-card">
          <div class="nsdf-webdav-title">同步与备份设置</div>
          <div class="nsdf-webdav-desc">一次配置 WebDAV 备份和自动增量同步，不再一条一条地弹窗。</div>
          <div class="nsdf-webdav-grid">
            <div class="nsdf-webdav-field">
              <label>WebDAV 服务器地址</label>
              <input data-role="serverUrl" placeholder="https://dav.example.com/dav" value="${(webdavCfg.serverUrl || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="nsdf-webdav-field">
              <label>WebDAV 用户名</label>
              <input data-role="username" placeholder="用户名" value="${(webdavCfg.username || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="nsdf-webdav-field">
              <label>WebDAV 密码</label>
              <input data-role="password" type="password" placeholder="密码 / 应用专用密码" value="${(webdavCfg.password || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="nsdf-webdav-field">
              <label>备份路径</label>
              <input data-role="backupPath" placeholder="/ns_df_messages_backup/" value="${(webdavCfg.backupPath || '/ns_df_messages_backup/').replace(/"/g, '&quot;')}">
            </div>
          </div>
          <div class="nsdf-webdav-section">
            <div class="nsdf-webdav-title" style="font-size:16px;margin-bottom:10px">自动增量同步</div>
            <div class="nsdf-webdav-grid">
              <label class="nsdf-webdav-inline">
                <input data-role="autoEnabled" type="checkbox" ${autoCfg.enabled ? 'checked' : ''}>
                <span>打开私信列表页时自动执行增量同步</span>
              </label>
              <div class="nsdf-webdav-field">
                <label>最短触发间隔（分钟）</label>
                <input data-role="intervalMinutes" type="number" min="1" step="1" value="${Number(autoCfg.intervalMinutes || 30)}">
              </div>
              <div class="nsdf-webdav-field">
                <label>最近一次同步记录</label>
                <div class="nsdf-webdav-inline" style="display:block;line-height:1.7">
                  ${lastSync ? `
                    <div>时间：${new Date(lastSync.synced_at || '').toLocaleString()}</div>
                    <div>模式：${lastSync.mode || '-'}</div>
                    <div>抓取会话：${lastSync.dialogCount ?? 0}</div>
                    <div>跳过会话：${lastSync.skippedDialogs ?? 0}</div>
                    <div>消息写入：${lastSync.messageCount ?? 0}</div>
                  ` : '<div>暂无同步记录</div>'}
                </div>
              </div>
            </div>
          </div>
          <div class="nsdf-webdav-actions">
            <div class="nsdf-webdav-actions-left">
              <button class="nsdf-webdav-btn ghost" data-act="run-sync">立即执行一次增量同步</button>
            </div>
            <div class="nsdf-webdav-actions-right">
              <button class="nsdf-webdav-btn secondary" data-act="cancel">取消</button>
              <button class="nsdf-webdav-btn primary" data-act="save">确定</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const cleanup = (saved) => {
        modal.remove();
        resolve(saved);
      };

      modal.addEventListener('click', (e) => {
        if (e.target === modal) cleanup(false);
      });

      modal.querySelector('[data-act="cancel"]').onclick = () => cleanup(false);
      modal.querySelector('[data-act="run-sync"]').onclick = async () => {
        const btn = modal.querySelector('[data-act="run-sync"]');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '正在同步...';
        try {
          await syncAllHistory('incremental');
          cleanup(true);
        } catch (e) {
          alert(`增量同步失败: ${e.message}`);
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      };
      modal.querySelector('[data-act="save"]').onclick = () => {
        const nextWebDAV = {
          serverUrl: modal.querySelector('[data-role="serverUrl"]').value.trim(),
          username: modal.querySelector('[data-role="username"]').value.trim(),
          password: modal.querySelector('[data-role="password"]').value,
          backupPath: modal.querySelector('[data-role="backupPath"]').value.trim() || '/ns_df_messages_backup/',
        };
        const nextAuto = {
          enabled: modal.querySelector('[data-role="autoEnabled"]').checked,
          intervalMinutes: Math.max(1, Number(modal.querySelector('[data-role="intervalMinutes"]').value || 30)),
          updatedAt: new Date().toISOString(),
        };
        if ((nextWebDAV.serverUrl || nextWebDAV.username || nextWebDAV.password) && (!nextWebDAV.serverUrl || !nextWebDAV.username || !nextWebDAV.password)) {
          alert('如果要保存 WebDAV，请至少填完整：服务器地址、用户名、密码');
          return;
        }
        if (nextWebDAV.serverUrl && nextWebDAV.username && nextWebDAV.password) {
          GM_setValue(`webdav_config_${site.id}`, JSON.stringify(nextWebDAV));
        }
        GM_setValue(`auto_backup_${site.id}`, JSON.stringify(nextAuto));
        cleanup(true);
      };
    });
  }

  async function maybeRunAutoBackup() {
    const raw = GM_getValue(`auto_backup_${site.id}`, null);
    if (!raw) return;
    const cfg = JSON.parse(raw);
    if (!cfg.enabled) return;
    const lastRun = GM_getValue(`auto_backup_last_run_${site.id}`, 0);
    const now = Date.now();
    if (now - lastRun < (cfg.intervalMinutes || 30) * 60 * 1000) return;
    try {
      console.log('[ns-df-chat-full-history] auto incremental sync start');
      await syncAllHistory('incremental', { silent: true });
      GM_setValue(`auto_backup_last_run_${site.id}`, Date.now());
      console.log('[ns-df-chat-full-history] auto incremental sync done');
    } catch (e) {
      console.error('auto incremental sync failed', e);
    }
  }

  async function openHistoryPanel() {
    const api = new APIClient(site);
    const currentUserId = await resolveCurrentUserId(api);
    const db = new ChatDB(currentUserId, site);
    await db.init();

    const existing = document.getElementById('nsdf-history-panel-root');
    if (existing) {
      existing.style.display = existing.style.display === 'none' ? 'flex' : 'none';
      return;
    }

    const style = document.createElement('style');
    style.id = 'nsdf-history-panel-style';
    style.textContent = `
      #nsdf-history-panel-root{position:fixed;top:64px;right:20px;width:min(1100px,calc(100vw - 40px));height:min(82vh,900px);z-index:999999;background:#f8fafc;color:#0f172a;border:1px solid rgba(148,163,184,.35);border-radius:18px;box-shadow:0 24px 80px rgba(15,23,42,.25);display:flex;overflow:hidden;font-size:14px;backdrop-filter:blur(10px)}
      #nsdf-history-panel-root *{box-sizing:border-box}
      .nsdf-sidebar{width:340px;border-right:1px solid #e2e8f0;display:flex;flex-direction:column;background:linear-gradient(180deg,#f8fafc 0%,#eef2ff 100%)}
      .nsdf-main{flex:1;display:flex;flex-direction:column;background:linear-gradient(180deg,#ffffff 0%,#f8fafc 100%)}
      .nsdf-header{padding:14px 16px;border-bottom:1px solid #e2e8f0;display:flex;gap:8px;align-items:center;background:rgba(255,255,255,.72);backdrop-filter:blur(8px)}
      .nsdf-title{font-weight:800;font-size:15px;flex:1}
      .nsdf-btn{background:#2563eb;color:#fff;border:none;border-radius:10px;padding:8px 12px;cursor:pointer;font-weight:700;box-shadow:0 6px 16px rgba(37,99,235,.18)}
      .nsdf-btn.secondary{background:#e2e8f0;color:#0f172a;box-shadow:none}
      .nsdf-input{width:100%;padding:11px 13px;border-radius:12px;border:1px solid #dbeafe;background:#fff;color:#0f172a;outline:none;box-shadow:inset 0 1px 2px rgba(15,23,42,.04)}
      .nsdf-input:focus{border-color:#60a5fa;box-shadow:0 0 0 4px rgba(96,165,250,.15)}
      .nsdf-list,.nsdf-messages,.nsdf-search-results{overflow:auto}
      .nsdf-list{padding:10px;display:flex;flex-direction:column;gap:10px}
      .nsdf-item{padding:12px;border:1px solid #dbeafe;border-radius:14px;background:rgba(255,255,255,.86);cursor:pointer;transition:.18s ease}
      .nsdf-item:hover,.nsdf-item.active{border-color:#60a5fa;background:#eff6ff;transform:translateY(-1px)}
      .nsdf-name{font-weight:800;margin-bottom:6px;color:#0f172a}
      .nsdf-meta,.nsdf-preview{font-size:12px;color:#64748b;line-height:1.45}
      .nsdf-preview{margin-top:4px}
      .nsdf-messages{padding:16px;display:flex;flex-direction:column;gap:12px;background-image:radial-gradient(circle at top right,rgba(191,219,254,.35),transparent 28%),radial-gradient(circle at bottom left,rgba(224,231,255,.6),transparent 30%)}
      .nsdf-msg{max-width:78%;padding:12px 14px;border-radius:16px;line-height:1.55;white-space:pre-wrap;word-break:break-word;border:1px solid transparent}
      .nsdf-msg.in{background:#fff;border-color:#e2e8f0;align-self:flex-start;box-shadow:0 8px 24px rgba(15,23,42,.06)}
      .nsdf-msg.out{background:linear-gradient(135deg,#2563eb 0%,#1d4ed8 100%);color:#fff;align-self:flex-end;box-shadow:0 10px 28px rgba(37,99,235,.22)}
      .nsdf-msg-time{font-size:11px;opacity:.78;margin-top:7px}
      .nsdf-empty{padding:28px;color:#64748b}
      .nsdf-search-results{padding:12px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid #e2e8f0;max-height:240px;background:#f8fafc}
      .nsdf-search-item{padding:11px 12px;border:1px solid #dbeafe;border-radius:12px;background:#fff;cursor:pointer;transition:.18s ease}
      .nsdf-search-item:hover{border-color:#60a5fa;background:#eff6ff}
      .nsdf-toolbar{padding:12px 16px;border-bottom:1px solid #e2e8f0;display:flex;gap:8px;background:rgba(248,250,252,.88)}
      @media (prefers-color-scheme: dark){
        #nsdf-history-panel-root{background:#0f172a;color:#e5e7eb;border-color:#334155;box-shadow:0 24px 80px rgba(0,0,0,.45)}
        .nsdf-sidebar{background:linear-gradient(180deg,#0f172a 0%,#111827 100%);border-right-color:#334155}
        .nsdf-main{background:linear-gradient(180deg,#111827 0%,#0f172a 100%)}
        .nsdf-header,.nsdf-toolbar{background:rgba(15,23,42,.78);border-color:#334155}
        .nsdf-btn.secondary{background:#334155;color:#e5e7eb}
        .nsdf-input{background:#0b1220;color:#e5e7eb;border-color:#334155}
        .nsdf-item{background:rgba(15,23,42,.82);border-color:#334155}
        .nsdf-item:hover,.nsdf-item.active{background:#172554;border-color:#60a5fa}
        .nsdf-name{color:#e5e7eb}
        .nsdf-meta,.nsdf-preview,.nsdf-empty{color:#94a3b8}
        .nsdf-messages{background-image:radial-gradient(circle at top right,rgba(30,64,175,.24),transparent 28%),radial-gradient(circle at bottom left,rgba(67,56,202,.26),transparent 30%)}
        .nsdf-msg.in{background:#111827;border-color:#334155;color:#e5e7eb}
        .nsdf-search-results{background:#0f172a;border-color:#334155}
        .nsdf-search-item{background:#111827;border-color:#334155}
        .nsdf-search-item:hover{background:#172554;border-color:#60a5fa}
      }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'nsdf-history-panel-root';
    root.innerHTML = `
      <div class="nsdf-sidebar">
        <div class="nsdf-header">
          <div class="nsdf-title">私信备份会话</div>
          <button class="nsdf-btn secondary" data-act="refresh">刷新</button>
          <button class="nsdf-btn secondary" data-act="close">关闭</button>
        </div>
        <div class="nsdf-toolbar"><input class="nsdf-input" data-role="dialog-search" placeholder="筛选联系人 / 最后一条消息"></div>
        <div class="nsdf-list" data-role="dialog-list"></div>
      </div>
      <div class="nsdf-main">
        <div class="nsdf-header">
          <div class="nsdf-title" data-role="current-title">选择一个会话查看本地备份历史</div>
        </div>
        <div class="nsdf-toolbar"><input class="nsdf-input" data-role="keyword-search" placeholder="搜索私信关键词，按回车开始"></div>
        <div class="nsdf-search-results" data-role="search-results" style="display:none"></div>
        <div class="nsdf-messages" data-role="message-list"><div class="nsdf-empty">还没选会话。左边点一个联系人，右边就会显示本地备份消息。</div></div>
      </div>
    `;
    document.body.appendChild(root);

    const dialogListEl = root.querySelector('[data-role="dialog-list"]');
    const messageListEl = root.querySelector('[data-role="message-list"]');
    const currentTitleEl = root.querySelector('[data-role="current-title"]');
    const dialogSearchEl = root.querySelector('[data-role="dialog-search"]');
    const keywordSearchEl = root.querySelector('[data-role="keyword-search"]');
    const searchResultsEl = root.querySelector('[data-role="search-results"]');

    let dialogsCache = [];
    let activeMemberId = null;

    function formatTime(v) {
      if (!v) return '-';
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return String(v);
      return d.toLocaleString();
    }

    async function renderDialogs(filter = '') {
      const q = String(filter || '').toLowerCase();
      const dialogs = dialogsCache
        .filter((d) => !q || String(d.member_name || '').toLowerCase().includes(q) || String(d.last_message || '').toLowerCase().includes(q))
        .sort((a, b) => String(b.last_created_at || '').localeCompare(String(a.last_created_at || '')));
      dialogListEl.innerHTML = dialogs.length ? '' : '<div class="nsdf-empty">还没有本地会话数据，先同步一次。</div>';
      for (const d of dialogs) {
        const item = document.createElement('div');
        item.className = `nsdf-item${String(d.member_id) === String(activeMemberId) ? ' active' : ''}`;
        item.innerHTML = `
          <div class="nsdf-name">${d.member_name || d.member_id}</div>
          <div class="nsdf-meta">${formatTime(d.last_created_at)}</div>
          <div class="nsdf-preview">${(d.last_message || '').slice(0, 80)}</div>
        `;
        item.onclick = async () => {
          activeMemberId = d.member_id;
          currentTitleEl.textContent = `${d.member_name || d.member_id} (${d.member_id})`;
          await renderDialogs(dialogSearchEl.value);
          await renderMessages(d.member_id);
          searchResultsEl.style.display = 'none';
        };
        dialogListEl.appendChild(item);
      }
    }

    async function renderMessages(memberId) {
      const rows = await db.getMessagesByMemberId(memberId, 1000);
      messageListEl.innerHTML = rows.length ? '' : '<div class="nsdf-empty">这个会话还没有消息。</div>';
      for (const m of rows) {
        const node = document.createElement('div');
        node.className = `nsdf-msg ${m.direction === 'out' ? 'out' : 'in'}`;
        node.innerHTML = `${(m.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}<div class="nsdf-msg-time">${formatTime(m.created_at)}</div>`;
        messageListEl.appendChild(node);
      }
      messageListEl.scrollTop = messageListEl.scrollHeight;
    }

    async function refreshAll() {
      dialogsCache = await db.getAllDialogs();
      await renderDialogs(dialogSearchEl.value);
      if (activeMemberId) await renderMessages(activeMemberId);
    }

    dialogSearchEl.addEventListener('input', () => {
      renderDialogs(dialogSearchEl.value);
    });

    keywordSearchEl.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const keyword = keywordSearchEl.value.trim();
      if (!keyword) {
        searchResultsEl.style.display = 'none';
        return;
      }
      const results = await db.searchMessages(keyword, 200);
      searchResultsEl.innerHTML = results.length ? '' : '<div class="nsdf-empty">没搜到。</div>';
      searchResultsEl.style.display = 'flex';
      for (const row of results) {
        const item = document.createElement('div');
        item.className = 'nsdf-search-item';
        item.innerHTML = `
          <div class="nsdf-name">${row.member_name || row.member_id}</div>
          <div class="nsdf-meta">${formatTime(row.created_at)}</div>
          <div class="nsdf-preview">${(row.content || '').slice(0, 120)}</div>
        `;
        item.onclick = async () => {
          activeMemberId = row.member_id;
          currentTitleEl.textContent = `${row.member_name || row.member_id} (${row.member_id})`;
          await renderDialogs(dialogSearchEl.value);
          await renderMessages(row.member_id);
        };
        searchResultsEl.appendChild(item);
      }
    });

    root.querySelector('[data-act="close"]').onclick = () => {
      root.style.display = 'none';
    };
    root.querySelector('[data-act="refresh"]').onclick = () => {
      refreshAll().catch((e) => alert(`刷新面板失败: ${e.message}`));
    };

    await refreshAll();
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

  GM_registerMenuCommand('导入完整历史 JSON', () => {
    importHistoryJson().catch((e) => alert(`导入失败: ${e.message}`));
  });

  GM_registerMenuCommand('搜索并导出命中消息', () => {
    searchAndExport().catch((e) => alert(`搜索失败: ${e.message}`));
  });

  GM_registerMenuCommand('配置自动打开页面增量同步', () => {
    configureAutoBackup();
  });

  function isMessageListPage() {
    const appSwitch = document.querySelector('.app-switch');
    const messageLink = appSwitch?.querySelector('a[href="#/message?mode=list"]');
    if (messageLink?.classList.contains('router-link-active')) return true;
    return window.location.hash.includes('/message?mode=list') || window.location.hash.includes('mode=list');
  }

  function findMessageListAnchor() {
    return (
      document.querySelector('.message-page .message-list') ||
      document.querySelector('.message-list') ||
      document.querySelector('.conversation-list') ||
      document.querySelector('.notification-page .card') ||
      document.querySelector('.notification-page') ||
      document.querySelector('.container') ||
      document.body
    );
  }

  function injectPageActions() {
    if (!isMessageListPage()) return;
    if (document.getElementById('nsdf-page-actions')) return;

    const style = document.createElement('style');
    style.id = 'nsdf-page-actions-style';
    style.textContent = `
      #nsdf-page-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 12px;padding:0}
      .nsdf-page-btn{appearance:none;border:1px solid #dbeafe;border-radius:10px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;background:#fff;color:#2563eb;line-height:1;transition:.18s ease}
      .nsdf-page-btn:hover{background:#eff6ff;border-color:#93c5fd}
      .nsdf-page-btn.secondary{color:#0f172a;border-color:#e2e8f0}
      .nsdf-page-btn.secondary:hover{background:#f8fafc;border-color:#cbd5e1}
      .nsdf-page-btn.ghost{color:#475569;border-color:#e2e8f0;background:#f8fafc}
      .nsdf-page-btn.ghost:hover{background:#f1f5f9}
      @media (prefers-color-scheme: dark){
        .nsdf-page-btn{background:#0f172a;border-color:#334155;color:#93c5fd}
        .nsdf-page-btn:hover{background:#172554;border-color:#3b82f6}
        .nsdf-page-btn.secondary{color:#e5e7eb;border-color:#334155}
        .nsdf-page-btn.secondary:hover{background:#111827}
        .nsdf-page-btn.ghost{background:#111827;color:#94a3b8;border-color:#334155}
        .nsdf-page-btn.ghost:hover{background:#1f2937}
      }
    `;
    if (!document.getElementById('nsdf-page-actions-style')) {
      document.head.appendChild(style);
    }

    const anchor = findMessageListAnchor();
    if (!anchor) return;

    const box = document.createElement('div');
    box.id = 'nsdf-page-actions';
    box.innerHTML = `
      <button class="nsdf-page-btn secondary" data-act="panel">历史私信</button>
      <button class="nsdf-page-btn" data-act="settings">同步与备份设置</button>
    `;

    if (anchor.parentNode && anchor !== document.body) {
      anchor.parentNode.insertBefore(box, anchor);
    } else {
      document.body.prepend(box);
    }

    box.querySelector('[data-act="panel"]').onclick = () => {
      openHistoryPanel().catch((e) => alert(`打开面板失败: ${e.message}`));
    };
    box.querySelector('[data-act="settings"]').onclick = () => {
      configureAutoBackup().catch((e) => alert(`打开设置失败: ${e.message}`));
    };
  }

  setTimeout(() => {
    injectPageActions();
    maybeRunAutoBackup();
  }, 1500);

  let nsdfPageActionObserver = null;
  function watchRouteChanges() {
    if (nsdfPageActionObserver) return;
    nsdfPageActionObserver = new MutationObserver(() => {
      if (isMessageListPage() && !document.getElementById('nsdf-page-actions')) {
        injectPageActions();
      }
    });
    nsdfPageActionObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', () => {
      const old = document.getElementById('nsdf-page-actions');
      if (old) old.remove();
      setTimeout(() => injectPageActions(), 300);
    });
  }

  watchRouteChanges();
})();
