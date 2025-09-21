window.addEventListener('DOMContentLoaded', () => {
    console.log("[DEBUG] DOM loaded, checking for channelButtons:", document.getElementById("channelButtons"));
  });
  // ---------- helpers ----------
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e?.data?.type === "PUSH_RECEIVED") {
        console.log("[PAGE] push message from SW:", e.data.payload);
        statusLine("푸시 도착 (SW에서 수신)", "success");
      }
    });
  }

  function getFirstUrl(m){
    return m?.image_url || m?.file_url || m?.audio_url || m?.url || m?.href || m?.src || null;
  }

  function isImageUrl(u){
    if (!u) return false;
    if (/^data:image\//i.test(u)) return true;
    return /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(u.split('?')[0]);
  }

  function fileNameFromUrl(u){
    try{
      const abs = new URL(u, location.origin);
      const last = abs.pathname.split('/').pop() || "파일";
      return decodeURIComponent(last);
    } catch(_){ return "파일"; }
  }

  const $ = (id) => document.getElementById(id);
  
  function statusLine(msg, kind = "info") {
    const el = $("status");
    if (!el) return;
    el.textContent = msg;
    el.className =
      "text-xs " +
      (kind === "success"
        ? "text-green-600"
        : kind === "error"
        ? "text-red-600"
        : "text-gray-500");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  
  function safeUUID() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    if (crypto?.getRandomValues) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
      return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
    }
    const rnd = () =>
      (Math.random() * 0xffffffff >>> 0).toString(16).padStart(8, "0");
    return `${rnd().slice(0, 8)}-${rnd().slice(0, 4)}-4${rnd().slice(0, 3)}-${(
      8 + Math.floor(Math.random() * 4)
    ).toString(16)}${rnd().slice(0, 3)}-${rnd()}${rnd()}`;
  }

  function b64urlToUint8Array(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isMobile() {
    return (
      /Android/i.test(navigator.userAgent) ||
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0
    );
  }

  function colorByAlias(alias){
    switch(alias){
      case "아빠": return "#2563eb";  // blue-600
      case "엄마": return "#10b981";  // emerald-500
      case "첫째": return "#f59e0b";  // amber-500
      case "둘째": return "#ef4444";  // red-500
      default:     return "#6b7280";  // gray-500
    }
  }

  function initialsFor(alias){
    if (!alias) return "？";
    return String(alias).slice(0,2);
  }

  function makeAvatar(alias){
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar";
    btn.style.background = colorByAlias(alias);
    btn.textContent = initialsFor(alias);
    // DM on click (ignore if it's me)
    btn.addEventListener("click", async (e)=>{
      e.stopPropagation();
      if (alias === userAlias) return;
      const ok = await showConfirm(`${alias} 님과 1:1 대화를 시작할까요?`, "시작", "bg-blue-600 hover:bg-blue-700");
      if (!ok) return;
      await startDM(alias);
    });
    return btn;
  }

  function addPendingBubble({ kind, label }) {
    const tempId = `pending-${safeUUID()}`;
    const li = document.createElement("li");
    li.id = tempId;
    li.className = "flex justify-end mb-1";

    const row = document.createElement("div");
    row.className = "flex items-end gap-2";

    const stack = document.createElement("div");
    stack.className = "flex flex-col items-end gap-1";
    
    const bubble = document.createElement("div");
    bubble.className = "bubble me pending";

    const strong = document.createElement("strong");
    strong.textContent = label || (kind === "voice" ? "음성 업로드 중…" : "업로드 중…");
    strong.style.fontWeight = "600";

    const prog = document.createElement("span");
    prog.className = "progress";
    prog.textContent = "0%";

    const spin = document.createElement("span");
    spin.className = "spinner";

    bubble.appendChild(strong);
    bubble.appendChild(prog);
    bubble.appendChild(spin);

    const meta = document.createElement("div");
    meta.className = "text-[10px] text-gray-400 px-1";
    meta.textContent = "전송 중…";

    stack.appendChild(bubble);
    stack.appendChild(meta);

    // Add avatar to optimistic bubble
    const avatar = makeAvatar(userAlias);
    avatar.style.order = "2";

    row.appendChild(stack);
    row.appendChild(avatar);
    li.appendChild(row);

    chatList.appendChild(li);
    scrollToBottom(true);

    return {
      id: tempId,
      setProgress(p) { prog.textContent = `${Math.min(99, Math.max(0, p|0))}%`; },
      fail(msg) {
        const pendingLi = $(tempId);
        if (!pendingLi) return;
        const bubble = pendingLi.querySelector('.bubble');
        if (!bubble) return;
        bubble.innerHTML = `<strong>${msg || "업로드 실패"}</strong>`;
        bubble.classList.remove("pending");
        bubble.style.background = "#fca5a5"; // soft red
        const meta = pendingLi.querySelector(".text-\\[10px\\]");
        if (meta) meta.textContent = "실패";
      },
      remove() {
        const pendingLi = $(tempId);
        if (pendingLi) pendingLi.remove();
      }
    };
  }
  
  // ---------- Custom Confirm Modal ----------
  const confirmModal = $("confirmModal");
  const confirmModalText = $("confirmModalText");
  const confirmModalOk = $("confirmModalOk");
  const confirmModalCancel = $("confirmModalCancel");
  let confirmResolve = null;

  function showConfirm(text, okLabel = "확인", okClass = "bg-blue-600 hover:bg-blue-700") {
    return new Promise(resolve => {
      confirmResolve = resolve;
      confirmModalText.textContent = text;
      confirmModalOk.textContent = okLabel;
      confirmModalOk.className = `w-full px-4 py-2.5 rounded-xl text-white font-semibold ${okClass}`;
      confirmModal.style.display = "flex";
    });
  }

  if (confirmModal) {
    const closeConfirm = (value) => {
      if (confirmResolve) confirmResolve(value);
      confirmModal.style.display = "none";
      confirmResolve = null;
    }
    confirmModalOk.addEventListener("click", () => closeConfirm(true));
    confirmModalCancel.addEventListener("click", () => closeConfirm(false));
  }

  // ---------- refs / state ----------
  const chatList = $("chatList");
  const bottomSpacer = $("bottomSpacer");
  const composer = $("composer");
  const composerForm = $("composerForm");
  const sendTextBtn = $("sendTextBtn");
  const textInput = $("textInput");
  const pttBtn = $("pttBtn");
  const addBtn = $("addBtn");
  const fileInput = $("fileInput");
  const channelButtons = $("channelButtons");

  let userAlias = localStorage.getItem("userAlias") || null;
  let userId = localStorage.getItem("userId") || safeUUID();
  localStorage.setItem("userId", userId);
  const userIdDisplay = $("userIdDisplay");
  if (userIdDisplay) userIdDisplay.textContent = userId;

  let currentChannel = "public-1"; // default
  let evtSrc = null,
    esBackoff = 1000;
  let isAuthed = false;
  let authCheckInFlight = null;
  let messageIdSet = new Set(); // Track rendered message IDs to prevent duplicates

  const loginModal = $("loginModal");
  const loginId = $("loginId");
  const loginPw = $("loginPw");
  const loginBtn = $("loginBtn");
  const loginErr = $("loginErr");

  // ---------- windowed history (3-day chunks) ----------
  const WINDOW_DAYS = 3;
  let windowBefore = Math.floor(Date.now() / 1000);
  let hasMore = true;
  let lastRenderedDayKey = null;
  let oldestTs = null;

  function dayKeyFromTs(ts) {
    const d = new Date((ts || Date.now()) * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function makeDayHeader(key) {
    const el = document.createElement("div");
    el.className = "day-header";
    const [y, m, dd] = key.split("-");
    const dt = new Date(`${y}-${m}-${dd}T00:00:00`);
    el.textContent = dt.toLocaleDateString([], {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    return el;
  }

  // ---------- auth helpers ----------
  async function checkSessionAndConnect() {
    try {
      const r = await fetch("/whoami", {
        credentials: "include",
        cache: "no-store",
      });
      const j = await r.json();
      if (j.user) {
        isAuthed = true;
        userAlias = j.user;
        ensureMetaStream(userAlias);
        localStorage.setItem("userAlias", userAlias);
        if (loginModal) loginModal.style.display = "none";
        console.log("[DEBUG] Calling refreshChannels");
        initPushNotifications();   
        await refreshChannels();
        statusLine("연결 확인 중…", "info");
        ensureEventSource(currentChannel);
        if (!chatList.childElementCount) {
          messageIdSet.clear(); // Reset tracking
          await loadHistory(currentChannel, Math.floor(Date.now() / 1000));
        }
        scrollToBottom(false);
                         

        return true;
      } else {
        isAuthed = false;
        if (loginModal) loginModal.style.display = "flex";
        statusLine("로그인이 필요합니다", "info");
        if (evtSrc) {
          try {
            evtSrc.close();
          } catch {}
          evtSrc = null;
        }
        return false;
      }
    } catch (e) {
      console.warn("[auth] /whoami failed:", e);
      return isAuthed;
    }
  }

  async function requireLogin() {
    if (isAuthed) return true;
    if (!authCheckInFlight)
      authCheckInFlight = checkSessionAndConnect().finally(
        () => (authCheckInFlight = null)
      );
    const ok = await authCheckInFlight;
    if (!ok) {
      if (loginModal) loginModal.style.display = "flex";
      statusLine("로그인이 필요합니다", "error");
    }
    return !!ok;
  }

  async function doLogin() {
    const id = (loginId?.value || "").trim();
    const password = loginPw?.value || "";
    if (!id || !password) return;
    try {
      const r = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, password }),
        credentials: "include",
      });
      if (!r.ok) throw new Error("bad");
      await r.json();
      if (loginErr) loginErr.classList.add("hidden");
      statusLine("로그인 성공", "success");
      await checkSessionAndConnect();
    } catch (e) {
      console.error("[login] failed", e);
      if (loginErr) loginErr.classList.remove("hidden");
      statusLine("로그인 실패", "error");
    }
  }

  if (loginBtn) loginBtn.addEventListener("click", doLogin);
  if (loginPw)
    loginPw.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });

  // Run on startup and on resume
  window.addEventListener("load", () => {
    setTimeout(() => checkSessionAndConnect(), 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkSessionAndConnect();
  });
  window.addEventListener("pageshow", () => {
    checkSessionAndConnect();
  });

  // ---------- layout: keyboard + composer ----------
  function setComposerHeight() {
    if (!composer || !bottomSpacer) return;
    const h = composer.offsetHeight + 8;
    document.documentElement.style.setProperty("--composer-h", h + "px");
    const kb =
      parseInt(
        getComputedStyle(document.documentElement).getPropertyValue("--kb")
      ) || 0;
    bottomSpacer.style.height = h + kb + "px";
  }

  function applyKeyboardInset(overlapPx, forceHalf = false) {
    const base = Math.max(0, Math.floor(overlapPx || 0));
    const minLift =
      forceHalf && isMobile() ? Math.round(window.innerHeight * 0.45) : 0;
    const kb = Math.max(base, minLift);
    document.documentElement.style.setProperty("--kb", kb + "px");
    setComposerHeight();
  }

  function bindVisualViewport() {
    const vv = window.visualViewport;
    if (!vv || !isMobile()) return;
    const onVV = () => {
      const overlap1 = window.innerHeight - (vv.height + vv.offsetTop);
      const overlap2 = window.innerHeight - vv.height;
      const overlap = Math.max(0, Math.round(Math.max(overlap1, overlap2)));
      const forceHalf = document.activeElement === textInput;
      applyKeyboardInset(overlap, forceHalf);
      if (forceHalf)
        setTimeout(() => {
          composer?.scrollIntoView({ block: "end" });
          scrollToBottom(true);
        }, 30);
    };
    vv.addEventListener("resize", onVV);
    vv.addEventListener("scroll", onVV);
    window.addEventListener("orientationchange", () => setTimeout(onVV, 200));
    window.addEventListener("resize", () => setTimeout(onVV, 50));
    onVV();
  }
  bindVisualViewport();

  if (isMobile() && textInput) {
    textInput.addEventListener("focus", () => {
      const vv = window.visualViewport;
      if (vv) {
        const overlap = Math.max(
          0,
          Math.round(
            Math.max(
              window.innerHeight - (vv.height + vv.offsetTop),
              window.innerHeight - vv.height
            )
          )
        );
        applyKeyboardInset(overlap, true);
      } else {
        applyKeyboardInset(320, true);
      }
      setTimeout(() => {
        composer?.scrollIntoView({ block: "end" });
        scrollToBottom(true);
      }, 50);
    });
    textInput.addEventListener("blur", () => {
      setTimeout(() => {
        applyKeyboardInset(0, false);
        setComposerHeight();
      }, 100);
    });
  }

  function scrollToBottom(smooth = true) {
    const wrap = document.querySelector(".scrollwrap");
    if (!wrap) return;
    const target = wrap.scrollHeight - wrap.clientHeight;
    if (smooth) {
      try {
        wrap.scrollTo({ top: target, behavior: "smooth" });
      } catch {
        wrap.scrollTop = target;
      }
    } else {
      wrap.scrollTop = target;
    }
  }
  
  function isNearBottom() {
    const wrap = document.querySelector(".scrollwrap");
    if (!wrap) return true;
    return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120;
  }

  new ResizeObserver(() => setComposerHeight()).observe(composer);
  window.addEventListener("load", () =>
    setTimeout(() => {
      setComposerHeight();
      scrollToBottom(false);
    }, 50)
  );

  // ---------- push notifications ----------
  // ADD THESE NEW FUNCTIONS

async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log("Push notifications are not supported.");
    return;
  }

  // If permission is 'default', the user has not been asked yet.
  if (Notification.permission === 'default') {
    console.log("Requesting notification permission for the first time.");
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      await subscribeUserToPush();
    }
  } 
  // If permission is already 'granted', make sure we have a subscription.
  else if (Notification.permission === 'granted') {
    console.log("Permission already granted. Ensuring user is subscribed.");
    await subscribeUserToPush();
  }
}

