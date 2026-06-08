// ==UserScript==
// @name         LinuxDo Star - Tampermonkey
// @namespace    https://github.com/FULANmee/linuxdo-star-tampermonkey
// @version      1.1.1
// @description  为 linux.do 添加帖子和评论收藏功能，支持收藏夹、管理面板、导入导出和 GitHub Gist 同步
// @author       FULANmee; based on codedogQBY/LinuxDoStar
// @license      MIT
// @homepageURL  https://github.com/FULANmee/linuxdo-star-tampermonkey
// @supportURL   https://github.com/FULANmee/linuxdo-star-tampermonkey/issues
// @updateURL    https://raw.githubusercontent.com/FULANmee/linuxdo-star-tampermonkey/main/linuxdo-star.user.js
// @downloadURL  https://raw.githubusercontent.com/FULANmee/linuxdo-star-tampermonkey/main/linuxdo-star.user.js
// @match        https://linux.do/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      api.github.com
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'linuxdo_stars';
  const SYNC_CONFIG_KEY = 'linuxdo_sync_config';
  const UI_CONFIG_KEY = 'linuxdo_ui_config';
  const GIST_FILENAME = 'linuxdo-stars.json';
  const GIST_DESCRIPTION = 'LinuxDo Star Collector - Sync Data (do not delete)';

  const STAR_CLASS = 'ldsm-star-btn';
  const STAR_ACTIVE_CLASS = 'ldsm-star-active';
  const STAR_SVG = `<svg class="ldsm-star-icon fa d-icon svg-icon svg-string" width="1em" height="1em" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
  </svg><span aria-hidden="true">\u200B</span>`;

  const ICONS = ['📁', '📚', '💡', '🔥', '💼', '🎯', '🏷️', '📌', '🗂️', '💻', '⭐', '❤️', '🎨', '🔖', '📝', '🧪', '🎓', '🌐', '🛠️', '📊'];
  const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const ALLOWED_SYNC_STATUS = new Set(['disconnected', 'connected', 'syncing', 'synced', 'error']);
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const MAX_COLLECTIONS = 300;
  const MAX_BOOKMARKS = 20000;
  const MAX_POSTS_PER_TOPIC = 800;
  const MAX_TAGS = 40;
  const MAX_GITHUB_RESPONSE_BYTES = 10 * 1024 * 1024;
  const ORDER_STEP = 1000;
  const DRAG_MIME = 'application/x-linuxdo-star';

  const managerState = {
    store: null,
    currentView: 'all',
    sort: 'custom',
    query: '',
    expanded: new Set(),
    batchMode: false,
    selected: new Set(),
    panelOpen: false,
    dragging: null,
    ignoreNextClick: false,
  };

  let activePopup = null;
  let managerReady = false;
  let injectScheduled = false;
  let syncDebounceTimer = null;
  let routeObserverStarted = false;
  let postsObserverStarted = false;
  let lastUrl = location.href;
  let menuCommandsRegistered = false;

  // ========================= Utilities =========================
  function nowIso() {
    return new Date().toISOString();
  }

  function h(value) {
    if (value === null || value === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
  }

  function attr(value) {
    return h(value).replace(/`/g, '&#96;');
  }

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function makeId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function makeDefaultCollection() {
    return {
      id: 'default',
      name: '默认收藏夹',
      icon: '⭐',
      color: '#eab308',
      createdAt: nowIso(),
      order: 0,
    };
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function safeEntries(value) {
    if (!isObject(value)) return [];
    return Object.entries(value).filter(([key]) => !DANGEROUS_KEYS.has(key));
  }

  function safeString(value, fallback = '', maxLength = 500) {
    if (value === null || value === undefined) return fallback;
    return String(value).slice(0, maxLength);
  }

  function safeInt(value, fallback = 0) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function safeBool(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function safeIso(value) {
    const text = safeString(value, '', 64);
    if (!text) return '';
    const time = new Date(text).getTime();
    return Number.isFinite(time) ? text : '';
  }

  function safeTags(value) {
    if (!Array.isArray(value)) return [];
    const tags = [];
    for (const tag of value) {
      const text = safeString(tag, '', 60).trim();
      if (text && !tags.includes(text)) tags.push(text);
      if (tags.length >= MAX_TAGS) break;
    }
    return tags;
  }

  function safeId(value, fallback = '') {
    const text = safeString(value, fallback, 96);
    if (!text || DANGEROUS_KEYS.has(text)) return fallback;
    return /^[A-Za-z0-9_-]+$/.test(text) ? text : fallback;
  }

  function safeCollectionId(value) {
    return safeId(value, 'default') || 'default';
  }

  function safeOrderByCollection(value) {
    const result = {};
    for (const [key, order] of safeEntries(value)) {
      const id = safeCollectionId(key);
      if (!id) continue;
      result[id] = safeNumber(order, 0);
    }
    return result;
  }

  function safeTopicKey(key, bookmark) {
    if (!DANGEROUS_KEYS.has(key) && /^topic_[1-9]\d*$/.test(key)) return key;
    const topicId = safeInt(bookmark?.topicId, 0);
    return topicId > 0 ? `topic_${topicId}` : '';
  }

  function safePostKey(key, post) {
    if (!DANGEROUS_KEYS.has(key) && /^post_[1-9]\d*$/.test(key)) return key;
    const postNumber = safeInt(post?.postNumber, 0);
    return postNumber > 0 ? `post_${postNumber}` : '';
  }

  function safeLinuxDoUrl(value, fallback = '') {
    const text = safeString(value, fallback, 2048);
    if (!text) return fallback;
    try {
      const url = new URL(text, 'https://linux.do');
      if (url.protocol !== 'https:' || url.hostname !== 'linux.do') return fallback;
      return url.href;
    } catch {
      return fallback;
    }
  }

  function safeGithubApiUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') return '';
      if (url.pathname !== '/user' && url.pathname !== '/gists' && !url.pathname.startsWith('/gists/')) return '';
      return url.href;
    } catch {
      return '';
    }
  }

  function normalizeSyncConfig(input) {
    const raw = isObject(input) ? input : {};
    const status = safeString(raw.status, 'disconnected', 24);
    return {
      token: safeString(raw.token, '', 256),
      gistId: safeString(raw.gistId, '', 96).replace(/[^A-Za-z0-9]/g, ''),
      lastSyncAt: safeIso(raw.lastSyncAt),
      autoSync: safeBool(raw.autoSync, true),
      status: ALLOWED_SYNC_STATUS.has(status) ? status : 'disconnected',
      username: safeString(raw.username, '', 120),
      lastError: safeString(raw.lastError, '', 500),
    };
  }

  function normalizeUiConfig(input) {
    const raw = isObject(input) ? input : {};
    return {
      showFab: safeBool(raw.showFab, true),
    };
  }

  function sanitizeCollection(input, key, order) {
    const fallbackId = key === 'default' ? 'default' : safeId(key, makeId('col'));
    const id = fallbackId;
    if (id !== 'default' && input?._deleted) {
      return {
        id,
        _deleted: true,
        _deletedAt: safeIso(input._deletedAt) || nowIso(),
      };
    }
    return {
      id,
      name: safeString(input?.name, id === 'default' ? '默认收藏夹' : '未命名收藏夹', 120).trim() || '未命名收藏夹',
      icon: safeString(input?.icon, id === 'default' ? '⭐' : '📁', 8),
      color: safeString(input?.color, id === 'default' ? '#eab308' : '#71717a', 32),
      createdAt: safeIso(input?.createdAt) || nowIso(),
      updatedAt: safeIso(input?.updatedAt),
      order: safeInt(input?.order, order),
    };
  }

  function sanitizePost(input, key, topicId) {
    const postNumber = safeInt(input?.postNumber, Number(key.replace('post_', '')) || 0);
    const fallbackUrl = topicId && postNumber ? `https://linux.do/t/topic/${topicId}/${postNumber}` : '';
    if (input?._deleted) {
      return {
        _deleted: true,
        _deletedAt: safeIso(input._deletedAt) || nowIso(),
        postNumber,
      };
    }
    return {
      postNumber,
      postUrl: safeLinuxDoUrl(input?.postUrl, fallbackUrl),
      author: safeString(input?.author, '', 120),
      excerpt: safeString(input?.excerpt, '', 1000),
      starredAt: safeIso(input?.starredAt) || nowIso(),
      updatedAt: safeIso(input?.updatedAt),
      collectionId: safeCollectionId(input?.collectionId),
      tags: safeTags(input?.tags),
      note: safeString(input?.note, '', 5000),
    };
  }

  function sanitizeBookmark(input, key) {
    const topicId = safeInt(input?.topicId, Number(key.replace('topic_', '')) || 0);
    if (input?._deleted) {
      return {
        _deleted: true,
        _deletedAt: safeIso(input._deletedAt) || nowIso(),
        topicId,
      };
    }

    const topicUrl = safeLinuxDoUrl(input?.topicUrl, topicId ? `https://linux.do/t/topic/${topicId}` : '');
    const bookmark = {
      topicId,
      topicTitle: safeString(input?.topicTitle, '未知标题', 500),
      topicUrl,
      category: safeString(input?.category, '', 120),
      starredAt: safeIso(input?.starredAt) || nowIso(),
      updatedAt: safeIso(input?.updatedAt),
      starred: safeBool(input?.starred, true),
      collectionId: safeCollectionId(input?.collectionId),
      tags: safeTags(input?.tags),
      note: safeString(input?.note, '', 5000),
      orderByCollection: safeOrderByCollection(input?.orderByCollection),
      posts: {},
    };

    let postCount = 0;
    for (const [postKey, postInput] of safeEntries(input?.posts)) {
      if (postCount >= MAX_POSTS_PER_TOPIC) break;
      if (!isObject(postInput)) continue;
      const safeKey = safePostKey(postKey, postInput);
      if (!safeKey) continue;
      bookmark.posts[safeKey] = sanitizePost(postInput, safeKey, topicId);
      postCount += 1;
    }

    return bookmark;
  }

  function normalizeStore(input) {
    let store = input;
    if (typeof store === 'string') {
      try {
        store = JSON.parse(store);
      } catch {
        store = {};
      }
    }
    if (!isObject(store)) store = {};

    if (!store.collections && !store.bookmarks) {
      const oldKeys = safeEntries(store).map(([key]) => key).filter(key => key.startsWith('topic_'));
      if (oldKeys.length) {
        const migrated = { collections: { default: makeDefaultCollection() }, bookmarks: {} };
        for (const key of oldKeys) {
          migrated.bookmarks[key] = store[key];
        }
        store = migrated;
      }
    }

    const normalized = { collections: {}, bookmarks: {} };
    let collectionOrder = 0;
    for (const [key, collection] of safeEntries(store.collections)) {
      if (collectionOrder >= MAX_COLLECTIONS) break;
      if (!isObject(collection)) continue;
      const safeKey = key === 'default' ? 'default' : safeId(key, '');
      if (!safeKey) continue;
      normalized.collections[safeKey] = sanitizeCollection(collection, safeKey, collectionOrder);
      collectionOrder += 1;
    }
    if (!normalized.collections.default) normalized.collections.default = makeDefaultCollection();

    let bookmarkCount = 0;
    for (const [key, bookmark] of safeEntries(store.bookmarks)) {
      if (bookmarkCount >= MAX_BOOKMARKS) break;
      if (!isObject(bookmark)) continue;
      const safeKey = safeTopicKey(key, bookmark);
      if (!safeKey) continue;
      normalized.bookmarks[safeKey] = sanitizeBookmark(bookmark, safeKey);
      bookmarkCount += 1;
    }

    const collectionIds = new Set(aliveCollections(normalized).map(([id]) => id));
    for (const bookmark of Object.values(normalized.bookmarks)) {
      if (!bookmark || bookmark._deleted) continue;
      if (!collectionIds.has(bookmark.collectionId)) bookmark.collectionId = 'default';
      for (const post of Object.values(bookmark.posts || {})) {
        if (!post || post._deleted) continue;
        post.collectionId = bookmark.collectionId || 'default';
      }
    }

    return normalized;
  }

  function clone(data) {
    return JSON.parse(JSON.stringify(data));
  }

  function collectionSortValue(collection) {
    if (collection?.id === 'default') return -1;
    return safeNumber(collection?.order, Number.MAX_SAFE_INTEGER);
  }

  function sortedCollections(store) {
    return aliveCollections(store)
      .map(([, collection]) => collection)
      .sort((a, b) => {
        if (a.id === 'default') return -1;
        if (b.id === 'default') return 1;
        const orderDiff = collectionSortValue(a) - collectionSortValue(b);
        if (orderDiff) return orderDiff;
        return (a.name || '').localeCompare(b.name || '', 'zh-CN');
      });
  }

  function collectionItemOrder(bookmark, collectionId) {
    const id = safeCollectionId(collectionId);
    const explicit = bookmark?.orderByCollection?.[id];
    if (Number.isFinite(explicit)) return explicit;
    const time = new Date(bookmark?.starredAt || bookmark?.updatedAt || bookmark?.createdAt || 0).getTime();
    return Number.isFinite(time) ? Number.MAX_SAFE_INTEGER - time : Number.MAX_SAFE_INTEGER;
  }

  function sortBookmarksByCustomOrder(items, collectionId) {
    return items.sort((a, b) => {
      const diff = collectionItemOrder(a, collectionId) - collectionItemOrder(b, collectionId);
      if (diff) return diff;
      return new Date(b.starredAt || b.updatedAt || 0) - new Date(a.starredAt || a.updatedAt || 0);
    });
  }

  function collectionBookmarks(store, collectionId) {
    const id = safeCollectionId(collectionId);
    return aliveBookmarks(store)
      .filter(([, bookmark]) => (bookmark.collectionId || 'default') === id)
      .map(([key, bookmark]) => ({ key, ...bookmark }));
  }

  function assignCollectionOrders(store, collectionIds) {
    const ids = collectionIds.filter(id => id && id !== 'default' && store.collections[id] && !store.collections[id]._deleted);
    const time = nowIso();
    store.collections.default = { ...makeDefaultCollection(), ...(store.collections.default || {}), id: 'default', order: 0, updatedAt: time };
    ids.forEach((id, index) => {
      store.collections[id].order = (index + 1) * ORDER_STEP;
      store.collections[id].updatedAt = time;
    });
  }

  function setTopicCollectionOrder(store, topicKey, collectionId, order) {
    const topic = store.bookmarks?.[topicKey];
    if (!topic || topic._deleted) return;
    const id = safeCollectionId(collectionId);
    if (!topic.orderByCollection) topic.orderByCollection = {};
    topic.orderByCollection[id] = safeNumber(order, 0);
  }

  function reindexCollectionItems(store, collectionId, topicKeys, time = nowIso()) {
    const id = safeCollectionId(collectionId);
    topicKeys.forEach((topicKey, index) => {
      setTopicCollectionOrder(store, topicKey, id, (index + 1) * ORDER_STEP);
      if (store.bookmarks?.[topicKey] && !store.bookmarks[topicKey]._deleted) {
        store.bookmarks[topicKey].updatedAt = time;
      }
    });
  }

  function removeTopicCollectionOrder(topic, collectionId) {
    const id = safeCollectionId(collectionId);
    if (topic?.orderByCollection) delete topic.orderByCollection[id];
  }

  function placeTopicAtCollectionTop(store, topicKey, collectionId, time = nowIso()) {
    const id = safeCollectionId(collectionId);
    const current = sortBookmarksByCustomOrder(collectionBookmarks(store, id), id).filter(item => item.key !== topicKey);
    const firstOrder = current.length ? collectionItemOrder(current[0], id) : ORDER_STEP * 2;
    if (firstOrder > 1) {
      setTopicCollectionOrder(store, topicKey, id, firstOrder / 2);
      if (store.bookmarks?.[topicKey] && !store.bookmarks[topicKey]._deleted) {
        store.bookmarks[topicKey].updatedAt = time;
      }
      return;
    }
    reindexCollectionItems(store, id, [topicKey, ...current.map(item => item.key)], time);
  }

  function alivePosts(bookmark) {
    return Object.entries(bookmark?.posts || {})
      .filter(([, post]) => post && !post._deleted);
  }

  function aliveBookmarks(store) {
    return Object.entries(store?.bookmarks || {})
      .filter(([, bookmark]) => bookmark && !bookmark._deleted);
  }

  function aliveCollections(store) {
    return Object.entries(store?.collections || {})
      .filter(([, collection]) => collection && !collection._deleted);
  }

  function liveCollectionId(store, collectionId) {
    const id = safeCollectionId(collectionId);
    const collection = store?.collections?.[id];
    return collection && !collection._deleted ? id : 'default';
  }

  function countStore(store) {
    let topics = 0;
    let posts = 0;
    for (const [, bookmark] of aliveBookmarks(store)) {
      if (bookmark.starred) topics++;
      posts += alivePosts(bookmark).length;
    }
    return { topics, posts };
  }

  function formatTime(value) {
    if (!value) return '';
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return '';
    const diff = Date.now() - time;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
    if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`;
    const date = new Date(value);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function openExternal(url) {
    const safeUrl = safeLinuxDoUrl(url);
    if (!safeUrl) {
      showToast('链接已被拦截', '⚠');
      return;
    }
    const opened = window.open(safeUrl, '_blank', 'noopener,noreferrer');
    if (opened) opened.opener = null;
  }

  function downloadText(content, filename, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function showToast(message, icon = '⭐') {
    document.querySelector('.ldsm-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'ldsm-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `<span class="ldsm-toast-icon">${h(icon)}</span><span>${h(message)}</span>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('ldsm-toast-visible'));
    setTimeout(() => {
      toast.classList.remove('ldsm-toast-visible');
      setTimeout(() => toast.remove(), 260);
    }, 1900);
  }

  function setDragPayload(event, payload) {
    managerState.dragging = payload;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', payload.topicKey || payload.collectionId || '');
  }

  function getDragPayload(event) {
    if (managerState.dragging) return managerState.dragging;
    try {
      const raw = event.dataTransfer.getData(DRAG_MIME);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function getDropPosition(event, element) {
    const rect = element.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  }

  function clearDragMarks(root = document) {
    root.querySelectorAll('.ldsm-dragging, .ldsm-drag-over, .ldsm-drag-before, .ldsm-drag-after')
      .forEach(element => element.classList.remove('ldsm-dragging', 'ldsm-drag-over', 'ldsm-drag-before', 'ldsm-drag-after'));
  }

  function markDragTarget(element, position) {
    const root = element.parentElement || document;
    root.querySelectorAll('.ldsm-drag-over, .ldsm-drag-before, .ldsm-drag-after')
      .forEach(item => item.classList.remove('ldsm-drag-over', 'ldsm-drag-before', 'ldsm-drag-after'));
    element.classList.add('ldsm-drag-over', position === 'before' ? 'ldsm-drag-before' : 'ldsm-drag-after');
  }

  function reorderIds(ids, movingId, targetId, position) {
    const next = ids.filter(id => id !== movingId);
    let index = next.indexOf(targetId);
    if (index < 0) index = next.length;
    else if (position === 'after') index += 1;
    next.splice(index, 0, movingId);
    return next;
  }

  function canReorderCurrentView() {
    return managerState.currentView !== 'all' && managerState.sort === 'custom' && !managerState.query && !managerState.batchMode;
  }

  function suppressNextClick() {
    managerState.ignoreNextClick = true;
    setTimeout(() => {
      managerState.ignoreNextClick = false;
    }, 120);
  }

  function getUiConfig() {
    return normalizeUiConfig(GM_getValue(UI_CONFIG_KEY, {}));
  }

  function saveUiConfig(updates) {
    const next = normalizeUiConfig({ ...getUiConfig(), ...updates });
    GM_setValue(UI_CONFIG_KEY, next);
    applyUiConfig(next);
    return next;
  }

  function applyUiConfig(config = getUiConfig()) {
    const fab = $('#ldsmFab');
    if (fab) fab.hidden = !config.showFab;
    const toggle = $('#ldsmFabToggle');
    if (toggle) toggle.checked = config.showFab;
  }

  // ========================= Storage =========================
  const StarStorage = {
    async getAll() {
      const store = normalizeStore(GM_getValue(STORAGE_KEY, null));
      return clone(store);
    },

    async save(store, options = {}) {
      const normalized = normalizeStore(store);
      this.purgeDeleted(normalized);
      GM_setValue(STORAGE_KEY, clone(normalized));
      if (options.notify !== false) notifyDataChanged();
    },

    async getCollections() {
      const store = await this.getAll();
      return store.collections;
    },

    async createCollection(name, icon, color) {
      const store = await this.getAll();
      const id = makeId('col');
      const order = Math.max(0, ...sortedCollections(store).filter(col => col.id !== 'default').map(col => safeNumber(col.order, 0))) + ORDER_STEP;
      const time = nowIso();
      store.collections[id] = {
        id,
        name: name || '新收藏夹',
        icon: icon || '📁',
        color: color || '#71717a',
        createdAt: time,
        updatedAt: time,
        order,
      };
      await this.save(store);
      return id;
    },

    async reorderCollections(collectionIds) {
      const store = await this.getAll();
      assignCollectionOrders(store, collectionIds);
      await this.save(store);
    },

    async updateCollection(id, updates) {
      const store = await this.getAll();
      if (!store.collections[id] || store.collections[id]._deleted) return;
      Object.assign(store.collections[id], updates, { updatedAt: nowIso() });
      await this.save(store);
    },

    async deleteCollection(id) {
      if (id === 'default') return;
      const store = await this.getAll();
      const time = nowIso();
      store.collections[id] = {
        id,
        _deleted: true,
        _deletedAt: time,
      };
      for (const bookmark of Object.values(store.bookmarks || {})) {
        if (!bookmark || bookmark._deleted) continue;
        const wasInDeletedCollection = bookmark.collectionId === id;
        if (wasInDeletedCollection) {
          bookmark.collectionId = 'default';
          removeTopicCollectionOrder(bookmark, id);
          bookmark.updatedAt = time;
        }
        for (const post of Object.values(bookmark.posts || {})) {
          if (post && !post._deleted && (post.collectionId === id || wasInDeletedCollection)) {
            post.collectionId = 'default';
            post.updatedAt = time;
            bookmark.updatedAt = time;
          }
        }
      }
      await this.save(store);
    },

    async isTopicStarred(topicId) {
      const store = await this.getAll();
      const item = store.bookmarks[`topic_${topicId}`];
      return !!item && !item._deleted && !!item.starred;
    },

    async isPostStarred(topicId, postNumber) {
      const store = await this.getAll();
      const post = store.bookmarks[`topic_${topicId}`]?.posts?.[`post_${postNumber}`];
      return !!post && !post._deleted;
    },

    async toggleTopicStar(topicId, meta, collectionId = 'default') {
      const store = await this.getAll();
      const key = `topic_${topicId}`;
      const time = nowIso();
      const existing = store.bookmarks[key];
      const targetCollectionId = liveCollectionId(store, collectionId);

      if (existing && !existing._deleted && existing.starred) {
        existing.starred = false;
        existing.updatedAt = time;
        if (!alivePosts(existing).length) {
          store.bookmarks[key] = {
            _deleted: true,
            _deletedAt: time,
            topicId,
          };
        }
        await this.save(store);
        return false;
      }

      if (!existing || existing._deleted) {
        store.bookmarks[key] = {
          topicId,
          topicTitle: meta.title,
          topicUrl: meta.url,
          category: meta.category || '',
          starredAt: time,
          updatedAt: time,
          starred: true,
          collectionId: targetCollectionId,
          tags: meta.tags || [],
          note: '',
          posts: {},
        };
      } else {
        const previousCollectionId = liveCollectionId(store, existing.collectionId);
        existing.starred = true;
        existing.starredAt = time;
        existing.updatedAt = time;
        existing.topicTitle = meta.title || existing.topicTitle;
        existing.topicUrl = meta.url || existing.topicUrl;
        existing.category = meta.category || existing.category || '';
        existing.tags = meta.tags?.length ? meta.tags : (existing.tags || []);
        existing.collectionId = targetCollectionId || liveCollectionId(store, existing.collectionId);
        if (previousCollectionId !== targetCollectionId) removeTopicCollectionOrder(existing, previousCollectionId);
        for (const post of Object.values(existing.posts || {})) {
          if (!post || post._deleted) continue;
          post.collectionId = existing.collectionId;
          post.updatedAt = time;
        }
      }

      placeTopicAtCollectionTop(store, key, targetCollectionId, time);
      await this.save(store);
      return true;
    },

    async togglePostStar(topicId, postNumber, topicMeta, postMeta, collectionId = 'default') {
      const store = await this.getAll();
      const topicKey = `topic_${topicId}`;
      const postKey = `post_${postNumber}`;
      const time = nowIso();
      const targetCollectionId = liveCollectionId(store, collectionId);

      if (!store.bookmarks[topicKey] || store.bookmarks[topicKey]._deleted) {
        store.bookmarks[topicKey] = {
          topicId,
          topicTitle: topicMeta.title,
          topicUrl: topicMeta.url,
          category: topicMeta.category || '',
          starredAt: time,
          updatedAt: time,
          starred: true,
          collectionId: targetCollectionId,
          tags: topicMeta.tags || [],
          note: '',
          posts: {},
        };
      }

      const topic = store.bookmarks[topicKey];
      if (!topic.posts) topic.posts = {};
      const previousCollectionId = liveCollectionId(store, topic.collectionId);

      if (topic.posts[postKey] && !topic.posts[postKey]._deleted) {
        topic.posts[postKey] = {
          _deleted: true,
          _deletedAt: time,
          postNumber,
        };
        topic.updatedAt = time;
        if (!topic.starred && !alivePosts(topic).length) {
          store.bookmarks[topicKey] = {
            _deleted: true,
            _deletedAt: time,
            topicId,
          };
        }
        await this.save(store);
        return false;
      }

      topic.posts[postKey] = {
        postNumber,
        postUrl: postMeta.url,
        author: postMeta.author,
        excerpt: postMeta.excerpt,
        starredAt: time,
        updatedAt: time,
        collectionId: targetCollectionId,
        tags: [],
        note: '',
      };
      topic.starred = true;
      topic.updatedAt = time;
      topic.topicTitle = topicMeta.title || topic.topicTitle;
      topic.topicUrl = topicMeta.url || topic.topicUrl;
      topic.collectionId = targetCollectionId;
      if (previousCollectionId !== targetCollectionId) removeTopicCollectionOrder(topic, previousCollectionId);
      for (const post of Object.values(topic.posts || {})) {
        if (!post || post._deleted) continue;
        post.collectionId = targetCollectionId;
        post.updatedAt = time;
      }
      placeTopicAtCollectionTop(store, topicKey, targetCollectionId, time);
      await this.save(store);
      return true;
    },

    async moveToCollection(topicKey, collectionId, postKey) {
      const store = await this.getAll();
      const time = nowIso();
      const targetCollectionId = liveCollectionId(store, collectionId);
      const topic = store.bookmarks[topicKey];
      if (topic && !topic._deleted) {
        const previousCollectionId = liveCollectionId(store, topic.collectionId);
        topic.collectionId = targetCollectionId;
        topic.updatedAt = time;
        for (const post of Object.values(topic.posts || {})) {
          if (!post || post._deleted) continue;
          post.collectionId = targetCollectionId;
          post.updatedAt = time;
        }
        if (previousCollectionId !== targetCollectionId) removeTopicCollectionOrder(topic, previousCollectionId);
        placeTopicAtCollectionTop(store, topicKey, targetCollectionId, time);
      }
      await this.save(store);
    },

    async reorderTopics(collectionId, topicKeys) {
      const store = await this.getAll();
      const id = liveCollectionId(store, collectionId);
      const allowed = new Set(collectionBookmarks(store, id).map(item => item.key));
      const ordered = topicKeys.filter(key => allowed.has(key));
      const missing = sortBookmarksByCustomOrder(collectionBookmarks(store, id), id)
        .map(item => item.key)
        .filter(key => !ordered.includes(key));
      reindexCollectionItems(store, id, [...ordered, ...missing]);
      await this.save(store);
    },

    async softDeleteTopic(topicKey) {
      const store = await this.getAll();
      if (store.bookmarks[topicKey]) {
        store.bookmarks[topicKey] = {
          _deleted: true,
          _deletedAt: nowIso(),
          topicId: store.bookmarks[topicKey].topicId,
        };
      }
      await this.save(store);
    },

    async softDeletePost(topicKey, postKey) {
      const store = await this.getAll();
      const topic = store.bookmarks[topicKey];
      if (topic?.posts?.[postKey]) {
        topic.posts[postKey] = {
          _deleted: true,
          _deletedAt: nowIso(),
          postNumber: topic.posts[postKey].postNumber,
        };
        topic.updatedAt = nowIso();
        if (!topic.starred && !alivePosts(topic).length) {
          store.bookmarks[topicKey] = {
            _deleted: true,
            _deletedAt: nowIso(),
            topicId: topic.topicId,
          };
        }
      }
      await this.save(store);
    },

    purgeDeleted(store) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [key, bookmark] of Object.entries(store.bookmarks || {})) {
        if (bookmark?._deleted && new Date(bookmark._deletedAt || 0).getTime() < cutoff) {
          delete store.bookmarks[key];
          continue;
        }
        for (const [postKey, post] of Object.entries(bookmark?.posts || {})) {
          if (post?._deleted && new Date(post._deletedAt || 0).getTime() < cutoff) {
            delete bookmark.posts[postKey];
          }
        }
      }
      for (const [id, collection] of Object.entries(store.collections || {})) {
        if (id !== 'default' && collection?._deleted && new Date(collection._deletedAt || 0).getTime() < cutoff) {
          delete store.collections[id];
        }
      }
    },
  };

  function notifyDataChanged() {
    refreshFabCount();
    refreshPageStarStates();
    if (isManagerOpen()) reloadManager();
    scheduleAutoSync();
  }

  // ========================= GitHub Gist Sync =========================
  const SyncManager = {
    async getConfig() {
      return normalizeSyncConfig(GM_getValue(SYNC_CONFIG_KEY, {}));
    },

    async saveConfig(config) {
      const normalized = normalizeSyncConfig(config);
      if (!normalized.lastError) delete normalized.lastError;
      if (!normalized.username) delete normalized.username;
      GM_setValue(SYNC_CONFIG_KEY, normalized);
      if (isManagerOpen()) renderSyncStatus();
    },

    async updateStatus(status, error) {
      const config = await this.getConfig();
      config.status = status;
      if (error) config.lastError = error;
      else delete config.lastError;
      await this.saveConfig(config);
    },

    async apiRequest(token, url, options = {}) {
      const safeUrl = safeGithubApiUrl(url);
      const method = safeString(options.method || 'GET', 'GET', 8).toUpperCase();
      if (!safeUrl) throw new Error('GitHub API 地址不被允许');
      if (!['GET', 'POST', 'PATCH'].includes(method)) throw new Error('GitHub API 方法不被允许');

      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url: safeUrl,
          headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          data: options.body,
          responseType: 'text',
          timeout: 20_000,
          onload: response => {
            const body = response.responseText || '';
            if (body.length > MAX_GITHUB_RESPONSE_BYTES) {
              reject(new Error('GitHub API 响应过大'));
              return;
            }
            if (response.status < 200 || response.status >= 300) {
              if (response.status === 401) reject(new Error('Token 无效或已过期'));
              else if (response.status === 404) reject(new Error('Gist 不存在'));
              else reject(new Error(`GitHub API 错误 (${response.status}): ${body.slice(0, 160)}`));
              return;
            }
            if (!body) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(body);
            }
          },
          onerror: () => reject(new Error('无法连接 GitHub API')),
          ontimeout: () => reject(new Error('连接 GitHub API 超时')),
        });
      });
    },

    async validateToken(token) {
      try {
        const user = await this.apiRequest(token, 'https://api.github.com/user');
        return { ok: true, username: user.login, avatar: user.avatar_url };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    },

    async findOrCreateGist(token) {
      const gists = await this.apiRequest(token, 'https://api.github.com/gists?per_page=100');
      for (const gist of gists || []) {
        if (gist.files?.[GIST_FILENAME]) return gist.id;
      }

      const created = await this.apiRequest(token, 'https://api.github.com/gists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: GIST_DESCRIPTION,
          public: false,
          files: {
            [GIST_FILENAME]: {
              content: JSON.stringify({ collections: {}, bookmarks: {} }, null, 2),
            },
          },
        }),
      });
      return created.id;
    },

    async readGist(token, gistId) {
      const gist = await this.apiRequest(token, `https://api.github.com/gists/${gistId}`);
      const file = gist.files?.[GIST_FILENAME];
      if (!file) throw new Error('Gist 中未找到数据文件');
      if (file.truncated) throw new Error('Gist 数据文件过大，GitHub API 返回内容已截断');
      try {
        return normalizeStore(JSON.parse(file.content || '{}'));
      } catch {
        return normalizeStore({});
      }
    },

    async writeGist(token, gistId, data) {
      await this.apiRequest(token, `https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: {
            [GIST_FILENAME]: {
              content: JSON.stringify(data, null, 2),
            },
          },
        }),
      });
    },

    async connect(token) {
      const cleanToken = safeString(token, '', 256).trim();
      if (!cleanToken) return { ok: false, message: 'Token 不能为空' };

      const validation = await this.validateToken(cleanToken);
      if (!validation.ok) return { ok: false, message: validation.message };

      const gistId = await this.findOrCreateGist(cleanToken);
      await this.saveConfig({
        token: cleanToken,
        gistId,
        lastSyncAt: '',
        autoSync: true,
        status: 'connected',
        username: validation.username,
      });

      const result = await this.sync();
      return { ok: result.ok, message: result.ok ? `已连接为 @${validation.username}` : result.message, gistId };
    },

    async disconnect() {
      await this.saveConfig({
        token: '',
        gistId: '',
        lastSyncAt: '',
        autoSync: false,
        status: 'disconnected',
      });
      return { ok: true, message: '已断开同步' };
    },

    async sync() {
      const config = await this.getConfig();
      if (!config.token || !config.gistId) return { ok: false, message: '未配置同步' };

      try {
        await this.updateStatus('syncing');
        const remote = await this.readGist(config.token, config.gistId);
        const local = await StarStorage.getAll();
        const merged = this.merge(local, remote);
        await StarStorage.save(merged, { notify: false });
        await this.writeGist(config.token, config.gistId, merged);
        config.lastSyncAt = nowIso();
        config.status = 'synced';
        delete config.lastError;
        await this.saveConfig(config);
        refreshFabCount();
        refreshPageStarStates();
        if (isManagerOpen()) await reloadManager();
        return { ok: true, message: '同步成功', merged };
      } catch (error) {
        await this.updateStatus('error', error.message);
        return { ok: false, message: error.message };
      }
    },

    merge(localInput, remoteInput) {
      const local = normalizeStore(localInput);
      const remote = normalizeStore(remoteInput);
      const result = { collections: {}, bookmarks: {} };

      const allCollections = new Set([
        ...Object.keys(local.collections || {}),
        ...Object.keys(remote.collections || {}),
      ]);
      for (const id of allCollections) {
        const left = local.collections?.[id];
        const right = remote.collections?.[id];
        if (!left) result.collections[id] = right;
        else if (!right) result.collections[id] = left;
        else if (left._deleted || right._deleted) result.collections[id] = resolveDeletion(left, right);
        else result.collections[id] = newer(left, right);
      }
      if (!result.collections.default) result.collections.default = makeDefaultCollection();

      const allTopics = new Set([
        ...Object.keys(local.bookmarks || {}),
        ...Object.keys(remote.bookmarks || {}),
      ]);
      for (const key of allTopics) {
        const left = local.bookmarks?.[key];
        const right = remote.bookmarks?.[key];
        if (!left && !right) continue;
        if (!left) {
          result.bookmarks[key] = right;
          continue;
        }
        if (!right) {
          result.bookmarks[key] = left;
          continue;
        }

        if (left._deleted || right._deleted) {
          result.bookmarks[key] = resolveDeletion(left, right);
          continue;
        }

        const merged = { ...newer(left, right), posts: {} };
        const allPosts = new Set([
          ...Object.keys(left.posts || {}),
          ...Object.keys(right.posts || {}),
        ]);
        for (const postKey of allPosts) {
          const lp = left.posts?.[postKey];
          const rp = right.posts?.[postKey];
          if (!lp && !rp) continue;
          if (!lp) merged.posts[postKey] = rp;
          else if (!rp) merged.posts[postKey] = lp;
          else if (lp._deleted || rp._deleted) merged.posts[postKey] = resolveDeletion(lp, rp);
          else merged.posts[postKey] = newer(lp, rp);
        }
        result.bookmarks[key] = merged;
      }

      StarStorage.purgeDeleted(result);
      return normalizeStore(result);

      function newer(a, b) {
        const ta = new Date(a.updatedAt || a.starredAt || a.createdAt || a._deletedAt || 0).getTime();
        const tb = new Date(b.updatedAt || b.starredAt || b.createdAt || b._deletedAt || 0).getTime();
        return ta >= tb ? { ...a } : { ...b };
      }

      function resolveDeletion(a, b) {
        if (a._deleted && b._deleted) return newer(a, b);
        if (a._deleted) {
          const deleteTime = new Date(a._deletedAt || 0).getTime();
          const liveTime = new Date(b.updatedAt || b.starredAt || b.createdAt || 0).getTime();
          return deleteTime >= liveTime ? { ...a } : { ...b };
        }
        const deleteTime = new Date(b._deletedAt || 0).getTime();
        const liveTime = new Date(a.updatedAt || a.starredAt || a.createdAt || 0).getTime();
        return deleteTime >= liveTime ? { ...b } : { ...a };
      }
    },
  };

  function scheduleAutoSync() {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(async () => {
      const config = await SyncManager.getConfig();
      if (config.token && config.gistId && config.autoSync) {
        const result = await SyncManager.sync();
        if (!result.ok) showToast(result.message, '⚠');
      }
    }, 30_000);
  }

  setInterval(async () => {
    const config = await SyncManager.getConfig();
    if (config.token && config.gistId && config.autoSync) {
      await SyncManager.sync();
    }
  }, 30 * 60 * 1000);

  // ========================= Topic DOM =========================
  function getTopicId() {
    const match = location.pathname.match(/\/t\/[^/]+\/(\d+)/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  function getTopicSlug() {
    const match = location.pathname.match(/\/t\/([^/]+)\/\d+/);
    return match ? match[1] : 'topic';
  }

  function getTopicTitle() {
    for (const selector of ['#topic-title h1 a', '.fancy-title', '#topic-title h1', 'h1 .fancy-title']) {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim();
      if (text) return text;
    }
    return document.title.split(' - ')[0]?.trim() || '未知标题';
  }

  function getTopicCategory() {
    for (const selector of ['.topic-category .badge-category__name', '.category-name', '.d-breadcrumbs .badge-category span']) {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim();
      if (text) return text;
    }
    return '';
  }

  function getTopicTags() {
    const tags = [];
    document.querySelectorAll('.discourse-tags .discourse-tag, .topic-header-extra .discourse-tag, #topic-title .discourse-tag, .tag-list .discourse-tag')
      .forEach(element => {
        const tag = element.textContent.trim();
        if (tag && !tags.includes(tag)) tags.push(tag);
      });
    return tags;
  }

  function getTopicMeta() {
    const id = getTopicId();
    return {
      title: getTopicTitle(),
      url: `https://linux.do/t/${getTopicSlug()}/${id}`,
      category: getTopicCategory(),
      tags: getTopicTags(),
    };
  }

  function isTopicPage() {
    return /\/t\/[^/]+\/\d+/.test(location.pathname);
  }

  function getPostNumber(article) {
    const topicPost = article.closest('.topic-post');
    let postNumber = topicPost?.dataset?.postNumber || article.dataset.postNumber || '';
    if (!postNumber && topicPost?.id) {
      const match = topicPost.id.match(/post_(\d+)/);
      if (match) postNumber = match[1];
    }
    if (!postNumber) {
      const link = article.querySelector('a.post-date, .post-number a, a[data-post-number]');
      const href = link?.getAttribute('href') || '';
      const match = href.match(/\/(\d+)$/);
      if (match) postNumber = match[1];
    }
    if (!postNumber) {
      const posts = Array.from(document.querySelectorAll('.topic-post'));
      const index = posts.indexOf(topicPost);
      if (index >= 0) postNumber = String(index + 1);
    }
    return postNumber ? String(postNumber) : '';
  }

  function getPostMeta(article, topicId, postNumber) {
    const authorElement = article.querySelector('.username a, .names .username, .first a, .topic-meta-data .username');
    const contentElement = article.querySelector('.cooked');
    const author = authorElement?.textContent?.trim() || '';
    const excerpt = contentElement?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 180) || '';
    return {
      url: `https://linux.do/t/${getTopicSlug()}/${topicId}/${postNumber}`,
      author,
      excerpt,
    };
  }

  function createStarButton({ isActive, ariaLabel, onDirectClick, onHoverPick, topicId, postNumber }) {
    const button = document.createElement('button');
    button.className = `btn no-text btn-icon ${STAR_CLASS} btn-flat${isActive ? ` ${STAR_ACTIVE_CLASS}` : ''}`;
    button.innerHTML = STAR_SVG;
    button.setAttribute('aria-label', ariaLabel);
    button.setAttribute('title', ariaLabel);
    button.setAttribute('type', 'button');
    if (topicId) button.dataset.topicId = String(topicId);
    if (postNumber) button.dataset.postNumber = String(postNumber);

    let hoverTimer = null;

    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(hoverTimer);

      if (activePopup) {
        closeCollectionPicker();
        return;
      }

      try {
        const newState = await onDirectClick();
        button.classList.toggle(STAR_ACTIVE_CLASS, newState);
        button.setAttribute('title', newState ? '取消收藏' : '收藏');
        button.setAttribute('aria-label', newState ? '取消收藏' : '收藏');
        if (newState) {
          button.classList.add('ldsm-star-just-activated');
          setTimeout(() => button.classList.remove('ldsm-star-just-activated'), 420);
        }
        showToast(newState ? '已收藏' : '已取消收藏', newState ? '⭐' : '☆');
      } catch (error) {
        showToast(error.message || '操作失败', '⚠');
      }
    });

    button.addEventListener('mouseenter', () => {
      hoverTimer = setTimeout(() => onHoverPick(button), 500);
    });
    button.addEventListener('mouseleave', () => clearTimeout(hoverTimer));

    return button;
  }

  async function injectStars() {
    const topicId = getTopicId();
    if (!topicId) return;
    const topicMeta = getTopicMeta();
    const articles = document.querySelectorAll('.topic-post article[data-post-id]:not([data-ldsm-star-injected])');

    for (const article of articles) {
      article.setAttribute('data-ldsm-star-injected', 'true');
      const postNumber = getPostNumber(article);
      if (!postNumber) continue;

      const postMeta = getPostMeta(article, topicId, postNumber);
      const isPostStarred = await StarStorage.isPostStarred(topicId, Number.parseInt(postNumber, 10));
      const actionBar =
        article.querySelector('.post-action-menu__row') ||
        article.querySelector('nav.post-controls .actions') ||
        article.querySelector('.post-menu-area .actions') ||
        article.querySelector('.post-controls .actions');
      if (!actionBar || actionBar.querySelector(`.${STAR_CLASS}`)) continue;

      const starButton = createStarButton({
        isActive: isPostStarred,
        ariaLabel: isPostStarred ? '取消收藏评论' : '收藏评论',
        topicId,
        postNumber,
        onDirectClick: async () => {
          const state = await StarStorage.togglePostStar(topicId, Number.parseInt(postNumber, 10), topicMeta, postMeta, 'default');
          await refreshPageStarStates();
          return state;
        },
        onHoverPick: button => showCollectionPicker(button, { topicId, postNumber, topicMeta, postMeta }),
      });

      const first = actionBar.firstElementChild;
      if (first) actionBar.insertBefore(starButton, first);
      else actionBar.appendChild(starButton);
    }

    injectTopicStar(topicId, topicMeta);
  }

  async function injectTopicStar(topicId, topicMeta) {
    const existing = document.querySelector('.ldsm-star-topic-btn');
    if (existing && existing.parentNode && document.contains(existing)) return;
    existing?.remove();

    const titleElement =
      document.querySelector('#topic-title h1') ||
      document.querySelector('.title-wrapper h1') ||
      document.querySelector('#topic-title .fancy-title');
    if (!titleElement) return;

    const isStarred = await StarStorage.isTopicStarred(topicId);
    const starButton = createStarButton({
      isActive: isStarred,
      ariaLabel: isStarred ? '取消收藏帖子' : '收藏帖子',
      topicId,
      onDirectClick: () => StarStorage.toggleTopicStar(topicId, topicMeta, 'default'),
      onHoverPick: button => showCollectionPicker(button, { topicId, postNumber: null, topicMeta, postMeta: null }),
    });
    starButton.classList.add('ldsm-star-topic-btn');
    starButton.classList.remove('btn', 'no-text', 'btn-icon', 'btn-flat');
    titleElement.style.display = 'inline-flex';
    titleElement.style.alignItems = 'center';
    titleElement.style.gap = '6px';
    titleElement.appendChild(starButton);
  }

  async function refreshPageStarStates() {
    const topicId = getTopicId();
    if (!topicId) return;
    const topicButton = document.querySelector('.ldsm-star-topic-btn');
    if (topicButton) {
      const isStarred = await StarStorage.isTopicStarred(topicId);
      topicButton.classList.toggle(STAR_ACTIVE_CLASS, isStarred);
      topicButton.setAttribute('title', isStarred ? '取消收藏帖子' : '收藏帖子');
    }

    const buttons = document.querySelectorAll(`.${STAR_CLASS}[data-post-number]`);
    for (const button of buttons) {
      const postNumber = Number.parseInt(button.dataset.postNumber, 10);
      if (!postNumber) continue;
      const isPostStarred = await StarStorage.isPostStarred(topicId, postNumber);
      button.classList.toggle(STAR_ACTIVE_CLASS, isPostStarred);
      button.setAttribute('title', isPostStarred ? '取消收藏评论' : '收藏评论');
    }
  }

  function closeCollectionPicker() {
    activePopup?.remove();
    activePopup = null;
    document.removeEventListener('click', onDocumentClickForPicker, true);
  }

  function onDocumentClickForPicker(event) {
    if (activePopup && !activePopup.contains(event.target) && !event.target.closest(`.${STAR_CLASS}`)) {
      closeCollectionPicker();
    }
  }

  async function showCollectionPicker(button, { topicId, postNumber, topicMeta, postMeta }) {
    closeCollectionPicker();
    const store = await StarStorage.getAll();
    let collections = sortedCollections(store);
    const topicKey = `topic_${topicId}`;
    const currentCollectionId = postNumber
      ? store.bookmarks[topicKey]?.posts?.[`post_${postNumber}`]?.collectionId
      : store.bookmarks[topicKey]?.collectionId;

    const popup = document.createElement('div');
    popup.className = 'ldsm-picker';
    popup.innerHTML = `
      <div class="ldsm-picker-header">
        <span>收藏到</span>
        <span>${collections.length} 个收藏夹</span>
      </div>
      <div class="ldsm-picker-search-wrap">
        <input class="ldsm-picker-search" placeholder="搜索收藏夹" type="text">
      </div>
      <div class="ldsm-picker-list"></div>
      <button class="ldsm-picker-item ldsm-picker-new" data-action="new-collection" type="button">
        <span class="ldsm-picker-icon">＋</span>
        <span class="ldsm-picker-name">新建收藏夹</span>
      </button>
    `;

    let pickerFilter = '';
    const renderList = (filter = '') => {
      const list = popup.querySelector('.ldsm-picker-list');
      const query = filter.toLowerCase().trim();
      const filtered = query
        ? collections.filter(col => col.name.toLowerCase().includes(query) || (col.icon || '').includes(query))
        : collections;

      if (!filtered.length) {
        list.innerHTML = '<div class="ldsm-picker-empty">无匹配结果</div>';
        return;
      }

      list.innerHTML = filtered.map(col => `
        <button class="ldsm-picker-item${col.id === currentCollectionId ? ' active' : ''}" data-cid="${attr(col.id)}" type="button" ${!query && col.id !== 'default' ? 'draggable="true"' : ''}>
          <span class="ldsm-picker-icon">${h(col.icon || '📁')}</span>
          <span class="ldsm-picker-name">${h(col.name)}</span>
          ${col.id === currentCollectionId ? '<span class="ldsm-picker-check">✓</span>' : ''}
        </button>
      `).join('');
    };

    renderList();
    popup.querySelector('.ldsm-picker-search').addEventListener('input', event => {
      pickerFilter = event.target.value;
      renderList(pickerFilter);
    });
    popup.querySelector('.ldsm-picker-search').addEventListener('keydown', event => {
      if (event.key === 'Enter') popup.querySelector('.ldsm-picker-list .ldsm-picker-item')?.click();
    });
    const pickerList = popup.querySelector('.ldsm-picker-list');
    pickerList.addEventListener('dragstart', event => {
      if (pickerFilter.trim()) return;
      const item = event.target.closest('.ldsm-picker-item[data-cid]');
      if (!item || item.dataset.cid === 'default') return;
      setDragPayload(event, { type: 'picker-collection', collectionId: item.dataset.cid });
      item.classList.add('ldsm-dragging');
    });
    pickerList.addEventListener('dragover', event => {
      const payload = getDragPayload(event);
      if (!payload || payload.type !== 'picker-collection' || pickerFilter.trim()) return;
      const item = event.target.closest('.ldsm-picker-item[data-cid]');
      if (!item || item.dataset.cid === 'default' || item.dataset.cid === payload.collectionId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      markDragTarget(item, getDropPosition(event, item));
    });
    pickerList.addEventListener('dragleave', handleDragLeave);
    pickerList.addEventListener('drop', async event => {
      const payload = getDragPayload(event);
      const item = event.target.closest('.ldsm-picker-item[data-cid]');
      if (!payload || payload.type !== 'picker-collection' || !item || item.dataset.cid === 'default' || item.dataset.cid === payload.collectionId) return;
      event.preventDefault();
      const position = getDropPosition(event, item);
      const ids = sortedCollections(await StarStorage.getAll()).map(col => col.id).filter(id => id !== 'default');
      await StarStorage.reorderCollections(reorderIds(ids, payload.collectionId, item.dataset.cid, position));
      collections = sortedCollections(await StarStorage.getAll());
      clearDragMarks(popup);
      renderList(pickerFilter);
      if (isManagerOpen()) await reloadManager();
      suppressNextClick();
    });
    pickerList.addEventListener('dragend', handleDragEnd);

    const rect = button.getBoundingClientRect();
    popup.style.top = `${Math.min(window.innerHeight - 16, rect.bottom + 6)}px`;
    popup.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, rect.left - 92))}px`;

    popup.addEventListener('click', async event => {
      event.stopPropagation();
      if (managerState.ignoreNextClick) {
        event.preventDefault();
        return;
      }
      const newButton = event.target.closest('[data-action="new-collection"]');
      if (newButton) {
        newButton.outerHTML = `
          <div class="ldsm-picker-input-row">
            <input class="ldsm-picker-input" placeholder="收藏夹名称" autofocus>
            <button class="ldsm-picker-input-ok" type="button">✓</button>
          </div>
        `;
        const input = popup.querySelector('.ldsm-picker-input');
        const ok = popup.querySelector('.ldsm-picker-input-ok');
        input?.focus();

        const createAndSave = async () => {
          const name = input.value.trim();
          if (!name) return;
          const id = await StarStorage.createCollection(name, ICONS[aliveCollections(store).length % ICONS.length], '#71717a');
          closeCollectionPicker();
          if (postNumber) await StarStorage.togglePostStar(topicId, Number.parseInt(postNumber, 10), topicMeta, postMeta, id);
          else await StarStorage.toggleTopicStar(topicId, topicMeta, id);
          showToast(`已收藏到「${name}」`);
        };
        ok.addEventListener('click', createAndSave);
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') createAndSave();
        });
        return;
      }

      const item = event.target.closest('.ldsm-picker-item[data-cid]');
      if (!item) return;
      const collectionId = item.dataset.cid;
      closeCollectionPicker();
      const isAlreadyStarred = postNumber
        ? await StarStorage.isPostStarred(topicId, Number.parseInt(postNumber, 10))
        : await StarStorage.isTopicStarred(topicId);

      if (isAlreadyStarred) {
        await StarStorage.moveToCollection(topicKey, collectionId, postNumber ? `post_${postNumber}` : null);
        const col = (await StarStorage.getAll()).collections[collectionId];
        showToast(`已移动到「${col?.name || '收藏夹'}」`);
      } else {
        if (postNumber) await StarStorage.togglePostStar(topicId, Number.parseInt(postNumber, 10), topicMeta, postMeta, collectionId);
        else await StarStorage.toggleTopicStar(topicId, topicMeta, collectionId);
        const col = (await StarStorage.getAll()).collections[collectionId];
        showToast(`已收藏到「${col?.name || '收藏夹'}」`);
      }
      await refreshPageStarStates();
    });

    document.body.appendChild(popup);
    activePopup = popup;
    setTimeout(() => document.addEventListener('click', onDocumentClickForPicker, true), 10);
  }

  function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(() => {
      injectScheduled = false;
      injectStars();
    });
  }

  function checkForMissingStars() {
    const actionBars = document.querySelectorAll(
      '.topic-post article[data-post-id] .post-action-menu__row, .topic-post article[data-post-id] nav.post-controls .actions, .topic-post article[data-post-id] .post-controls .actions'
    );
    for (const bar of actionBars) {
      if (!bar.querySelector(`.${STAR_CLASS}`)) {
        const article = bar.closest('article[data-post-id]');
        article?.removeAttribute('data-ldsm-star-injected');
      }
    }

    const hasTitleStar = !!document.querySelector('.ldsm-star-topic-btn');
    const hasTitle = !!document.querySelector('#topic-title h1, #topic-title .fancy-title, .title-wrapper h1');
    const needsInject = (hasTitle && !hasTitleStar) || !!document.querySelector('.topic-post article[data-post-id]:not([data-ldsm-star-injected])');
    if (needsInject) injectStars();
  }

  function observePosts() {
    if (postsObserverStarted) return;
    postsObserverStarted = true;
    const observer = new MutationObserver(scheduleInject);
    observer.observe(document.querySelector('#main-outlet') || document.body, {
      childList: true,
      subtree: true,
    });

    let scrollTimer = null;
    const onScroll = () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        checkForMissingStars();
      }, 300);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    document.querySelector('#main-outlet')?.addEventListener('scroll', onScroll, { passive: true });
    setInterval(checkForMissingStars, 5000);
  }

  function onRouteChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    closeCollectionPicker();
    if (!isTopicPage()) {
      document.querySelectorAll(`.${STAR_CLASS}, .ldsm-star-topic-btn`).forEach(element => element.remove());
      return;
    }
    setTimeout(() => {
      document.querySelectorAll('[data-ldsm-star-injected]').forEach(element => element.removeAttribute('data-ldsm-star-injected'));
      document.querySelectorAll(`.${STAR_CLASS}, .ldsm-star-topic-btn`).forEach(element => element.remove());
      waitAndInject();
    }, 800);
  }

  function watchRouteChanges() {
    if (routeObserverStarted) return;
    routeObserverStarted = true;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      onRouteChange();
    };
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      onRouteChange();
    };
    window.addEventListener('popstate', onRouteChange);
    const title = document.querySelector('title');
    if (title) new MutationObserver(onRouteChange).observe(title, { childList: true });
    setInterval(onRouteChange, 1000);
  }

  function waitAndInject() {
    const timer = setInterval(() => {
      if (document.querySelector('.topic-post article[data-post-id]')) {
        clearInterval(timer);
        injectStars();
        observePosts();
      }
    }, 300);
    setTimeout(() => clearInterval(timer), 15_000);
  }

  // ========================= Manager UI =========================
  function ensureManager() {
    if (managerReady) return;
    managerReady = true;

    const root = document.createElement('div');
    root.id = 'ldsm-root';
    root.innerHTML = `
      <button class="ldsm-fab" id="ldsmFab" type="button" title="收藏管理">
        <span class="ldsm-fab-star">★</span>
        <span class="ldsm-fab-count" id="ldsmFabCount"></span>
      </button>
      <div class="ldsm-shade" id="ldsmShade"></div>
      <aside class="ldsm-manager" id="ldsmManager" aria-label="LinuxDo Star 收藏管理">
        <aside class="ldsm-sidebar">
          <div class="ldsm-sidebar-head">
            <span class="ldsm-logo">★</span>
            <span class="ldsm-logo-text">收藏管理</span>
            <button class="ldsm-icon-btn ldsm-mobile-close" id="ldsmCloseMobile" type="button" title="关闭">${svgX()}</button>
          </div>
          <nav class="ldsm-nav" id="ldsmNav"></nav>
          <div class="ldsm-sidebar-mid">
            <button class="ldsm-btn ldsm-btn-outline ldsm-btn-full" id="ldsmNewCollection" type="button">新建收藏夹</button>
            <button class="ldsm-btn ldsm-btn-outline ldsm-btn-full ldsm-sync-button" id="ldsmSyncButton" type="button">
              ${svgSync()}<span id="ldsmSyncText">同步设置</span>
            </button>
            <label class="ldsm-check-label ldsm-sidebar-toggle"><input type="checkbox" id="ldsmFabToggle"> 右下角悬浮入口</label>
            <div class="ldsm-total" id="ldsmTotal"></div>
          </div>
          <div class="ldsm-sidebar-foot">
            <button class="ldsm-btn ldsm-btn-outline" id="ldsmImport" type="button">导入</button>
            <button class="ldsm-btn ldsm-btn-outline" id="ldsmExport" type="button">导出</button>
            <button class="ldsm-btn ldsm-btn-danger" id="ldsmClear" type="button">清空</button>
          </div>
        </aside>
        <main class="ldsm-main">
          <div class="ldsm-toolbar">
            <div class="ldsm-search">
              ${svgSearch()}<input id="ldsmSearchInput" placeholder="搜索标题、作者、内容">
            </div>
            <div class="ldsm-toolbar-right">
              <div class="ldsm-batch-bar" id="ldsmBatchBar">
                <span id="ldsmBatchCount">已选 0 项</span>
                <button class="ldsm-btn ldsm-btn-danger" id="ldsmBatchDelete" type="button">批量删除</button>
                <button class="ldsm-btn ldsm-btn-outline" id="ldsmBatchCancel" type="button">取消</button>
              </div>
              <label class="ldsm-check-label"><input type="checkbox" id="ldsmBatchMode"> 多选</label>
              <select class="ldsm-select" id="ldsmSort">
                <option value="custom">自定义排序</option>
                <option value="newest">最新收藏</option>
                <option value="oldest">最早收藏</option>
                <option value="title">按标题</option>
              </select>
              <button class="ldsm-icon-btn ldsm-close" id="ldsmClose" type="button" title="关闭">${svgX()}</button>
            </div>
          </div>
          <div class="ldsm-content" id="ldsmContent"></div>
        </main>
        <div class="ldsm-subshade" id="ldsmSubshade"></div>
        <aside class="ldsm-panel" id="ldsmPanel">
          <div class="ldsm-panel-head">
            <h2 id="ldsmPanelTitle">详情</h2>
            <button class="ldsm-icon-btn" id="ldsmPanelClose" type="button" title="关闭">${svgX()}</button>
          </div>
          <div class="ldsm-panel-body" id="ldsmPanelBody"></div>
        </aside>
      </aside>
      <input type="file" id="ldsmImportFile" accept=".json" hidden>
    `;
    document.body.appendChild(root);

    $('#ldsmFab').addEventListener('click', openManager);
    $('#ldsmShade').addEventListener('click', closeManager);
    $('#ldsmClose').addEventListener('click', closeManager);
    $('#ldsmCloseMobile').addEventListener('click', closeManager);
    $('#ldsmPanelClose').addEventListener('click', closePanel);
    $('#ldsmSubshade').addEventListener('click', closePanel);
    $('#ldsmSearchInput').addEventListener('input', debounce(event => {
      managerState.query = event.target.value.toLowerCase().trim();
      renderManager();
    }, 120));
    $('#ldsmSort').addEventListener('change', event => {
      managerState.sort = event.target.value;
      renderManager();
    });
    $('#ldsmBatchMode').addEventListener('change', event => {
      managerState.batchMode = event.target.checked;
      managerState.selected.clear();
      updateBatchBar();
      renderManager();
    });
    $('#ldsmBatchCancel').addEventListener('click', () => {
      managerState.batchMode = false;
      managerState.selected.clear();
      $('#ldsmBatchMode').checked = false;
      updateBatchBar();
      renderManager();
    });
    $('#ldsmBatchDelete').addEventListener('click', batchDelete);
    $('#ldsmNav').addEventListener('click', handleNavClick);
    $('#ldsmNav').addEventListener('dragstart', handleNavDragStart);
    $('#ldsmNav').addEventListener('dragover', handleNavDragOver);
    $('#ldsmNav').addEventListener('dragleave', handleDragLeave);
    $('#ldsmNav').addEventListener('drop', handleNavDrop);
    $('#ldsmNav').addEventListener('dragend', handleDragEnd);
    $('#ldsmContent').addEventListener('click', handleContentClick);
    $('#ldsmContent').addEventListener('dragstart', handleContentDragStart);
    $('#ldsmContent').addEventListener('dragover', handleContentDragOver);
    $('#ldsmContent').addEventListener('dragleave', handleDragLeave);
    $('#ldsmContent').addEventListener('drop', handleContentDrop);
    $('#ldsmContent').addEventListener('dragend', handleDragEnd);
    $('#ldsmNewCollection').addEventListener('click', createCollectionFromManager);
    $('#ldsmSyncButton').addEventListener('click', openSyncPanel);
    $('#ldsmFabToggle').addEventListener('change', event => {
      saveUiConfig({ showFab: event.target.checked });
      showToast(event.target.checked ? '已显示悬浮入口' : '已隐藏悬浮入口');
    });
    $('#ldsmExport').addEventListener('click', exportStore);
    $('#ldsmImport').addEventListener('click', () => $('#ldsmImportFile').click());
    $('#ldsmImportFile').addEventListener('change', importStore);
    $('#ldsmClear').addEventListener('click', clearStore);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (managerState.panelOpen) closePanel();
      else if (isManagerOpen()) closeManager();
    });
    applyUiConfig();
  }

  function $(selector) {
    return document.querySelector(selector);
  }

  function isManagerOpen() {
    return !!document.querySelector('#ldsmManager.ldsm-open');
  }

  async function openManager() {
    ensureManager();
    $('#ldsmManager').classList.add('ldsm-open');
    $('#ldsmShade').classList.add('ldsm-open');
    document.body.classList.add('ldsm-body-lock');
    await reloadManager();
  }

  function closeManager() {
    closePanel();
    $('#ldsmManager')?.classList.remove('ldsm-open');
    $('#ldsmShade')?.classList.remove('ldsm-open');
    document.body.classList.remove('ldsm-body-lock');
  }

  async function reloadManager() {
    if (!managerReady) return;
    managerState.store = await StarStorage.getAll();
    renderNav();
    renderManager();
    renderSyncStatus();
  }

  async function refreshFabCount() {
    ensureManager();
    const store = await StarStorage.getAll();
    const count = countStore(store);
    const badge = $('#ldsmFabCount');
    if (!badge) return;
    const total = count.topics + count.posts;
    badge.textContent = total ? String(total) : '';
    badge.style.display = total ? 'inline-flex' : 'none';
  }

  function renderNav() {
    const store = managerState.store;
    if (!store) return;
    const counts = { all: 0 };
    for (const [, bookmark] of aliveBookmarks(store)) {
      const cid = bookmark.collectionId || 'default';
      counts[cid] = (counts[cid] || 0) + 1;
      counts.all++;
    }

    const postCount = aliveBookmarks(store).reduce((total, [, bookmark]) => total + alivePosts(bookmark).length, 0);
    $('#ldsmTotal').textContent = `${counts.all || 0} 帖 · ${postCount} 评`;

    const collections = sortedCollections(store);
    $('#ldsmNav').innerHTML = `
      <button class="ldsm-nav-item${managerState.currentView === 'all' ? ' active' : ''}" data-view="all" type="button">
        ${svgHome()}<span>全部</span><span class="ldsm-nav-count">${counts.all || 0}</span>
      </button>
      ${collections.map(col => `
        <button class="ldsm-nav-item${managerState.currentView === col.id ? ' active' : ''}" data-view="${attr(col.id)}" type="button" ${col.id !== 'default' ? 'draggable="true"' : ''}>
          <span class="ldsm-nav-icon">${h(col.icon || '📁')}</span>
          <span class="ldsm-nav-name">${h(col.name)}</span>
          <span class="ldsm-nav-count">${counts[col.id] || 0}</span>
          ${col.id !== 'default' ? `<span class="ldsm-nav-edit" data-act="edit-col" data-cid="${attr(col.id)}">...</span>` : ''}
        </button>
      `).join('')}
    `;
  }

  function renderManager() {
    const store = managerState.store;
    if (!store) return;
    const content = $('#ldsmContent');
    const query = managerState.query;
    let items = [];

    for (const [key, bookmark] of aliveBookmarks(store)) {
      if (managerState.currentView !== 'all' && (bookmark.collectionId || 'default') !== managerState.currentView) continue;
      let match = !query;
      if (query) {
        if (bookmark.topicTitle?.toLowerCase().includes(query)) match = true;
        if ((bookmark.tags || []).some(tag => tag.toLowerCase().includes(query))) match = true;
        if (bookmark.note?.toLowerCase().includes(query)) match = true;
        if (alivePosts(bookmark).some(([, post]) => post.author?.toLowerCase().includes(query) || post.excerpt?.toLowerCase().includes(query))) match = true;
      }
      if (match) items.push({ key, ...bookmark });
    }

    if (managerState.sort === 'custom') {
      if (managerState.currentView === 'all') {
        const collectionsById = new Map(sortedCollections(store).map(col => [col.id, col]));
        items.sort((a, b) => {
          const ac = a.collectionId || 'default';
          const bc = b.collectionId || 'default';
          const collectionDiff = collectionSortValue(collectionsById.get(ac)) - collectionSortValue(collectionsById.get(bc));
          if (collectionDiff) return collectionDiff;
          const orderDiff = collectionItemOrder(a, ac) - collectionItemOrder(b, bc);
          if (orderDiff) return orderDiff;
          return new Date(b.starredAt || b.updatedAt || 0) - new Date(a.starredAt || a.updatedAt || 0);
        });
      } else {
        sortBookmarksByCustomOrder(items, managerState.currentView);
      }
    } else {
      items.sort((a, b) => {
        if (managerState.sort === 'oldest') return new Date(a.starredAt || a.updatedAt || 0) - new Date(b.starredAt || b.updatedAt || 0);
        if (managerState.sort === 'title') return (a.topicTitle || '').localeCompare(b.topicTitle || '', 'zh-CN');
        return new Date(b.starredAt || b.updatedAt || 0) - new Date(a.starredAt || a.updatedAt || 0);
      });
    }

    if (!items.length) {
      content.innerHTML = `
        <div class="ldsm-empty">
          ${STAR_SVG}
          <h3>${query ? '无匹配' : '暂无收藏'}</h3>
          <p>在帖子页点击星标开始收藏</p>
        </div>
      `;
      return;
    }

    content.innerHTML = items.map(item => renderTopicCard(item, store)).join('');
  }

  function renderTopicCard(item, store) {
    const posts = alivePosts(item)
      .map(([postKey, post]) => ({ postKey, ...post }))
      .sort((a, b) => new Date(b.starredAt || 0) - new Date(a.starredAt || 0));
    const isOpen = managerState.expanded.has(item.key);
    const collection = store.collections[item.collectionId] || store.collections.default;
    const sortable = canReorderCurrentView();

    return `
      <div class="ldsm-card${isOpen ? ' open' : ''}${sortable ? ' ldsm-card-sortable' : ''}" data-key="${attr(item.key)}" ${!managerState.batchMode ? 'draggable="true"' : ''}>
        <div class="ldsm-card-head">
          ${sortable ? '<span class="ldsm-drag-handle" draggable="true" title="拖拽排序" aria-label="拖拽排序">⋮⋮</span>' : ''}
          ${managerState.batchMode
            ? `<input type="checkbox" class="ldsm-card-check" data-key="${attr(item.key)}" ${managerState.selected.has(item.key) ? 'checked' : ''}>`
            : svgChevron()}
          <span class="ldsm-card-star">★</span>
          <div class="ldsm-card-body">
            <div class="ldsm-card-title"><a href="${attr(item.topicUrl)}" target="_blank" rel="noopener">${h(item.topicTitle || '未知标题')}</a></div>
            <div class="ldsm-card-meta">
              ${item.category ? `<span class="ldsm-tag">${h(item.category)}</span>` : ''}
              ${managerState.currentView === 'all' ? `<span class="ldsm-tag">${h(collection?.name || '默认收藏夹')}</span>` : ''}
              ${(item.tags || []).slice(0, 3).map(tag => `<span class="ldsm-tag ldsm-tag-note">${h(tag)}</span>`).join('')}
              ${(item.tags || []).length > 3 ? `<span class="ldsm-tag">+${item.tags.length - 3}</span>` : ''}
              ${item.note ? '<span class="ldsm-tag ldsm-tag-note">备注</span>' : ''}
              <span class="ldsm-time">${formatTime(item.starredAt || item.updatedAt)}</span>
              ${posts.length ? `<span class="ldsm-tag ldsm-comment-count">${posts.length} 评论</span>` : ''}
            </div>
          </div>
          <div class="ldsm-card-actions">
            <button class="ldsm-icon-btn" data-act="detail-t" data-key="${attr(item.key)}" type="button" title="详情">${svgInfo()}</button>
            <button class="ldsm-icon-btn" data-act="move" data-tkey="${attr(item.key)}" type="button" title="移动">${svgFolder()}</button>
            <button class="ldsm-icon-btn ldsm-danger-hover" data-act="del-t" data-key="${attr(item.key)}" type="button" title="删除">${svgX()}</button>
          </div>
        </div>
        ${posts.length ? `<div class="ldsm-card-posts">
          ${posts.map(post => `
            <div class="ldsm-post-row" data-url="${attr(post.postUrl)}" data-tkey="${attr(item.key)}" ${!managerState.batchMode ? 'draggable="true"' : ''}>
              <span class="ldsm-post-num">#${h(post.postNumber)}</span>
              <div class="ldsm-post-info">
                <span class="ldsm-post-author">@${h(post.author || '?')}</span>
                <div class="ldsm-post-excerpt">${h(post.excerpt || '')}</div>
                ${post.note ? `<div class="ldsm-post-note">${h(post.note)}</div>` : ''}
                <div class="ldsm-post-time">${formatTime(post.starredAt || post.updatedAt)}</div>
              </div>
              <div class="ldsm-post-actions">
                <button class="ldsm-icon-btn" data-act="detail-p" data-tkey="${attr(item.key)}" data-pkey="${attr(post.postKey)}" type="button" title="详情">${svgInfo()}</button>
                <button class="ldsm-icon-btn" data-act="move" data-tkey="${attr(item.key)}" data-pkey="${attr(post.postKey)}" type="button" title="移动">${svgFolder()}</button>
                <button class="ldsm-icon-btn ldsm-danger-hover" data-act="del-p" data-tkey="${attr(item.key)}" data-pkey="${attr(post.postKey)}" type="button" title="删除">${svgX()}</button>
              </div>
            </div>
          `).join('')}
        </div>` : ''}
      </div>
    `;
  }

  function handleNavClick(event) {
    if (managerState.ignoreNextClick) {
      event.preventDefault();
      return;
    }
    const edit = event.target.closest('[data-act="edit-col"]');
    if (edit) {
      event.stopPropagation();
      openCollectionPanel(edit.dataset.cid);
      return;
    }

    const item = event.target.closest('.ldsm-nav-item');
    if (!item) return;
    managerState.currentView = item.dataset.view;
    renderNav();
    renderManager();
  }

  function handleNavDragStart(event) {
    const item = event.target.closest('.ldsm-nav-item[data-view]');
    if (!item || item.dataset.view === 'all' || item.dataset.view === 'default' || event.target.closest('[data-act]')) return;
    setDragPayload(event, { type: 'manager-collection', collectionId: item.dataset.view });
    item.classList.add('ldsm-dragging');
  }

  function handleNavDragOver(event) {
    const payload = getDragPayload(event);
    const item = event.target.closest('.ldsm-nav-item[data-view]');
    if (!payload || !item || item.dataset.view === 'all') return;

    if (payload.type === 'manager-collection') {
      if (item.dataset.view === 'default' || item.dataset.view === payload.collectionId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      markDragTarget(item, getDropPosition(event, item));
      return;
    }

    if (payload.type === 'topic') {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      item.classList.add('ldsm-drag-over');
    }
  }

  async function handleNavDrop(event) {
    const payload = getDragPayload(event);
    const item = event.target.closest('.ldsm-nav-item[data-view]');
    if (!payload || !item || item.dataset.view === 'all') return;
    event.preventDefault();

    if (payload.type === 'manager-collection') {
      if (item.dataset.view === 'default' || item.dataset.view === payload.collectionId) return;
      const position = getDropPosition(event, item);
      const ids = sortedCollections(await StarStorage.getAll()).map(col => col.id).filter(id => id !== 'default');
      await StarStorage.reorderCollections(reorderIds(ids, payload.collectionId, item.dataset.view, position));
      showToast('已调整收藏夹顺序');
    } else if (payload.type === 'topic') {
      await StarStorage.moveToCollection(payload.topicKey, item.dataset.view, null);
      showToast('已移动到收藏夹');
    }

    clearDragMarks();
    await reloadManager();
    suppressNextClick();
  }

  async function handleContentClick(event) {
    if (managerState.ignoreNextClick) {
      event.preventDefault();
      return;
    }
    if (event.target.closest('.ldsm-drag-handle')) {
      event.preventDefault();
      return;
    }
    const checkbox = event.target.closest('.ldsm-card-check');
    if (checkbox) {
      const key = checkbox.dataset.key;
      if (checkbox.checked) managerState.selected.add(key);
      else managerState.selected.delete(key);
      updateBatchBar();
      return;
    }

    const action = event.target.closest('[data-act]');
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      const act = action.dataset.act;
      if (act === 'del-t') await confirmThen(`删除「${managerState.store.bookmarks[action.dataset.key]?.topicTitle || '该帖子'}」？`, () => StarStorage.softDeleteTopic(action.dataset.key));
      if (act === 'del-p') await confirmThen('删除这条评论收藏？', () => StarStorage.softDeletePost(action.dataset.tkey, action.dataset.pkey));
      if (act === 'detail-t') openTopicPanel(action.dataset.key);
      if (act === 'detail-p') openPostPanel(action.dataset.tkey, action.dataset.pkey);
      if (act === 'move') openMovePanel(action.dataset.tkey, action.dataset.pkey || null);
      return;
    }

    const postRow = event.target.closest('.ldsm-post-row');
    if (postRow?.dataset.url) {
      openExternal(postRow.dataset.url);
      return;
    }

    const head = event.target.closest('.ldsm-card-head');
    if (!head || event.target.closest('a')) return;
    const card = head.closest('.ldsm-card');
    const key = card.dataset.key;
    if (managerState.batchMode) {
      const input = card.querySelector('.ldsm-card-check');
      input.checked = !input.checked;
      if (input.checked) managerState.selected.add(key);
      else managerState.selected.delete(key);
      updateBatchBar();
      return;
    }
    card.classList.toggle('open');
    if (managerState.expanded.has(key)) managerState.expanded.delete(key);
    else managerState.expanded.add(key);
  }

  function handleContentDragStart(event) {
    if (managerState.batchMode) return;
    const handle = event.target.closest('.ldsm-drag-handle');
    if (!handle && event.target.closest('[data-act], a, input, textarea, select, button')) return;
    const row = event.target.closest('.ldsm-post-row[data-tkey]');
    const card = event.target.closest('.ldsm-card[data-key]');
    const topicKey = row?.dataset.tkey || card?.dataset.key;
    const dragElement = handle ? card : (row || card);
    if (!topicKey || !dragElement) return;
    setDragPayload(event, {
      type: 'topic',
      topicKey,
      sourceCollectionId: managerState.currentView,
    });
    dragElement.classList.add('ldsm-dragging');
  }

  function handleContentDragOver(event) {
    const payload = getDragPayload(event);
    if (!payload || payload.type !== 'topic' || !canReorderCurrentView()) return;
    const card = event.target.closest('.ldsm-card[data-key]');
    if (!card || card.dataset.key === payload.topicKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    markDragTarget(card, getDropPosition(event, card));
  }

  async function handleContentDrop(event) {
    const payload = getDragPayload(event);
    if (!payload || payload.type !== 'topic' || !canReorderCurrentView()) return;
    const card = event.target.closest('.ldsm-card[data-key]');
    if (!card || card.dataset.key === payload.topicKey) return;
    event.preventDefault();
    const ids = Array.from($('#ldsmContent').querySelectorAll('.ldsm-card[data-key]')).map(item => item.dataset.key);
    const nextIds = reorderIds(ids, payload.topicKey, card.dataset.key, getDropPosition(event, card));
    await StarStorage.reorderTopics(managerState.currentView, nextIds);
    clearDragMarks();
    await reloadManager();
    showToast('已调整收藏顺序');
    suppressNextClick();
  }

  function handleDragLeave(event) {
    const target = event.target.closest?.('.ldsm-nav-item, .ldsm-card, .ldsm-picker-item');
    if (!target || target.contains(event.relatedTarget)) return;
    target.classList.remove('ldsm-drag-over', 'ldsm-drag-before', 'ldsm-drag-after');
  }

  function handleDragEnd() {
    clearDragMarks();
    managerState.dragging = null;
  }

  async function createCollectionFromManager() {
    openPanel('新建收藏夹', `
      <div class="ldsm-field">
        <label>名称</label>
        <input class="ldsm-input" id="ldsmColName" placeholder="收藏夹名称">
      </div>
      <div class="ldsm-field">
        <label>图标</label>
        <div class="ldsm-icon-grid" id="ldsmIconGrid">
          ${ICONS.map((icon, index) => `<button class="ldsm-icon-opt${index === 0 ? ' active' : ''}" data-icon="${attr(icon)}" type="button">${h(icon)}</button>`).join('')}
        </div>
      </div>
      <button class="ldsm-btn ldsm-btn-primary" id="ldsmSaveCollection" type="button">保存</button>
    `);
    let icon = ICONS[0];
    $('#ldsmIconGrid').addEventListener('click', event => {
      const item = event.target.closest('.ldsm-icon-opt');
      if (!item) return;
      $('#ldsmIconGrid').querySelectorAll('.ldsm-icon-opt').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      icon = item.dataset.icon;
    });
    $('#ldsmSaveCollection').addEventListener('click', async () => {
      const name = $('#ldsmColName').value.trim();
      if (!name) return;
      await StarStorage.createCollection(name, icon);
      closePanel();
      showToast('已新建收藏夹');
    });
    $('#ldsmColName').focus();
  }

  function openCollectionPanel(collectionId) {
    const collection = managerState.store.collections[collectionId];
    if (!collection) return;
    openPanel('编辑收藏夹', `
      <div class="ldsm-field">
        <label>名称</label>
        <input class="ldsm-input" id="ldsmColName" value="${attr(collection.name)}">
      </div>
      <div class="ldsm-field">
        <label>图标</label>
        <div class="ldsm-icon-grid" id="ldsmIconGrid">
          ${ICONS.map(icon => `<button class="ldsm-icon-opt${icon === collection.icon ? ' active' : ''}" data-icon="${attr(icon)}" type="button">${h(icon)}</button>`).join('')}
        </div>
      </div>
      <div class="ldsm-action-row">
        <button class="ldsm-btn ldsm-btn-primary" id="ldsmSaveCollection" type="button">保存</button>
        <button class="ldsm-btn ldsm-btn-danger" id="ldsmDeleteCollection" type="button">删除收藏夹</button>
      </div>
    `);
    let icon = collection.icon || '📁';
    $('#ldsmIconGrid').addEventListener('click', event => {
      const item = event.target.closest('.ldsm-icon-opt');
      if (!item) return;
      $('#ldsmIconGrid').querySelectorAll('.ldsm-icon-opt').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      icon = item.dataset.icon;
    });
    $('#ldsmSaveCollection').addEventListener('click', async () => {
      const name = $('#ldsmColName').value.trim();
      if (!name) return;
      await StarStorage.updateCollection(collectionId, { name, icon });
      closePanel();
      showToast('已保存收藏夹');
    });
    $('#ldsmDeleteCollection').addEventListener('click', async () => {
      await confirmThen('删除该收藏夹？其中收藏会移到默认收藏夹。', async () => {
        await StarStorage.deleteCollection(collectionId);
        if (managerState.currentView === collectionId) managerState.currentView = 'all';
        closePanel();
      });
    });
  }

  function openTopicPanel(key) {
    const topic = managerState.store.bookmarks[key];
    if (!topic) return;
    const collection = managerState.store.collections[topic.collectionId] || managerState.store.collections.default;
    openPanel('帖子详情', `
      <div class="ldsm-field"><label>标题</label><div class="ldsm-field-value"><a href="${attr(topic.topicUrl)}" target="_blank" rel="noopener">${h(topic.topicTitle)}</a></div></div>
      <div class="ldsm-field"><label>收藏夹</label><div class="ldsm-field-value">${h(collection?.name || '默认收藏夹')}</div></div>
      <div class="ldsm-field"><label>分类</label><div class="ldsm-field-value">${h(topic.category || '-')}</div></div>
      <div class="ldsm-field"><label>收藏时间</label><div class="ldsm-field-value">${topic.starredAt ? h(new Date(topic.starredAt).toLocaleString('zh-CN')) : '-'}</div></div>
      <div class="ldsm-field"><label>标签</label>${renderTagEditor(topic.tags || [])}</div>
      <div class="ldsm-field"><label>备注</label><textarea class="ldsm-textarea" id="ldsmNoteInput" placeholder="写点备注">${h(topic.note || '')}</textarea></div>
      <button class="ldsm-btn ldsm-btn-primary" id="ldsmSaveDetail" type="button">保存</button>
    `);
    bindTagAndNoteEditor(async tags => {
      const store = await StarStorage.getAll();
      const target = store.bookmarks[key];
      if (!target) return;
      target.tags = tags;
      target.note = $('#ldsmNoteInput').value.trim();
      target.updatedAt = nowIso();
      await StarStorage.save(store);
      closePanel();
      showToast('已保存');
    });
  }

  function openPostPanel(topicKey, postKey) {
    const topic = managerState.store.bookmarks[topicKey];
    const post = topic?.posts?.[postKey];
    if (!topic || !post) return;
    openPanel(`#${post.postNumber} 评论详情`, `
      <div class="ldsm-field"><label>帖子</label><div class="ldsm-field-value"><a href="${attr(topic.topicUrl)}" target="_blank" rel="noopener">${h(topic.topicTitle)}</a></div></div>
      <div class="ldsm-field"><label>作者</label><div class="ldsm-field-value">@${h(post.author || '?')}</div></div>
      <div class="ldsm-field"><label>内容</label><div class="ldsm-field-value">${h(post.excerpt || '')}</div></div>
      <div class="ldsm-field"><label>链接</label><div class="ldsm-field-value"><a href="${attr(post.postUrl)}" target="_blank" rel="noopener">打开原文</a></div></div>
      <div class="ldsm-field"><label>收藏时间</label><div class="ldsm-field-value">${post.starredAt ? h(new Date(post.starredAt).toLocaleString('zh-CN')) : '-'}</div></div>
      <div class="ldsm-field"><label>标签</label>${renderTagEditor(post.tags || [])}</div>
      <div class="ldsm-field"><label>备注</label><textarea class="ldsm-textarea" id="ldsmNoteInput" placeholder="写点备注">${h(post.note || '')}</textarea></div>
      <button class="ldsm-btn ldsm-btn-primary" id="ldsmSaveDetail" type="button">保存</button>
    `);
    bindTagAndNoteEditor(async tags => {
      const store = await StarStorage.getAll();
      const target = store.bookmarks[topicKey]?.posts?.[postKey];
      if (!target) return;
      target.tags = tags;
      target.note = $('#ldsmNoteInput').value.trim();
      target.updatedAt = nowIso();
      store.bookmarks[topicKey].updatedAt = nowIso();
      await StarStorage.save(store);
      closePanel();
      showToast('已保存');
    });
  }

  function renderTagEditor(tags) {
    return `
      <div class="ldsm-tag-editor" id="ldsmTagEditor">
        ${tags.map(tag => `<span class="ldsm-tag-pill" data-tag="${attr(tag)}">${h(tag)}<button type="button" title="移除">×</button></span>`).join('')}
        <input id="ldsmTagInput" placeholder="回车添加">
      </div>
    `;
  }

  function bindTagAndNoteEditor(onSave) {
    let tags = Array.from($('#ldsmTagEditor').querySelectorAll('.ldsm-tag-pill')).map(tag => tag.dataset.tag);
    const render = () => {
      $('#ldsmTagEditor').innerHTML = `
        ${tags.map(tag => `<span class="ldsm-tag-pill" data-tag="${attr(tag)}">${h(tag)}<button type="button" title="移除">×</button></span>`).join('')}
        <input id="ldsmTagInput" placeholder="回车添加">
      `;
      bind();
    };
    const bind = () => {
      $('#ldsmTagEditor').querySelectorAll('.ldsm-tag-pill button').forEach(button => {
        button.addEventListener('click', event => {
          const tag = event.target.closest('.ldsm-tag-pill').dataset.tag;
          tags = tags.filter(item => item !== tag);
          render();
        });
      });
      $('#ldsmTagInput').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const value = event.target.value.trim();
        if (value && !tags.includes(value)) {
          tags.push(value);
          render();
        }
      });
    };
    bind();
    $('#ldsmSaveDetail').addEventListener('click', () => onSave(tags));
  }

  function openMovePanel(topicKey, postKey) {
    const collections = sortedCollections(managerState.store);
    const current = postKey
      ? managerState.store.bookmarks[topicKey]?.posts?.[postKey]?.collectionId
      : managerState.store.bookmarks[topicKey]?.collectionId;
    openPanel('移动到收藏夹', `
      <div class="ldsm-move-list">
        ${collections.map(col => `
          <button class="ldsm-move-item${col.id === (current || 'default') ? ' active' : ''}" data-cid="${attr(col.id)}" type="button">
            <span>${h(col.icon || '📁')}</span><span>${h(col.name)}</span>
            ${col.id === (current || 'default') ? '<span class="ldsm-move-check">✓</span>' : ''}
          </button>
        `).join('')}
      </div>
    `);
    const panelBody = $('#ldsmPanelBody');
    const onMoveClick = async event => {
      const item = event.target.closest('.ldsm-move-item');
      if (!item) return;
      panelBody.removeEventListener('click', onMoveClick);
      await StarStorage.moveToCollection(topicKey, item.dataset.cid, postKey || null);
      closePanel();
      showToast('已移动');
    };
    panelBody.addEventListener('click', onMoveClick);
  }

  async function exportStore() {
    const store = await StarStorage.getAll();
    const total = aliveBookmarks(store).length;
    if (!total) {
      showToast('暂无收藏可导出', '☆');
      return;
    }
    downloadText(
      JSON.stringify({ exportedAt: nowIso(), v: '1.0-tampermonkey', data: store }, null, 2),
      `linuxdo-stars-${new Date().toISOString().slice(0, 10)}.json`
    );
  }

  async function importStore(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      showToast('导入文件过大', '⚠');
      event.target.value = '';
      return;
    }
    try {
      const json = JSON.parse(await file.text());
      const imported = normalizeStore(json.data || json);
      const current = await StarStorage.getAll();
      const merged = SyncManager.merge(current, imported);
      await StarStorage.save(merged);
      showToast('导入成功');
    } catch {
      showToast('文件格式错误', '⚠');
    } finally {
      event.target.value = '';
    }
  }

  async function clearStore() {
    await confirmThen('清空全部收藏？该操作会生成同步删除记录。', async () => {
      const store = await StarStorage.getAll();
      const time = nowIso();
      for (const [key, bookmark] of Object.entries(store.bookmarks)) {
        store.bookmarks[key] = {
          _deleted: true,
          _deletedAt: time,
          topicId: bookmark.topicId,
        };
      }
      await StarStorage.save(store);
      showToast('已清空收藏');
    });
  }

  async function batchDelete() {
    if (!managerState.selected.size) return;
    await confirmThen(`删除选中的 ${managerState.selected.size} 个帖子？`, async () => {
      for (const key of managerState.selected) await StarStorage.softDeleteTopic(key);
      managerState.selected.clear();
      managerState.batchMode = false;
      $('#ldsmBatchMode').checked = false;
      updateBatchBar();
      showToast('已删除');
    });
  }

  function updateBatchBar() {
    const bar = $('#ldsmBatchBar');
    if (!bar) return;
    bar.classList.toggle('visible', managerState.batchMode);
    $('#ldsmBatchCount').textContent = `已选 ${managerState.selected.size} 项`;
  }

  async function confirmThen(message, onYes) {
    if (!window.confirm(message)) return;
    await onYes();
  }

  async function openSyncPanel() {
    const config = await SyncManager.getConfig();
    const connected = !!(config.token && config.gistId);

    if (!connected) {
      openPanel('同步设置', `
        <div class="ldsm-sync-field">
          <label>GitHub Personal Access Token</label>
          <input class="ldsm-input ldsm-mono" id="ldsmTokenInput" type="password" placeholder="ghp_xxxxxxxxxxxx">
          <div class="ldsm-help">
            需要 gist 权限的 Token。<a href="https://github.com/settings/tokens/new?scopes=gist&description=LinuxDo+Star+Sync" target="_blank" rel="noopener">创建 Token</a>
          </div>
        </div>
        <button class="ldsm-btn ldsm-btn-primary" id="ldsmConnectSync" type="button">连接 GitHub</button>
        <div id="ldsmSyncMessage"></div>
      `);
      $('#ldsmConnectSync').addEventListener('click', async () => {
        const token = $('#ldsmTokenInput').value.trim();
        if (!token) return;
        const button = $('#ldsmConnectSync');
        button.disabled = true;
        button.textContent = '连接中...';
        const result = await SyncManager.connect(token);
        if (result.ok) {
          showToast('同步已连接');
          await reloadManager();
          openSyncPanel();
        } else {
          $('#ldsmSyncMessage').innerHTML = `<div class="ldsm-sync-error">${h(result.message)}</div>`;
          button.disabled = false;
          button.textContent = '连接 GitHub';
        }
      });
      return;
    }

    openPanel('同步设置', `
      <div class="ldsm-sync-field"><label>状态</label><div class="ldsm-sync-value"><span class="ldsm-sync-dot ${attr(config.status || 'connected')}"></span>${config.username ? `@${h(config.username)}` : '已连接'}</div></div>
      <div class="ldsm-sync-field"><label>Gist ID</label><div class="ldsm-sync-value ldsm-mono"><a href="https://gist.github.com/${attr(config.gistId)}" target="_blank" rel="noopener">${h(config.gistId)}</a></div></div>
      <div class="ldsm-sync-field"><label>上次同步</label><div class="ldsm-sync-value">${config.lastSyncAt ? h(new Date(config.lastSyncAt).toLocaleString('zh-CN')) : '从未'}</div></div>
      ${config.lastError ? `<div class="ldsm-sync-error">上次错误：${h(config.lastError)}</div>` : ''}
      <label class="ldsm-check-label ldsm-sync-toggle"><input type="checkbox" id="ldsmAutoSync" ${config.autoSync ? 'checked' : ''}> 自动同步</label>
      <div class="ldsm-action-row">
        <button class="ldsm-btn ldsm-btn-primary" id="ldsmSyncNow" type="button">${svgSync()}立即同步</button>
        <button class="ldsm-btn ldsm-btn-danger" id="ldsmDisconnectSync" type="button">断开连接</button>
      </div>
      <div id="ldsmSyncMessage"></div>
    `);

    $('#ldsmAutoSync').addEventListener('change', async event => {
      const next = await SyncManager.getConfig();
      next.autoSync = event.target.checked;
      await SyncManager.saveConfig(next);
      showToast(next.autoSync ? '已开启自动同步' : '已关闭自动同步');
    });
    $('#ldsmSyncNow').addEventListener('click', async () => {
      const button = $('#ldsmSyncNow');
      button.disabled = true;
      button.textContent = '同步中...';
      const result = await SyncManager.sync();
      if (result.ok) {
        $('#ldsmSyncMessage').innerHTML = '<div class="ldsm-sync-ok">同步成功</div>';
        showToast('同步成功');
      } else {
        $('#ldsmSyncMessage').innerHTML = `<div class="ldsm-sync-error">${h(result.message)}</div>`;
      }
      button.disabled = false;
      button.innerHTML = `${svgSync()}立即同步`;
    });
    $('#ldsmDisconnectSync').addEventListener('click', async () => {
      await SyncManager.disconnect();
      showToast('已断开同步');
      openSyncPanel();
    });
  }

  async function renderSyncStatus() {
    if (!managerReady) return;
    const config = await SyncManager.getConfig();
    const button = $('#ldsmSyncButton');
    const text = $('#ldsmSyncText');
    if (!button || !text) return;
    button.classList.toggle('syncing', config.status === 'syncing');
    if (!config.token || !config.gistId) text.textContent = '同步设置';
    else if (config.status === 'syncing') text.textContent = '同步中';
    else if (config.status === 'error') text.textContent = '同步失败';
    else text.textContent = '已同步';
  }

  function openPanel(title, bodyHtml) {
    ensureManager();
    $('#ldsmPanelTitle').textContent = title;
    const oldBody = $('#ldsmPanelBody');
    const body = oldBody.cloneNode(false);
    oldBody.replaceWith(body);
    body.innerHTML = bodyHtml;
    $('#ldsmPanel').classList.add('open');
    $('#ldsmSubshade').classList.add('open');
    managerState.panelOpen = true;
  }

  function closePanel() {
    $('#ldsmPanel')?.classList.remove('open');
    $('#ldsmSubshade')?.classList.remove('open');
    managerState.panelOpen = false;
  }

  // ========================= Icons =========================
  function svgX() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  }

  function svgChevron() {
    return '<svg class="ldsm-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>';
  }

  function svgSearch() {
    return '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  function svgHome() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
  }

  function svgFolder() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  }

  function svgInfo() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  }

  function svgSync() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
  }

  // ========================= Styles =========================
  function addStyles() {
    const css = `
      .ldsm-body-lock { overflow: hidden !important; }
      .${STAR_CLASS} { position: relative; cursor: pointer; }
      .${STAR_CLASS} * { pointer-events: none; }
      .${STAR_CLASS} .ldsm-star-icon { width: 1em; height: 1em; transition: transform 200ms ease; }
      .${STAR_CLASS} .ldsm-star-icon path { fill: none; stroke: var(--primary-medium, #919191); stroke-width: 1.5; stroke-linejoin: round; transition: fill 200ms ease, stroke 200ms ease; }
      .${STAR_CLASS}:hover .ldsm-star-icon path { stroke: #eab308; fill: rgba(234, 179, 8, .12); }
      .${STAR_CLASS}.${STAR_ACTIVE_CLASS} .ldsm-star-icon path { fill: #eab308; stroke: #eab308; }
      .${STAR_CLASS}.${STAR_ACTIVE_CLASS}:hover .ldsm-star-icon path { fill: #ca8a04; stroke: #ca8a04; }
      .ldsm-star-topic-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; margin-left: 6px; vertical-align: middle; background: transparent; border: 0; border-radius: 4px; cursor: pointer; padding: 0; transition: background 150ms ease; }
      .ldsm-star-topic-btn:hover { background: rgba(234, 179, 8, .12); }
      .ldsm-star-topic-btn .ldsm-star-icon { width: 20px; height: 20px; }
      @keyframes ldsm-star-pop { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 70% { transform: scale(.9); } 100% { transform: scale(1); } }
      .ldsm-star-just-activated .ldsm-star-icon { animation: ldsm-star-pop 350ms cubic-bezier(.175,.885,.32,1.275); }

      .ldsm-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(16px); z-index: 999999; display: flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: 8px; background: #18181b; color: #fff; box-shadow: 0 10px 30px rgba(0,0,0,.22); font-size: 14px; font-weight: 500; opacity: 0; pointer-events: none; transition: opacity 220ms ease, transform 220ms ease; }
      .ldsm-toast-visible { opacity: 1; transform: translateX(-50%) translateY(0); }
      .ldsm-toast-icon { font-size: 16px; }

      .ldsm-picker { position: fixed; z-index: 999998; min-width: 220px; max-width: 270px; padding: 5px; border: 1px solid #e4e4e7; border-radius: 8px; background: #fff; color: #09090b; box-shadow: 0 12px 28px rgba(0,0,0,.15); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; }
      .ldsm-picker-header { display: flex; justify-content: space-between; padding: 6px 9px 3px; color: #71717a; font-size: 11px; font-weight: 600; }
      .ldsm-picker-search-wrap { padding: 4px 5px; }
      .ldsm-picker-search, .ldsm-picker-input { width: 100%; height: 29px; padding: 0 8px; border: 1px solid #e4e4e7; border-radius: 5px; background: #fff; color: #09090b; outline: none; font-size: 12px; }
      .ldsm-picker-search:focus, .ldsm-picker-input:focus { border-color: #a1a1aa; box-shadow: 0 0 0 2px rgba(0,0,0,.03); }
      .ldsm-picker-list { max-height: 220px; overflow-y: auto; padding: 2px 0; }
      .ldsm-picker-empty { padding: 12px 10px; text-align: center; color: #a1a1aa; font-size: 12px; }
      .ldsm-picker-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 9px; border: 0; background: transparent; border-radius: 5px; color: #09090b; cursor: pointer; text-align: left; }
      .ldsm-picker-item:hover, .ldsm-picker-item.active { background: #f4f4f5; }
      .ldsm-picker-item[draggable="true"], .ldsm-nav-item[draggable="true"], .ldsm-card[draggable="true"], .ldsm-post-row[draggable="true"] { cursor: grab; }
      .ldsm-picker-item[draggable="true"]:active, .ldsm-nav-item[draggable="true"]:active, .ldsm-card[draggable="true"]:active, .ldsm-post-row[draggable="true"]:active, .ldsm-drag-handle:active { cursor: grabbing; }
      .ldsm-dragging { opacity: .48; }
      .ldsm-drag-over { outline: 1px solid #93c5fd; background: #eff6ff !important; }
      .ldsm-drag-before { box-shadow: inset 0 2px 0 #2563eb; }
      .ldsm-drag-after { box-shadow: inset 0 -2px 0 #2563eb; }
      .ldsm-picker-icon { width: 18px; text-align: center; flex: 0 0 18px; }
      .ldsm-picker-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ldsm-picker-check { color: #16a34a; font-weight: 700; }
      .ldsm-picker-new { margin-top: 2px; border-top: 1px solid #f4f4f5; color: #71717a; }
      .ldsm-picker-input-row { display: flex; gap: 4px; padding: 5px; }
      .ldsm-picker-input-ok { flex: 0 0 30px; height: 29px; border: 0; border-radius: 5px; background: #18181b; color: #fff; cursor: pointer; }

      #ldsm-root, #ldsm-root * { box-sizing: border-box; }
      .ldsm-fab { position: fixed; right: 18px; bottom: 82px; z-index: 999990; width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #e4e4e7; border-radius: 999px; background: #fff; color: #ca8a04; box-shadow: 0 8px 24px rgba(0,0,0,.16); cursor: pointer; }
      .ldsm-fab[hidden] { display: none !important; }
      .ldsm-fab:hover { background: #fefce8; border-color: #fde68a; }
      .ldsm-fab-star { font-size: 22px; line-height: 1; }
      .ldsm-fab-count { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; display: none; align-items: center; justify-content: center; padding: 0 5px; border-radius: 999px; background: #18181b; color: #fff; font-size: 10px; font-weight: 700; }
      .ldsm-shade, .ldsm-subshade { position: fixed; inset: 0; background: rgba(0,0,0,.28); opacity: 0; pointer-events: none; transition: opacity 180ms ease; }
      .ldsm-shade { z-index: 999991; }
      .ldsm-subshade { z-index: 999995; background: rgba(0,0,0,.18); }
      .ldsm-shade.ldsm-open, .ldsm-subshade.open { opacity: 1; pointer-events: auto; }
      .ldsm-manager { position: fixed; top: 0; right: 0; z-index: 999992; width: min(980px, 96vw); height: 100vh; display: flex; background: #fff; color: #09090b; border-left: 1px solid #e4e4e7; box-shadow: -8px 0 28px rgba(0,0,0,.12); transform: translateX(104%); transition: transform 220ms cubic-bezier(.16,1,.3,1); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; }
      .ldsm-manager.ldsm-open { transform: translateX(0); }
      .ldsm-sidebar { width: 224px; flex: 0 0 224px; display: flex; flex-direction: column; border-right: 1px solid #e4e4e7; background: #fafafa; min-height: 0; }
      .ldsm-sidebar-head { height: 49px; display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid #e4e4e7; }
      .ldsm-logo { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; background: #fefce8; color: #ca8a04; font-size: 14px; }
      .ldsm-logo-text { font-weight: 650; font-size: 14px; flex: 1; }
      .ldsm-nav { flex: 1; min-height: 0; overflow-y: auto; padding: 7px; display: flex; flex-direction: column; gap: 2px; }
      .ldsm-nav-item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 6px 9px; border: 0; border-radius: 6px; background: transparent; color: #71717a; cursor: pointer; text-align: left; font-size: 13px; font-weight: 500; }
      .ldsm-nav-item:hover, .ldsm-nav-item.active { background: #f4f4f5; color: #09090b; }
      .ldsm-nav-item.ldsm-drag-over { color: #1d4ed8; }
      .ldsm-nav-item svg { width: 16px; height: 16px; flex: 0 0 16px; }
      .ldsm-nav-icon { width: 16px; text-align: center; }
      .ldsm-nav-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ldsm-nav-count { margin-left: auto; min-width: 18px; padding: 0 5px; border-radius: 999px; background: #e4e4e7; color: #71717a; text-align: center; font-size: 10px; font-weight: 700; }
      .ldsm-nav-edit { opacity: 0; padding: 0 4px; border-radius: 4px; color: #a1a1aa; }
      .ldsm-nav-item:hover .ldsm-nav-edit { opacity: 1; }
      .ldsm-nav-edit:hover { background: #e4e4e7; color: #09090b; }
      .ldsm-sidebar-mid { padding: 9px 10px; border-top: 1px solid #e4e4e7; display: flex; flex-direction: column; gap: 6px; }
      .ldsm-sidebar-toggle { justify-content: center; padding-top: 2px; }
      .ldsm-sidebar-foot { padding: 10px; display: flex; gap: 6px; border-top: 1px solid #e4e4e7; flex-wrap: wrap; }
      .ldsm-total { font-size: 11px; color: #a1a1aa; text-align: center; }

      .ldsm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: #fff; }
      .ldsm-toolbar { min-height: 49px; display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid #e4e4e7; }
      .ldsm-search { position: relative; flex: 1; max-width: 390px; min-width: 180px; }
      .ldsm-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; color: #a1a1aa; pointer-events: none; }
      .ldsm-search input, .ldsm-input, .ldsm-select, .ldsm-textarea { width: 100%; border: 1px solid #e4e4e7; border-radius: 6px; background: #fff; color: #09090b; outline: none; font: inherit; }
      .ldsm-search input { height: 34px; padding: 0 10px 0 32px; font-size: 13px; }
      .ldsm-input, .ldsm-select { height: 34px; padding: 0 10px; font-size: 13px; }
      .ldsm-textarea { min-height: 78px; padding: 8px 10px; resize: vertical; font-size: 13px; }
      .ldsm-search input:focus, .ldsm-input:focus, .ldsm-select:focus, .ldsm-textarea:focus { border-color: #a1a1aa; box-shadow: 0 0 0 2px rgba(0,0,0,.03); }
      .ldsm-toolbar-right { display: flex; align-items: center; gap: 9px; margin-left: auto; }
      .ldsm-content { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; background: #fff; }
      .ldsm-content::-webkit-scrollbar, .ldsm-nav::-webkit-scrollbar, .ldsm-panel-body::-webkit-scrollbar { width: 6px; }
      .ldsm-content::-webkit-scrollbar-thumb, .ldsm-nav::-webkit-scrollbar-thumb, .ldsm-panel-body::-webkit-scrollbar-thumb { background: #d4d4d8; border-radius: 999px; }

      .ldsm-btn { min-height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 0 10px; border: 1px solid #e4e4e7; border-radius: 6px; background: #fff; color: #09090b; cursor: pointer; font-size: 12px; font-weight: 550; white-space: nowrap; }
      .ldsm-btn:hover { background: #f4f4f5; }
      .ldsm-btn:disabled { opacity: .6; cursor: not-allowed; }
      .ldsm-btn svg { width: 14px; height: 14px; }
      .ldsm-btn-full { width: 100%; }
      .ldsm-btn-primary { background: #18181b; color: #fff; border-color: #18181b; }
      .ldsm-btn-primary:hover { background: #27272a; }
      .ldsm-btn-danger { color: #dc2626; border-color: #fecaca; }
      .ldsm-btn-danger:hover { background: #fef2f2; color: #b91c1c; }
      .ldsm-icon-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: #71717a; cursor: pointer; flex: 0 0 28px; }
      .ldsm-icon-btn:hover { background: #f4f4f5; color: #09090b; }
      .ldsm-icon-btn svg { width: 15px; height: 15px; pointer-events: none; }
      .ldsm-danger-hover:hover { background: #fef2f2; color: #dc2626; }
      .ldsm-mobile-close { display: none; margin-left: auto; }
      .ldsm-sync-button.syncing svg { animation: ldsm-spin 1s linear infinite; }
      @keyframes ldsm-spin { to { transform: rotate(360deg); } }

      .ldsm-check-label { display: inline-flex; align-items: center; gap: 5px; color: #71717a; font-size: 12px; white-space: nowrap; user-select: none; }
      .ldsm-check-label input { width: 14px; height: 14px; accent-color: #18181b; }
      .ldsm-batch-bar { display: none; align-items: center; gap: 7px; padding: 4px 8px; border: 1px solid #fecaca; border-radius: 6px; background: #fef2f2; color: #dc2626; font-size: 12px; }
      .ldsm-batch-bar.visible { display: flex; }

      .ldsm-card { border: 1px solid #e4e4e7; border-radius: 8px; overflow: hidden; margin-bottom: 8px; background: #fff; }
      .ldsm-card-head { display: flex; align-items: center; gap: 10px; padding: 10px 13px; background: #fafafa; cursor: pointer; }
      .ldsm-card-head:hover { background: #f4f4f5; }
      .ldsm-drag-handle { width: 18px; height: 28px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 18px; border-radius: 5px; color: #a1a1aa; cursor: grab; font-size: 13px; font-weight: 700; line-height: 1; user-select: none; }
      .ldsm-drag-handle:hover { background: #e4e4e7; color: #52525b; }
      .ldsm-chevron { width: 14px; height: 14px; flex: 0 0 14px; color: #a1a1aa; transition: transform 150ms ease; }
      .ldsm-card.open .ldsm-chevron { transform: rotate(90deg); }
      .ldsm-card-check { width: 16px; height: 16px; accent-color: #18181b; flex: 0 0 16px; }
      .ldsm-card-star { color: #eab308; font-size: 15px; flex: 0 0 15px; line-height: 1; }
      .ldsm-card-body { flex: 1; min-width: 0; }
      .ldsm-card-title { font-size: 13px; font-weight: 600; color: #09090b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ldsm-card-title a { color: inherit; text-decoration: none; }
      .ldsm-card-title a:visited { color: inherit; }
      .ldsm-card-title a:hover { color: #2563eb; text-decoration: underline; }
      .ldsm-card-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
      .ldsm-tag { display: inline-flex; align-items: center; height: 18px; padding: 0 5px; border-radius: 4px; background: #f4f4f5; color: #71717a; font-size: 10px; font-weight: 600; }
      .ldsm-tag-note { background: #fefce8; color: #a16207; }
      .ldsm-comment-count { background: #eff6ff; color: #2563eb; }
      .ldsm-time { color: #a1a1aa; font-size: 11px; }
      .ldsm-card-actions, .ldsm-post-actions { display: flex; gap: 2px; flex: 0 0 auto; }
      .ldsm-card-posts { display: none; }
      .ldsm-card.open .ldsm-card-posts { display: block; }
      .ldsm-post-row { display: flex; align-items: flex-start; gap: 8px; padding: 9px 13px 9px 40px; border-top: 1px solid #f4f4f5; cursor: pointer; }
      .ldsm-post-row:hover { background: #fafafa; }
      .ldsm-post-num { min-width: 30px; color: #a1a1aa; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .ldsm-post-info { flex: 1; min-width: 0; }
      .ldsm-post-author { color: #09090b; font-size: 12px; font-weight: 650; }
      .ldsm-post-excerpt { margin-top: 2px; color: #71717a; font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .ldsm-post-note { margin-top: 4px; padding: 4px 6px; border-radius: 4px; background: #fefce8; color: #a16207; font-size: 11px; line-height: 1.35; }
      .ldsm-post-time { margin-top: 3px; color: #a1a1aa; font-size: 11px; }
      .ldsm-post-actions { opacity: 0; transition: opacity 90ms ease; }
      .ldsm-post-row:hover .ldsm-post-actions { opacity: 1; }

      .ldsm-empty { min-height: 420px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #a1a1aa; }
      .ldsm-empty .ldsm-star-icon { width: 44px; height: 44px; margin-bottom: 10px; }
      .ldsm-empty .ldsm-star-icon path { fill: none; stroke: #d4d4d8; stroke-width: 1.2; }
      .ldsm-empty h3 { margin: 0; font-size: 14px; font-weight: 600; color: #71717a; }
      .ldsm-empty p { margin: 5px 0 0; font-size: 13px; color: #a1a1aa; }

      .ldsm-panel { position: absolute; top: 0; right: 0; z-index: 999996; width: 410px; max-width: 92vw; height: 100%; display: flex; flex-direction: column; background: #fff; border-left: 1px solid #e4e4e7; box-shadow: -6px 0 18px rgba(0,0,0,.08); transform: translateX(104%); transition: transform 200ms cubic-bezier(.16,1,.3,1); }
      .ldsm-panel.open { transform: translateX(0); }
      .ldsm-panel-head { height: 50px; display: flex; align-items: center; justify-content: space-between; padding: 0 15px; border-bottom: 1px solid #e4e4e7; }
      .ldsm-panel-head h2 { margin: 0; font-size: 14px; font-weight: 650; color: #09090b; }
      .ldsm-panel-body { flex: 1; overflow-y: auto; padding: 16px; }
      .ldsm-field, .ldsm-sync-field { margin-bottom: 14px; }
      .ldsm-field label, .ldsm-sync-field label { display: block; margin-bottom: 5px; color: #71717a; font-size: 12px; font-weight: 600; }
      .ldsm-field-value, .ldsm-sync-value { color: #09090b; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
      .ldsm-field-value a, .ldsm-sync-value a, .ldsm-help a { color: #2563eb; text-decoration: none; }
      .ldsm-field-value a:hover, .ldsm-sync-value a:hover, .ldsm-help a:hover { text-decoration: underline; }
      .ldsm-action-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .ldsm-icon-grid { display: flex; flex-wrap: wrap; gap: 5px; }
      .ldsm-icon-opt { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #e4e4e7; border-radius: 6px; background: #fff; cursor: pointer; font-size: 16px; }
      .ldsm-icon-opt:hover, .ldsm-icon-opt.active { background: #f4f4f5; border-color: #18181b; box-shadow: 0 0 0 1px #18181b; }
      .ldsm-tag-editor { display: flex; flex-wrap: wrap; gap: 5px; min-height: 36px; padding: 6px 8px; border: 1px solid #e4e4e7; border-radius: 6px; background: #fff; }
      .ldsm-tag-editor:focus-within { border-color: #a1a1aa; box-shadow: 0 0 0 2px rgba(0,0,0,.03); }
      .ldsm-tag-editor input { flex: 1; min-width: 90px; border: 0; outline: 0; font: inherit; font-size: 12px; }
      .ldsm-tag-pill { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px; border: 1px solid #e4e4e7; border-radius: 5px; background: #f4f4f5; color: #09090b; font-size: 11px; }
      .ldsm-tag-pill button { border: 0; background: transparent; color: #a1a1aa; cursor: pointer; padding: 0; line-height: 1; }
      .ldsm-tag-pill button:hover { color: #dc2626; }
      .ldsm-move-list { display: flex; flex-direction: column; gap: 5px; }
      .ldsm-move-item { min-height: 36px; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #e4e4e7; border-radius: 6px; background: #fff; color: #09090b; cursor: pointer; font-size: 13px; }
      .ldsm-move-item:hover, .ldsm-move-item.active { background: #f4f4f5; border-color: #18181b; }
      .ldsm-move-check { margin-left: auto; color: #16a34a; font-weight: 800; }
      .ldsm-help { margin-top: 7px; color: #71717a; font-size: 12px; line-height: 1.45; }
      .ldsm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .ldsm-sync-dot { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #d4d4d8; vertical-align: middle; }
      .ldsm-sync-dot.connected, .ldsm-sync-dot.synced { background: #22c55e; }
      .ldsm-sync-dot.syncing { background: #eab308; }
      .ldsm-sync-dot.error { background: #ef4444; }
      .ldsm-sync-toggle { margin: 8px 0 4px; color: #09090b; }
      .ldsm-sync-error { margin-top: 8px; color: #dc2626; font-size: 12px; line-height: 1.45; }
      .ldsm-sync-ok { margin-top: 8px; color: #16a34a; font-size: 12px; }

      @media (max-width: 760px) {
        .ldsm-manager { width: 100vw; }
        .ldsm-sidebar { position: absolute; z-index: 999994; width: 210px; height: 100%; }
        .ldsm-main { margin-left: 210px; }
        .ldsm-toolbar { flex-wrap: wrap; align-items: stretch; }
        .ldsm-search { max-width: none; width: 100%; flex: 1 1 100%; }
        .ldsm-toolbar-right { width: 100%; justify-content: flex-end; flex-wrap: wrap; }
        .ldsm-card-head { align-items: flex-start; }
        .ldsm-card-actions { flex-direction: column; }
        .ldsm-post-row { padding-left: 18px; }
        .ldsm-post-actions { opacity: 1; }
      }

      @media (max-width: 560px) {
        .ldsm-sidebar { display: none; }
        .ldsm-main { margin-left: 0; }
        .ldsm-mobile-close { display: inline-flex; }
        .ldsm-fab { right: 14px; bottom: 74px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .ldsm-manager, .ldsm-panel, .ldsm-shade, .ldsm-subshade, .ldsm-toast, .${STAR_CLASS} .ldsm-star-icon, .${STAR_CLASS} .ldsm-star-icon path { transition-duration: 0ms !important; animation-duration: 0ms !important; }
      }
    `;

    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function registerMenuCommands() {
    if (menuCommandsRegistered || typeof GM_registerMenuCommand !== 'function') return;
    menuCommandsRegistered = true;
    GM_registerMenuCommand('打开 LinuxDo Star 收藏管理', () => {
      if (!managerReady) {
        addStyles();
        ensureManager();
      }
      openManager();
    });
    GM_registerMenuCommand('立即同步 LinuxDo Star', async () => {
      const result = await SyncManager.sync();
      showToast(result.message, result.ok ? '⭐' : '⚠');
    });
  }

  // ========================= Init =========================
  function init() {
    registerMenuCommands();
    addStyles();
    ensureManager();
    refreshFabCount();
    watchRouteChanges();
    if (isTopicPage()) waitAndInject();
  }

  registerMenuCommands();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