async function subscribeUserToPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    if (sub === null) {
      // No subscription exists, create a new one.
      const resp = await fetch("/vapid-public-key");
      const data = await resp.json();
      const publicKey = data.publicKey;

      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToUint8Array(publicKey),
      });
    }

    // Send the subscription to the server.
    await fetch("/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // Important for sending session cookie
      body: JSON.stringify({
        subscription: sub,
        alias: userAlias || "unknown",
        user_id: userId,
      }),
    });
    console.log("Push subscription synced with server.");

  } catch (err) {
    console.error("Failed to subscribe to push notifications:", err);
  }
}

  // ---------- history & SSE (3-day windows) ----------
  async function loadHistory(channel, beforeEpoch = Math.floor(Date.now() / 1000)) {
    try {
      const r = await fetch(
        `/api/messages?channel=${encodeURIComponent(
          channel
        )}&days=${WINDOW_DAYS}&before=${beforeEpoch}`,
        { credentials: "include" }
      );
      if (!r.ok) throw new Error(r.statusText);
      const j = await r.json();
      renderHistoryWindow(j.messages || [], /*replace=*/ true);
      hasMore = !!j.has_more;
      windowBefore = beforeEpoch;
    } catch (e) {
      console.error("[history]", e);
      statusLine("기록 불러오기 실패", "error");
    }
  }
  
  let metaSrc = null, metaBackoff = 1000;

  function ensureMetaStream(alias){
    if (!alias) return;
    const key = `meta:${alias}`;
    if (metaSrc && (metaSrc.readyState===0 || metaSrc.readyState===1)) return;
    if (metaSrc){ try{ metaSrc.close(); }catch{} metaSrc = null; }
    const url = `/stream/meta/${encodeURIComponent(alias)}`;
    metaSrc = new EventSource(url, { withCredentials: true });
    metaSrc.addEventListener("hello", ()=>{ metaBackoff=1000; });
    metaSrc.addEventListener("channel", async (e)=>{
      try { await refreshChannels(); } catch {}
    });
    metaSrc.addEventListener("ping", ()=>{});
    metaSrc.onerror = ()=>{
      try{ metaSrc.close(); }catch{} metaSrc=null;
      const d = Math.min(metaBackoff, 30000);
      setTimeout(()=> ensureMetaStream(alias), d);
      metaBackoff *= 2;
    };
  }
  
  async function loadOlder() {
    if (!hasMore) return;
    const before = (oldestTs || windowBefore) - 1;
    try {
      const r = await fetch(
        `/api/messages?channel=${encodeURIComponent(
          currentChannel
        )}&days=${WINDOW_DAYS}&before=${before}`,
        { credentials: "include" }
      );
      if (!r.ok) throw new Error(r.statusText);
      const j = await r.json();
      prependHistoryWindow(j.messages || []);
      hasMore = !!j.has_more;
      windowBefore = before;
    } catch (e) {
      console.error("[older]", e);
    }
  }

  // listen near top
  const scrollwrap = document.querySelector(".scrollwrap");
  let loadingOlder = false;
  if (scrollwrap) {
    scrollwrap.addEventListener("scroll", async () => {
      if (scrollwrap.scrollTop < 80 && !loadingOlder && hasMore) {
        loadingOlder = true;
        const prevHeight = scrollwrap.scrollHeight;
        await loadOlder();
        const diff = scrollwrap.scrollHeight - prevHeight;
        scrollwrap.scrollTop = scrollwrap.scrollTop + diff;
        loadingOlder = false;
      }
    });
  }

  function renderHistoryWindow(msgs, replace) {
    if (replace) {
      chatList.innerHTML = "";
      lastRenderedDayKey = null;
      oldestTs = null;
      messageIdSet.clear();
    }
    msgs.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    for (const m of msgs) appendMsg(m, false);
    scrollToBottom(false);
    setComposerHeight();
  }

  function prependHistoryWindow(msgs) {
    if (!msgs.length) return;
    msgs.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

    const toInsert = [];
    let prevKey = null;
    let localOldest = oldestTs;

    for (const m of msgs) {
      if (messageIdSet.has(m.id)) continue; // Skip duplicates
      const key = dayKeyFromTs(m.created_at || Math.floor(Date.now() / 1000));
      if (prevKey !== key) {
        toInsert.push({ type: "header", key });
        prevKey = key;
      }
      toInsert.push({ type: "msg", msg: m });
      if (!localOldest || (m.created_at || Infinity) < localOldest)
        localOldest = m.created_at;
    }

    for (const item of toInsert.reverse()) {
      if (item.type === "header") {
        const li = document.createElement("li");
        li.appendChild(makeDayHeader(item.key));
        chatList.insertBefore(li, chatList.firstChild);
      } else {
        const li = buildMsgNode(item.msg);
        chatList.insertBefore(li, chatList.firstChild);
        messageIdSet.add(item.msg.id);
      }
    }

    oldestTs = localOldest || oldestTs;
  }

  // ---------- SSE ----------
  function ensureEventSource(channel) {
    if (evtSrc && (evtSrc.readyState === 0 || evtSrc.readyState === 1)) return;
    if (evtSrc) {
      try {
        evtSrc.close();
      } catch {}
      evtSrc = null;
    }
    const url = `/stream/${encodeURIComponent(channel)}`;
    evtSrc = new EventSource(url, { withCredentials: true });

    evtSrc.addEventListener("hello", () => {
      esBackoff = 1000;
      statusLine("연결됨", "success");
    });
    evtSrc.addEventListener("ping", () => {});
    evtSrc.addEventListener("message", (e) => {
      const wasNearBottom = isNearBottom();
      esBackoff = 1000;
      const msg = JSON.parse(e.data);
      
      // Prevent duplicate messages
      if (msg.id && messageIdSet.has(msg.id)) return;
      
      appendMsg(msg, wasNearBottom || (msg.user_id && msg.user_id === userId));
      
      // Auto-play voice messages from others
      if (msg.type === "voice" && msg.user_id !== userId && msg.audio_url) {
        const a = new Audio(msg.audio_url);
        a.play().catch(() => {});
      }
    });

    evtSrc.addEventListener("delete", (e) => {
      try {
        const { id } = JSON.parse(e.data);
        if (id != null) removeMsgFromDOM(id);
      } catch {}
    });

    evtSrc.onerror = () => {
      try {
        evtSrc.close();
      } catch {}
      evtSrc = null;
      const d = Math.min(esBackoff, 30000);
      setTimeout(() => ensureEventSource(channel), d);
      esBackoff *= 2;
    };
  }
  
  function connectStream(channel) {
    currentChannel = channel;
    ensureEventSource(channel);
  }

  // ---------- render ----------
  function buildMsgNode(msg) {
    const isMe = msg.user_id && msg.user_id === userId;

    const li = document.createElement("li");
    li.dataset.msgId = String(msg.id || "");
    li.className = "flex " + (isMe ? "justify-end" : "justify-start") + " mb-1";

    const row = document.createElement("div");
    row.className = "flex items-end gap-2";

    const avatar = makeAvatar(msg.alias || "");
    if (isMe) avatar.style.order = "2";

    const stack = document.createElement("div");
    stack.className = "flex flex-col items-" + (isMe ? "end" : "start") + " gap-1";
    if (isMe) stack.style.order = "1";

    const bubble = document.createElement("div");
    bubble.className = "bubble " + (isMe ? "me" : "other");

    if (msg.type === "voice" && msg.audio_url) {
      bubble.textContent = (isMe ? "나" : msg.alias) + "의 음성 메시지";
      const btn = document.createElement("button");
      btn.textContent = " ▶︎ 듣기 ";
      btn.className =
        "ml-2 inline-flex items-center justify-center w-40 h-7 rounded-full bg-black/10 text-black/80 hover:bg-black/20";
      btn.onclick = () => new Audio(msg.audio_url).play();
      bubble.appendChild(btn);
    } else {
      const url = getFirstUrl(msg);
      if (url && (msg.type === "image" || isImageUrl(url))) {
        const img = document.createElement("img");
        img.src = url; 
        img.alt = "이미지";
        img.style.maxWidth = "260px"; 
        img.style.borderRadius = "12px";
        img.loading = "lazy";
        bubble.appendChild(img);
      } else if (url && (msg.type === "file" || msg.type === "document" || msg.type === "attachment")) {
        const name = (msg.file_name && String(msg.file_name).trim()) || fileNameFromUrl(url);
        const a = document.createElement("a");
        a.href = url; 
        a.textContent = name; 
        a.title = name;
        a.className = "file-link"; 
        a.target = "_blank";
        a.dataset.noLongpress = "1";
        bubble.appendChild(a);
      } else {
        const t = msg.text || "";
        bubble.textContent = t;
        if (visibleLen(t) <= 12) bubble.classList.add("nowrap");
      }
    }

    // only my own message gets delete long-press
    if (isMe) attachDeleteLongPress(bubble, msg);

    const meta = document.createElement("div");
    meta.className = "text-[10px] text-gray-400 px-1";
    const when = msg.created_at ? new Date(msg.created_at * 1000) : new Date();
    meta.textContent =
      `${isMe ? "나" : msg.alias || ""} • ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    stack.appendChild(bubble);
    stack.appendChild(meta);

    if (isMe) { 
      row.appendChild(stack); 
      row.appendChild(avatar); 
    } else { 
      row.appendChild(avatar); 
      row.appendChild(stack); 
    }

    li.appendChild(row);
    return li;
  }

  async function refreshChannels() {
    console.log("[DEBUG] refreshChannels() called");
    try {
      const r = await fetch("/api/channels", { credentials: "include", cache: "no-store" });
      console.log("[DEBUG] channels response status:", r.status);
      const j = await r.json();
      console.log("[DEBUG] channels data:", j);
      
      if (!j.ok) {
        console.error("[DEBUG] channels not ok:", j);
        return;
      }
      
      const channelButtons = document.getElementById("channelButtons");
      console.log("[DEBUG] channelButtons element:", channelButtons);
      
      if (!channelButtons) {
        console.error("[DEBUG] channelButtons element not found!");
        return;
      }
      
      channelButtons.innerHTML = "";
      j.channels.forEach(ch => {
        console.log("[DEBUG] Creating button for channel:", ch);
        const btn = document.createElement("button");
        btn.className = "channel-btn text-xs px-3 py-1.5 rounded-full bg-white border border-gray-300";
        btn.dataset.key = ch.key;
        
        // Display proper channel names
        if (ch.key === "public-1") {
          btn.textContent = "모두의 방";
        } else if (ch.key.startsWith("dm:")) {
          const members = ch.members || [];
          const otherUser = members.find(m => m !== userAlias);
          btn.textContent = otherUser || ch.title || ch.key;
        } else {
          btn.textContent = ch.title || ch.key;
        }
        
        if (ch.key === currentChannel) btn.classList.add("active");
        
        btn.addEventListener("click", async () => {
          if (!(await requireLogin())) return;
          if (currentChannel === ch.key) return;
          currentChannel = ch.key;
          document.querySelectorAll(".channel-btn").forEach(b => {
            b.classList.toggle("active", b.dataset.key === ch.key);
          });
          statusLine(`채널: ${ch.title || ch.key}`);
          windowBefore = Math.floor(Date.now() / 1000);
          hasMore = true; 
          lastRenderedDayKey = null; 
          oldestTs = null;
          messageIdSet.clear();
          connectStream(currentChannel);
          await loadHistory(currentChannel, windowBefore);
          scrollToBottom(false);
        });
        
        channelButtons.appendChild(btn);
        console.log("[DEBUG] Button added to DOM");
      });
      
      console.log("[DEBUG] refreshChannels() completed, total buttons:", channelButtons.children.length);
    } catch (e) {
      console.error("[DEBUG] refreshChannels() error:", e);
    }
  }

  async function checkPushSubscriptionStatus() {
    
    const btn = $('enableNotificationsBtn');
    if (!btn || !('Notification' in window)) return;
 
    if (Notification.permission === 'default') {
        // Only show the button if the user has never made a choice
        btn.style.display = 'block';
    }
    }

  function appendMsg(msg, scroll = true) {
    // Skip if already rendered
    if (msg.id && messageIdSet.has(msg.id)) return;
    
    const key = dayKeyFromTs(
      msg.created_at || Math.floor(Date.now() / 1000)
    );
    if (lastRenderedDayKey !== key) {
      const liH = document.createElement("li");
      liH.appendChild(makeDayHeader(key));
      chatList.appendChild(liH);
      lastRenderedDayKey = key;
    }
    const li = buildMsgNode(msg);
    chatList.appendChild(li);
    if (msg.id) messageIdSet.add(msg.id);
    if (!oldestTs || (msg.created_at || Infinity) < oldestTs)
      oldestTs = msg.created_at;
    if (scroll) scrollToBottom(true);
  }
  
  function attachDeleteLongPress(el, msg, { duration = 1500, moveTolerance = 10 } = {}) {
    let timer = null, startX = 0, startY = 0, down = false;

    const clear = ()=>{ if (timer){ clearTimeout(timer); timer=null; } down=false; };
    const trigger = async ()=>{
      if (navigator.vibrate) { try{ navigator.vibrate(10); }catch{} }
      const ok = await showConfirm("이 메시지를 삭제할까요?", "삭제", "bg-red-500 hover:bg-red-600");
      if (ok) await deleteMessage(msg.id);
    };

    const shouldIgnore = (t)=> !!t.closest?.('a,button,input,textarea,select,video,audio,[data-no-longpress]');

    el.addEventListener("touchstart",(e)=>{
      const t = e.targetTouches?.[0]; if (!t) return;
      if (shouldIgnore(e.target)) return;
      down = true; startX=t.clientX; startY=t.clientY; clear();
      timer = setTimeout(trigger, duration);
    }, {passive:true});
    el.addEventListener("touchmove",(e)=>{
      if (!down) return; const t=e.targetTouches?.[0]; if(!t) return;
      const dx=t.clientX-startX, dy=t.clientY-startY;
      if ((dx*dx+dy*dy) > moveTolerance*moveTolerance) clear();
    }, {passive:true});
    el.addEventListener("touchend", clear);
    el.addEventListener("touchcancel", clear);

    el.addEventListener("mousedown",(e)=>{
      if (e.button!==0) return;
      if (shouldIgnore(e.target)) return;
      down=true; startX=e.clientX; startY=e.clientY; clear();
      timer=setTimeout(trigger, duration);
    });
    el.addEventListener("mousemove",(e)=>{
      if (!down) return;
      const dx=e.clientX-startX, dy=e.clientY-startY;
      if ((dx*dx+dy*dy) > moveTolerance*moveTolerance) clear();
    });
    el.addEventListener("mouseup", clear);
    el.addEventListener("mouseleave", clear);
    el.addEventListener("contextmenu",(e)=>{ e.preventDefault(); clear(); trigger(); });
  }

  async function startDM(otherAlias) {
    if (!(await requireLogin())) return;
    try {
      const resp = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ type: "dm", members: [userAlias, otherAlias] })
      });
      const j = await resp.json();
      if (!j.ok) { statusLine("DM 생성 실패", "error"); return; }
      const ch = j.channel;
      await refreshChannels();
      // Switch to the new DM channel
      const btn = document.querySelector(`.channel-btn[data-key="${ch.key}"]`);
      if (btn) btn.click();
      else {
        currentChannel = ch.key;
        connectStream(currentChannel);
        await loadHistory(currentChannel, Math.floor(Date.now()/1000));
      }
    } catch (e) {
      console.error("[DM]", e);
      statusLine("DM 생성 실패", "error");
    }
  }
  
  async function deleteMessage(id) {
    const node = chatList.querySelector(`li[data-msg-id="${id}"]`);
    if (node) node.style.opacity = ".5";

    try {
      const r = await fetch(`/api/messages/${id}`, {
        method: "DELETE",
        credentials: "include"
      });
      if (!r.ok) {
        const t = await r.text().catch(()=>"");
        console.warn("delete failed:", r.status, t);
        statusLine("삭제 실패", "error");
        if (node) node.style.opacity = "";
        return;
      }
      removeMsgFromDOM(id);
    } catch(e) {
      console.error(e);
      statusLine("삭제 실패", "error");
      if (node) node.style.opacity = "";
    }
  }

  function removeMsgFromDOM(id) {
    const li = chatList.querySelector(`li[data-msg-id="${id}"]`);
    if (!li) return;
    messageIdSet.delete(Number(id));
    li.remove();
  }
  
  function visibleLen(s) {
    return (s || "").length;
  }

  // ---------- form-driven send ----------
  if (composerForm) {
    composerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await sendText();
    });
  }
  if (sendTextBtn)
    sendTextBtn.addEventListener("click", (e) => {
      e.preventDefault();
      composerForm?.requestSubmit();
    });
  if (textInput)
    textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        composerForm?.requestSubmit();
      }
    });

  async function sendText() {
    if (!(await requireLogin())) return;
    await Promise.resolve();
    await new Promise(requestAnimationFrame);
    const t = (textInput?.value || "").trim();
    if (!t) return;

    if (sendTextBtn) sendTextBtn.disabled = true;
    try {
      const r = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          channel: currentChannel,
          alias: userAlias || "unknown",
          user_id: userId,
          type: "text",
          text: t,
        }),
      });
      if (!r.ok) {
        const m = await r.text().catch(() => r.statusText);
        console.error("[text] server", r.status, m);
        statusLine("전송 실패", "error");
        return;
      }
      
      // Parse the response to get the message
      const response = await r.json();
      if (response.message) {
        // Immediately add the message to the UI (don't wait for SSE)
        appendMsg(response.message, true);
      }
      
      if (textInput) textInput.value = "";
      scrollToBottom(true);
    } finally {
      if (sendTextBtn) sendTextBtn.disabled = false;
    }
  }

  // ---------- voice (single tap toggle) ----------
  let mediaRecorder = null,
    mediaMime = "",
    fileExt = "webm",
    audioChunks = [],
    isRecording = false;
    
  (function chooseBestAudioMime() {
    const prefs = [
      "audio/webm;codecs=opus",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    for (const t of prefs) {
      if (window.MediaRecorder?.isTypeSupported?.(t)) {
        mediaMime = t;
        fileExt = t.includes("mp4") ? "m4a" : t.includes("ogg") ? "ogg" : "webm";
        return;
      }
    }
    mediaMime = "";
    fileExt = "webm";
  })();

  if (pttBtn) {
    pttBtn.addEventListener("contextmenu", (e) => e.preventDefault(), {
      passive: false,
    });
    pttBtn.addEventListener("click", async (e) => {
      if (!(await requireLogin())) return;
      e.preventDefault();
      if (document.activeElement === textInput) {
        textInput.blur();
        if (isMobile())
          setTimeout(() => {
            applyKeyboardInset(0, false);
            setComposerHeight();
          }, 100);
      }

      if (!isRecording) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              noiseSuppression: true,
              echoCancellation: true,
              autoGainControl: true,
              sampleRate: 16000,
              sampleSize: 16,
            },
          });
          const opts = mediaMime
            ? { mimeType: mediaMime, audioBitsPerSecond: 40000 }
            : { audioBitsPerSecond: 40000 };
          audioChunks = [];
          mediaRecorder = new MediaRecorder(stream, opts);
          mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size) audioChunks.push(e.data);
          };
          mediaRecorder.onstop = async () => {
            try {
              const blob = new Blob(audioChunks, { type: mediaMime || "audio/webm" });
              if (blob.size) await uploadVoice(blob, fileExt);
            } catch (err) {
              console.error("[voice] upload", err);
              statusLine("음성 전송 실패", "error");
            } finally {
              stream.getTracks().forEach((t) => t.stop());
            }
          };
          mediaRecorder.start();
          isRecording = true;
          pttBtn.classList.add("recording");
          statusLine("녹음 중…");
        } catch (err) {
          console.error("[voice] gUM", err);
          statusLine("마이크 접근 실패", "error");
        }
      } else {
        try {
          mediaRecorder?.stop();
        } finally {
          isRecording = false;
          pttBtn.classList.remove("recording");
          statusLine("전송 중…");
        }
      }
    });
  }

  async function uploadVoice(blob, ext) {
    const fd = new FormData();
    fd.append("channel", currentChannel);
    fd.append("alias", userAlias || "unknown");
    fd.append("user_id", userId);
    fd.append("audio", blob, `voice.${ext || "webm"}`);

    const pending = addPendingBubble({ kind:"voice", label:"음성 업로드 중…" });

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/messages");
      xhr.withCredentials = true;

      if (xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            pending.setProgress((e.loaded / e.total) * 100);
          }
        };
      }

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        const pendingLi = $(pending.id);
        if (xhr.status >= 200 && xhr.status < 300) {
          if (pendingLi) pending.remove();
          statusLine("전송 완료", "success");
        } else {
          if (pendingLi) pending.fail("업로드 실패");
          statusLine("업로드 실패", "error");
        }
        resolve();
      };
      xhr.send(fd);
    });
  }

  // ---------- "+" file/image upload ----------
  if (addBtn && fileInput) {
    addBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!(await requireLogin())) return;

      const fd = new FormData();
      fd.append("channel", currentChannel);
      fd.append("alias", userAlias || "unknown");
      fd.append("user_id", userId);
      fd.append("upload", file, file.name);
      const label = `${file.name} 업로드 중…`;
      const pending = addPendingBubble({ kind: file.type.startsWith("image/") ? "image" : "file", label });
      
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/messages");
      xhr.withCredentials = true;

      if (xhr.upload) {
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) pending.setProgress((ev.loaded / ev.total) * 100);
        };
      }

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        const pendingLi = $(pending.id);
        if (xhr.status >= 200 && xhr.status < 300) {
          if (pendingLi) pending.remove();
          statusLine("업로드 완료", "success");
        } else {
          if (pendingLi) pending.fail("업로드 실패");
          statusLine("업로드 실패", "error");
        }
        e.target.value = ""; // reset chooser
      };

      xhr.send(fd);
    });
  }