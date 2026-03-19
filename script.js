/**
 * ALUMLY — script.js  (Firebase v10 edition)
 * ══════════════════════════════════════════════════════════════
 *
 * STATE MANAGEMENT PATTERN
 * ────────────────────────
 * All data lives in APP_STATE (single source of truth).
 * Flow: User action → mutate APP_STATE → scheduleCloudSync() → re-render
 *
 * Cloud layer:
 *   onAuthStateChanged  → gates the whole app
 *   onSnapshot          → real-time Firestore listener drives APP_STATE
 *   scheduleCloudSync() → debounced 500 ms write to Firestore
 *   handleFileUpload()  → uploads to Firebase Storage, stores downloadURL
 *
 * Camera and Canvas engine are UNCHANGED from the localStorage version.
 */

/* ══════════════════════════════════════════════════════════════
   FIREBASE IMPORTS
══════════════════════════════════════════════════════════════ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

/* ══════════════════════════════════════════════════════════════
   FIREBASE INIT
══════════════════════════════════════════════════════════════ */
const firebaseConfig = {
  apiKey: "AIzaSyCWzwUc9dYgPsYlZnhFDD6W4Mat9IO2udQ",
  authDomain: "alumly-app.firebaseapp.com",
  projectId: "alumly-app",
  storageBucket: "alumly-app.firebasestorage.app",
  messagingSenderId: "98501411336",
  appId: "1:98501411316:web:11a4fca7f669c64c2c79a1",
};
const fbApp = initializeApp(firebaseConfig);
const fbAuth = getAuth(fbApp);
const fbDb = getFirestore(fbApp);
const fbStorage = getStorage(fbApp);

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════════ */
const MAX_FILE_MB = 20;
const BLOCK_COLORS = [
  "#8b7cf8",
  "#b8f04a",
  "#f26c6c",
  "#4ecdc4",
  "#f5c842",
  "#f06aaa",
  "#5ea0f0",
  "#52e089",
];
const SUBJECT_COLORS = [
  "#8b7cf8",
  "#b8f04a",
  "#f26c6c",
  "#4ecdc4",
  "#f5c842",
  "#f06aaa",
  "#5ea0f0",
  "#52e089",
  "#f59142",
];
const SUBJECT_ICONS = [
  "📘",
  "📗",
  "📙",
  "📕",
  "📓",
  "📔",
  "📒",
  "📃",
  "📄",
  "📑",
  "✏️",
  "🖊",
  "🖋",
  "📝",
  "🔬",
  "🔭",
  "🧬",
  "🧪",
  "🧫",
  "🧲",
  "💡",
  "🔦",
  "🌍",
  "🌐",
  "🗺",
  "🧭",
  "🏔",
  "🎓",
  "🎒",
  "🏫",
  "🏛",
  "🔧",
  "⚙️",
  "🛠",
  "⚗️",
  "🧰",
  "💊",
  "🩺",
  "🏋️",
  "🎯",
  "🎲",
  "♟",
  "🎮",
  "🎨",
  "🎭",
  "🎬",
  "🎤",
  "🎸",
  "🎹",
  "🥁",
  "🏆",
  "🥇",
  "📊",
  "📈",
  "📉",
  "💼",
  "📋",
  "📌",
  "⚖️",
  "🔑",
];

/* ══════════════════════════════════════════════════════════════
   APP_STATE — single source of truth
══════════════════════════════════════════════════════════════ */
let APP_STATE = {
  subjects: [],
  settings: { theme: "dark", lastViewedSubject: null },
};
let _currentUser = null;
let _snapshotUnsub = null;
let _syncTimer = null;
let _ignoreNextSnapshot = false;
let _currentSubjectId = null;
let _currentResFilter = "all";
let _newLinkType = "link";
let _notesSaveTimer = null;
let _syncBadgeTimer = null;

/* ─── Normalizers ─── */
function normalizeSubject(raw) {
  return {
    id: raw.id || "subj_" + Date.now(),
    name: raw.name || "Untitled",
    emoji: raw.emoji || "📘",
    color: raw.color || SUBJECT_COLORS[0],
    examDate: raw.examDate || "",
    priority: raw.priority || false,
    isCompleted: raw.isCompleted || false,
    textNotes: raw.textNotes || "",
    canvasBlocks: (raw.canvasBlocks || []).map(normalizeBlock),
    connections: raw.connections || [],
    resources: raw.resources || [],
    viewport: raw.viewport || { scale: 1, ox: 0, oy: 0 },
  };
}
function normalizeBlock(raw) {
  return {
    id: raw.id || "blk_" + Date.now(),
    x: raw.x != null ? raw.x : 100,
    y: raw.y != null ? raw.y : 100,
    text: raw.text || "",
    color: raw.color || BLOCK_COLORS[0],
  };
}

/* ─── getSubject is UNCONDITIONAL — past-due dates never block access ─── */
function getSubject(id) {
  return APP_STATE.subjects.find((s) => s.id === id) || null;
}

/* ══════════════════════════════════════════════════════════════
   CLOUD SYNC
══════════════════════════════════════════════════════════════ */
function scheduleCloudSync() {
  if (!_currentUser) return;
  setSyncBadge("syncing");
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(writeToFirestore, 500);
}

async function writeToFirestore() {
  if (!_currentUser) return;
  try {
    _ignoreNextSnapshot = true;
    const ref = doc(fbDb, "users", _currentUser.uid);
    await setDoc(
      ref,
      JSON.parse(
        JSON.stringify({
          subjects: APP_STATE.subjects,
          settings: APP_STATE.settings,
        }),
      ),
    );
    setSyncBadge("saved");
  } catch (err) {
    console.error("Firestore write error:", err);
    setSyncBadge("error");
    toast("❌", "Cloud sync failed");
    _ignoreNextSnapshot = false;
  }
}

function attachRealtimeListener(uid) {
  if (_snapshotUnsub) {
    _snapshotUnsub();
    _snapshotUnsub = null;
  }
  const ref = doc(fbDb, "users", uid);
  _snapshotUnsub = onSnapshot(
    ref,
    (snap) => {
      if (_ignoreNextSnapshot) {
        _ignoreNextSnapshot = false;
        return;
      }
      if (!snap.exists()) return;
      const remote = snap.data();
      APP_STATE.subjects = (remote.subjects || []).map(normalizeSubject);
      APP_STATE.settings = {
        theme: "dark",
        lastViewedSubject: null,
        ...(remote.settings || {}),
      };
      applyTheme(APP_STATE.settings.theme);
      renderSidebar();
      renderDashboard();
      if (_currentSubjectId) {
        const s = getSubject(_currentSubjectId);
        if (s) {
          if (
            document.getElementById("tab-canvas")?.classList.contains("active")
          )
            renderCanvas();
          const ta = document.getElementById("subject-notes-area");
          if (ta && document.activeElement !== ta) ta.value = s.textNotes || "";
          renderResources();
        }
      }
    },
    (err) => console.error("Snapshot error:", err),
  );
}

/* ══════════════════════════════════════════════════════════════
   AUTHENTICATION
══════════════════════════════════════════════════════════════ */
function showAuthGate(visible) {
  const gate = document.getElementById("auth-gate");
  const app = document.getElementById("app");
  if (visible) {
    gate.classList.add("visible");
    app.classList.remove("ready");
  } else {
    gate.classList.remove("visible");
    app.classList.add("ready");
  }
}

async function signInWithGoogle() {
  try {
    await signInWithPopup(fbAuth, new GoogleAuthProvider());
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user")
      toast("❌", "Sign-in failed: " + (err.message || err.code));
  }
}

async function signOutUser() {
  if (_snapshotUnsub) {
    _snapshotUnsub();
    _snapshotUnsub = null;
  }
  _currentUser = null;
  APP_STATE = {
    subjects: [],
    settings: { theme: "dark", lastViewedSubject: null },
  };
  await signOut(fbAuth);
  renderNavUserStrip(null);
  showAuthGate(true);
}

async function onUserSignedIn(user) {
  _currentUser = user;
  renderNavUserStrip(user);
  showAuthGate(false);
  try {
    const snap = await getDoc(doc(fbDb, "users", user.uid));
    if (snap.exists()) {
      const data = snap.data();
      APP_STATE.subjects = (data.subjects || []).map(normalizeSubject);
      APP_STATE.settings = {
        theme: "dark",
        lastViewedSubject: null,
        ...(data.settings || {}),
      };
    }
  } catch (err) {
    toast("⚠️", "Could not load cloud data");
  }
  applyTheme(APP_STATE.settings.theme);
  attachRealtimeListener(user.uid);
  renderSidebar();
  renderDashboard();
  const last = APP_STATE.settings.lastViewedSubject;
  if (last && getSubject(last)) openSubject(last);
  else showView("dashboard");
}

function renderNavUserStrip(user) {
  const strip = document.getElementById("nav-user-strip");
  if (!strip) return;
  if (!user) {
    strip.innerHTML = "";
    return;
  }
  const initials = (user.displayName || user.email || "U")
    .charAt(0)
    .toUpperCase();
  const avatarHtml = user.photoURL
    ? `<img class="nav-user-avatar" src="${escAttr(user.photoURL)}" alt="">`
    : `<div class="nav-user-avatar-fallback">${initials}</div>`;
  strip.innerHTML = `
    <div class="nav-user-strip">
      ${avatarHtml}
      <span class="nav-user-name">${escHtml(user.displayName || user.email || "User")}</span>
      <button class="nav-user-signout" id="btn-signout" title="Sign out">↩</button>
    </div>`;
  document
    .getElementById("btn-signout")
    ?.addEventListener("click", signOutUser);
}

/* ── Sync badge ── */
function setSyncBadge(state) {
  const badge = document.getElementById("cloud-sync-badge");
  const text = document.getElementById("sync-badge-text");
  if (!badge) return;
  ["syncing", "saved", "error"].forEach((c) => badge.classList.remove(c));
  clearTimeout(_syncBadgeTimer);
  if (state === "syncing") {
    badge.classList.add("syncing");
    if (text) text.textContent = "Syncing…";
  } else if (state === "saved") {
    badge.classList.add("saved");
    if (text) text.textContent = "Saved to cloud";
    _syncBadgeTimer = setTimeout(() => badge.classList.remove("saved"), 2500);
  } else if (state === "error") {
    badge.classList.add("error");
    if (text) text.textContent = "Sync error";
    _syncBadgeTimer = setTimeout(() => badge.classList.remove("error"), 4000);
  }
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}
function formatDate(d) {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((new Date(dateStr) - now) / 86400000);
}

/* ══════════════════════════════════════════════════════════════
   THEME
══════════════════════════════════════════════════════════════ */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const icon = document.getElementById("theme-icon");
  if (icon) icon.textContent = theme === "dark" ? "☀" : "🌙";
}
function toggleTheme() {
  APP_STATE.settings.theme =
    APP_STATE.settings.theme === "dark" ? "light" : "dark";
  scheduleCloudSync();
  applyTheme(APP_STATE.settings.theme);
}

/* ══════════════════════════════════════════════════════════════
   VIEW ROUTER
══════════════════════════════════════════════════════════════ */
function showView(name) {
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.remove("active"));
  document.getElementById("view-" + name)?.classList.add("active");
}
function showDashboard() {
  _currentSubjectId = null;
  APP_STATE.settings.lastViewedSubject = null;
  scheduleCloudSync();
  renderSidebar();
  renderDashboard();
  showView("dashboard");
}
function openSubject(id) {
  const s = getSubject(id); // unconditional — never blocked by date
  if (!s) return;
  _currentSubjectId = id;
  APP_STATE.settings.lastViewedSubject = id;
  scheduleCloudSync();
  const titleEl = document.getElementById("ws-subject-title");
  if (titleEl) {
    const days = daysUntil(s.examDate);
    let badge = "";
    if (s.isCompleted)
      badge = `<span class="ws-subject-badge badge-done">✓ Done</span>`;
    else if (s.examDate) {
      if (days < 0)
        badge = `<span class="ws-subject-badge badge-overdue">Past Due</span>`;
      else if (days === 0)
        badge = `<span class="ws-subject-badge badge-soon">Today!</span>`;
      else if (days <= 7)
        badge = `<span class="ws-subject-badge badge-soon">${days}d left</span>`;
      else
        badge = `<span class="ws-subject-badge badge-exam">${days}d left</span>`;
    }
    titleEl.innerHTML = `<span>${s.emoji}</span>${escHtml(s.name)}${badge}`;
  }
  renderSidebar();
  switchWorkspaceTab("canvas");
  renderCanvas();
  renderResources();
  const ta = document.getElementById("subject-notes-area");
  if (ta) {
    ta.value = s.textNotes || "";
    updateSaveBadge("saved");
  }
  showView("workspace");
}

/* ══════════════════════════════════════════════════════════════
   WORKSPACE TABS
══════════════════════════════════════════════════════════════ */
function switchWorkspaceTab(tabName) {
  document
    .querySelectorAll(".ws-tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
  document
    .querySelectorAll(".ws-tab-panel")
    .forEach((p) => p.classList.remove("active"));
  document.getElementById("tab-" + tabName)?.classList.add("active");
}

/* ══════════════════════════════════════════════════════════════
   SIDEBAR
══════════════════════════════════════════════════════════════ */
function renderSidebar() {
  const list = document.getElementById("nav-subject-list");
  if (!list) return;
  if (!APP_STATE.subjects.length) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-3);padding:8px 10px;">No subjects yet</div>`;
    return;
  }
  list.innerHTML = APP_STATE.subjects
    .map(
      (s) => `
    <div class="nav-subject-item ${s.id === _currentSubjectId ? "active" : ""}" data-id="${s.id}">
      <span class="nav-subject-emoji">${s.emoji}</span>
      <span class="nav-subject-name">${escHtml(s.name)}</span>
      <button class="nav-subject-del" data-del="${s.id}" title="Delete">×</button>
    </div>`,
    )
    .join("");
  list.querySelectorAll(".nav-subject-item").forEach((item) =>
    item.addEventListener("click", (e) => {
      if (!e.target.dataset.del) openSubject(item.dataset.id);
    }),
  );
  list.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteSubject(btn.dataset.del);
    }),
  );
}

/* ══════════════════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const greet = document.getElementById("dashboard-greeting");
  if (greet) {
    const h = new Date().getHours();
    const time = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
    greet.innerHTML = `Good ${time}, <span>let's study</span>`;
  }
  const content = document.getElementById("dashboard-content");
  if (!content) return;
  const subjects = APP_STATE.subjects;
  const totalNotes = subjects.reduce((a, s) => a + s.canvasBlocks.length, 0);
  const totalRes = subjects.reduce((a, s) => a + s.resources.length, 0);
  const priority = subjects.filter((s) => s.priority).length;
  const statsHtml = subjects.length
    ? `
    <div class="dash-stats">
      <div class="dash-stat"><div class="dash-stat-val">${subjects.length}</div><div class="dash-stat-label">Subjects</div></div>
      <div class="dash-stat"><div class="dash-stat-val">${totalNotes}</div><div class="dash-stat-label">Blocks</div></div>
      <div class="dash-stat"><div class="dash-stat-val">${totalRes}</div><div class="dash-stat-label">Resources</div></div>
      ${priority ? `<div class="dash-stat"><div class="dash-stat-val" style="color:var(--red)">${priority}</div><div class="dash-stat-label">Priority</div></div>` : ""}
    </div>`
    : "";
  const cardsHtml = subjects.length
    ? subjects.map((s, i) => subjectCardHtml(s, i)).join("") +
      `<button class="add-subject-card" id="dash-add-card"><div class="add-subject-card-icon">＋</div><div>Add Subject</div></button>`
    : `<div class="dash-empty"><div class="dash-empty-icon">📚</div><h3>No subjects yet</h3><p>Create your first subject to start studying</p></div>`;
  content.innerHTML = `${statsHtml}${subjects.length ? '<div class="dash-section-heading">All Subjects</div>' : ""}<div class="subjects-grid">${cardsHtml}</div>`;
  document
    .getElementById("dash-add-card")
    ?.addEventListener("click", openAddSubjectModal);
  document.querySelectorAll(".subject-card").forEach((card) =>
    card.addEventListener("click", (e) => {
      if (!e.target.closest(".card-menu-btn")) openSubject(card.dataset.id);
    }),
  );
  document.querySelectorAll(".card-menu-btn").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditSubjectModal(btn.dataset.id);
    }),
  );
}

function subjectCardHtml(s, index) {
  const days = daysUntil(s.examDate);
  let badges = "";
  if (s.priority)
    badges += `<span class="badge badge-priority">⚡ Priority</span>`;
  if (s.isCompleted)
    badges += `<span class="badge badge-done">✓ Completed</span>`;
  else if (s.examDate) {
    if (days < 0)
      badges += `<span class="badge badge-overdue">Past Due · ${formatDate(s.examDate)}</span>`;
    else if (days === 0)
      badges += `<span class="badge badge-soon">Exam Today!</span>`;
    else if (days <= 7)
      badges += `<span class="badge badge-soon">📅 ${days}d · ${formatDate(s.examDate)}</span>`;
    else
      badges += `<span class="badge badge-exam">📅 ${days}d · ${formatDate(s.examDate)}</span>`;
  }
  return `
    <div class="subject-card ${s.priority ? "priority-card" : ""}"
         style="--card-accent:${s.color};animation-delay:${index * 0.04}s" data-id="${s.id}">
      <div class="card-header">
        <div class="card-emoji-wrap">${s.emoji}</div>
        <button class="card-menu-btn" data-id="${s.id}" title="Edit">✎</button>
      </div>
      <div class="card-name">${escHtml(s.name)}</div>
      <div class="card-badges">${badges || '<span style="font-size:11px;color:var(--text-3)">No exam date</span>'}</div>
      <div class="card-stats">
        <div class="card-stat">🧠 <strong>${s.canvasBlocks.length}</strong> blocks</div>
        <div class="card-stat">📚 <strong>${s.resources.length}</strong> resources</div>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   SUBJECT MODALS
══════════════════════════════════════════════════════════════ */
function openAddSubjectModal() {
  const defaultColor =
    SUBJECT_COLORS[APP_STATE.subjects.length % SUBJECT_COLORS.length];
  showModal({
    title: "✨ New Subject",
    body: buildSubjectForm({ emoji: "📘", color: defaultColor }),
    confirmText: "Create Subject",
    onConfirm: () => {
      const name = document.getElementById("m-subj-name").value.trim();
      if (!name) {
        toast("⚠️", "Name is required");
        return false;
      }
      APP_STATE.subjects.push(
        normalizeSubject({
          id: "subj_" + Date.now(),
          name,
          emoji: document.getElementById("m-subj-emoji-val").value || "📘",
          color:
            document.getElementById("m-subj-color-val").value || defaultColor,
          examDate: document.getElementById("m-subj-date").value,
          priority: document
            .getElementById("m-subj-priority")
            .classList.contains("on"),
        }),
      );
      scheduleCloudSync();
      closeModal();
      renderSidebar();
      renderDashboard();
      toast("✅", `"${name}" created`);
    },
  });
  document.getElementById("m-subj-name")?.focus();
}

function openEditSubjectModal(id) {
  const s = getSubject(id);
  if (!s) return;
  showModal({
    title: "✎ Edit Subject",
    body: buildSubjectForm(s),
    confirmText: "Save Changes",
    onConfirm: () => {
      const name = document.getElementById("m-subj-name").value.trim();
      if (!name) {
        toast("⚠️", "Name is required");
        return false;
      }
      s.name = name;
      s.emoji = document.getElementById("m-subj-emoji-val").value || s.emoji;
      s.color = document.getElementById("m-subj-color-val").value || s.color;
      s.examDate = document.getElementById("m-subj-date").value;
      s.priority = document
        .getElementById("m-subj-priority")
        .classList.contains("on");
      s.isCompleted = document
        .getElementById("m-subj-completed")
        .classList.contains("on");
      scheduleCloudSync();
      closeModal();
      if (_currentSubjectId === id) openSubject(id);
      else {
        renderSidebar();
        renderDashboard();
      }
      toast("✅", "Subject updated");
    },
  });
}

function buildSubjectForm(defaults) {
  return `
    <div class="modal-field">
      <label class="modal-label">Name</label>
      <input class="modal-input" id="m-subj-name" placeholder="e.g. Calculus, History…" value="${escAttr(defaults.name || "")}" />
    </div>
    <div class="modal-field">
      <label class="modal-label">Icon</label>
      <input type="hidden" id="m-subj-emoji-val" value="${escAttr(defaults.emoji || "📘")}" />
      <div class="icon-picker-grid" id="icon-picker-grid">
        ${SUBJECT_ICONS.map((icon) => `<div class="icon-picker-cell ${icon === (defaults.emoji || "📘") ? "selected" : ""}" data-icon="${icon}">${icon}</div>`).join("")}
      </div>
    </div>
    <div class="modal-field">
      <label class="modal-label">Colour</label>
      <input type="hidden" id="m-subj-color-val" value="${escAttr(defaults.color || SUBJECT_COLORS[0])}" />
      <div class="color-picker-row" id="color-picker-row">
        ${SUBJECT_COLORS.map((c) => `<div class="color-swatch ${c === defaults.color ? "selected" : ""}" style="background:${c}" data-color="${c}"></div>`).join("")}
      </div>
    </div>
    <div class="modal-field">
      <label class="modal-label">Exam Date (optional)</label>
      <input class="modal-input" id="m-subj-date" type="date" value="${escAttr(defaults.examDate || "")}" />
    </div>
    <div class="modal-field">
      <label class="modal-toggle-row" id="lbl-priority">
        <div class="toggle-switch ${defaults.priority ? "on" : ""}" id="m-subj-priority"></div>
        Mark as Priority
      </label>
    </div>
    <div class="modal-field">
      <label class="modal-toggle-row" id="lbl-completed">
        <div class="toggle-switch ${defaults.isCompleted ? "on" : ""}" id="m-subj-completed"></div>
        Mark as Completed
      </label>
    </div>`;
}

function wireSubjectFormEvents() {
  document
    .getElementById("icon-picker-grid")
    ?.addEventListener("click", (e) => {
      const cell = e.target.closest(".icon-picker-cell");
      if (!cell) return;
      document
        .querySelectorAll(".icon-picker-cell")
        .forEach((c) => c.classList.remove("selected"));
      cell.classList.add("selected");
      const inp = document.getElementById("m-subj-emoji-val");
      if (inp) inp.value = cell.dataset.icon;
    });
  document
    .getElementById("color-picker-row")
    ?.addEventListener("click", (e) => {
      const sw = e.target.closest(".color-swatch");
      if (!sw) return;
      document
        .querySelectorAll(".color-swatch")
        .forEach((c) => c.classList.remove("selected"));
      sw.classList.add("selected");
      const inp = document.getElementById("m-subj-color-val");
      if (inp) inp.value = sw.dataset.color;
    });
  document
    .getElementById("lbl-priority")
    ?.addEventListener("click", () =>
      document.getElementById("m-subj-priority")?.classList.toggle("on"),
    );
  document
    .getElementById("lbl-completed")
    ?.addEventListener("click", () =>
      document.getElementById("m-subj-completed")?.classList.toggle("on"),
    );
}

function confirmDeleteSubject(id) {
  const s = getSubject(id);
  if (!s) return;
  showModal({
    title: "🗑 Delete Subject?",
    body: `<p style="color:var(--text-2);font-size:13.5px">Delete <strong>"${escHtml(s.name)}"</strong>?<br>All blocks, notes, and resources will be permanently removed.</p>`,
    confirmText: "Delete",
    confirmClass: "modal-btn-danger",
    onConfirm: () => {
      APP_STATE.subjects = APP_STATE.subjects.filter((x) => x.id !== id);
      if (_currentSubjectId === id) _currentSubjectId = null;
      scheduleCloudSync();
      closeModal();
      renderSidebar();
      renderDashboard();
      if (_currentSubjectId === null) showView("dashboard");
      toast("🗑", `"${s.name}" deleted`);
    },
  });
}

/* ══════════════════════════════════════════════════════════════
   CANVAS ENGINE — camera & canvasState UNCHANGED
══════════════════════════════════════════════════════════════ */
const camera = {
  scale: 1,
  ox: 0,
  oy: 0,
  MIN: 0.12,
  MAX: 3.5,
  apply() {
    const world = document.getElementById("canvas-world");
    if (!world) return;
    world.style.transform = `translate(${this.ox}px,${this.oy}px) scale(${this.scale})`;
    const panel = document.getElementById("canvas-panel");
    if (panel) {
      panel.style.setProperty("--grid-ox", (this.ox % 28) + "px");
      panel.style.setProperty("--grid-oy", (this.oy % 28) + "px");
    }
    const zd = document.getElementById("zoom-display");
    if (zd) zd.textContent = Math.round(this.scale * 100) + "%";
    const s = getSubject(_currentSubjectId);
    if (s) s.viewport = { scale: this.scale, ox: this.ox, oy: this.oy };
  },
  zoomAt(sx, sy, delta) {
    const f = delta > 0 ? 0.9 : 1.1;
    const ns = Math.min(this.MAX, Math.max(this.MIN, this.scale * f));
    const sc = ns / this.scale;
    this.ox = sx - sc * (sx - this.ox);
    this.oy = sy - sc * (sy - this.oy);
    this.scale = ns;
    this.apply();
  },
  loadFrom(vp) {
    if (!vp) return;
    this.scale = vp.scale != null ? vp.scale : 1;
    this.ox = vp.ox != null ? vp.ox : 0;
    this.oy = vp.oy != null ? vp.oy : 0;
    this.apply();
  },
  reset() {
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.apply();
    scheduleCloudSync();
  },
};

const canvasState = {
  pan: { active: false, sx: 0, sy: 0, ox0: 0, oy0: 0 },
  drag: { active: false, blockId: null, nx0: 0, ny0: 0 },
  connect: { active: false, fromId: null },
  spaceDown: false,
  eventsInited: false,
};

function renderCanvas() {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  const world = document.getElementById("canvas-world");
  if (!world) return;
  world.querySelectorAll(".canvas-block").forEach((n) => n.remove());
  const empty = document.getElementById("canvas-empty-state");
  if (empty) empty.style.display = s.canvasBlocks.length ? "none" : "flex";
  s.canvasBlocks.forEach((b) => mountBlock(b));
  renderConnections();
  camera.loadFrom(s.viewport);
  if (!canvasState.eventsInited) {
    initCanvasEvents();
    canvasState.eventsInited = true;
  }
}

function addBlock() {
  const panel = document.getElementById("canvas-panel");
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  addBlockAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function addBlockAt(screenX, screenY) {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  const panel = document.getElementById("canvas-panel");
  const rect = panel.getBoundingClientRect();
  const wx = (screenX - rect.left - camera.ox) / camera.scale - 90;
  const wy = (screenY - rect.top - camera.oy) / camera.scale - 40;
  const block = normalizeBlock({
    id: "blk_" + Date.now(),
    x: Math.round(wx),
    y: Math.round(wy),
    text: "",
    color: BLOCK_COLORS[s.canvasBlocks.length % BLOCK_COLORS.length],
  });
  s.canvasBlocks.push(block);
  scheduleCloudSync();
  document.getElementById("canvas-empty-state").style.display = "none";
  mountBlock(block, true);
}

function mountBlock(block, focusOnMount) {
  const el = document.createElement("div");
  el.className = "canvas-block";
  el.dataset.id = block.id;
  el.style.left = block.x + "px";
  el.style.top = block.y + "px";
  el.innerHTML = `
    <div class="block-accent-bar" style="background:${block.color}"></div>
    <div class="block-body"><textarea class="block-textarea" placeholder="Type your thoughts…">${escHtml(block.text)}</textarea></div>
    <div class="block-footer">
      <div class="block-colors">${BLOCK_COLORS.map((c) => `<div class="block-color-dot" style="background:${c}" data-color="${c}"></div>`).join("")}</div>
      <div class="block-actions">
        <button class="block-action-btn btn-conn" title="Connect">⟷</button>
        <button class="block-action-btn btn-del" title="Delete">🗑</button>
      </div>
    </div>`;
  const ta = el.querySelector(".block-textarea");
  ta.addEventListener("input", () => {
    updateBlockText(block.id, ta.value);
    autoResizeTA(ta);
  });
  ta.addEventListener("mousedown", (e) => e.stopPropagation());
  ta.addEventListener("focus", () => el.classList.add("selected"));
  ta.addEventListener("blur", () => el.classList.remove("selected"));
  autoResizeTA(ta);
  el.querySelector(".btn-conn").addEventListener("click", () =>
    handleBlockConnect(block.id),
  );
  el.querySelector(".btn-del").addEventListener("click", () =>
    deleteBlock(block.id),
  );
  el.querySelector(".block-colors").addEventListener("click", (e) => {
    const dot = e.target.closest(".block-color-dot");
    if (dot) changeBlockColor(block.id, dot.dataset.color);
  });
  el.addEventListener("mousedown", (e) => {
    if (["TEXTAREA", "BUTTON"].includes(e.target.tagName)) return;
    if (e.target.classList.contains("block-color-dot")) return;
    if (canvasState.spaceDown) return;
    if (canvasState.connect.active) {
      handleBlockConnect(block.id);
      return;
    }
    e.preventDefault();
    const cs = canvasState.drag;
    cs.active = true;
    cs.blockId = block.id;
    const rect = document
      .getElementById("canvas-panel")
      .getBoundingClientRect();
    cs.nx0 = (e.clientX - rect.left - camera.ox) / camera.scale - block.x;
    cs.ny0 = (e.clientY - rect.top - camera.oy) / camera.scale - block.y;
    el.classList.add("dragging");
  });
  document.getElementById("canvas-world").appendChild(el);
  if (focusOnMount) ta.focus();
}

function autoResizeTA(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
}

function updateBlockText(id, text) {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  const b = s.canvasBlocks.find((b) => b.id === id);
  if (b) {
    b.text = text;
    scheduleCloudSync();
  }
}

function changeBlockColor(id, color) {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  const b = s.canvasBlocks.find((b) => b.id === id);
  if (b) b.color = color;
  const el = document.querySelector(`.canvas-block[data-id="${id}"]`);
  if (el) el.querySelector(".block-accent-bar").style.background = color;
  scheduleCloudSync();
}

function deleteBlock(id) {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  s.connections = s.connections.filter((c) => c.from !== id && c.to !== id);
  s.canvasBlocks = s.canvasBlocks.filter((b) => b.id !== id);
  const el = document.querySelector(`.canvas-block[data-id="${id}"]`);
  if (el) {
    el.style.cssText +=
      ";transition:opacity .12s,transform .12s;opacity:0;transform:scale(.85)";
    setTimeout(() => el.remove(), 140);
  }
  const empty = document.getElementById("canvas-empty-state");
  if (empty && !s.canvasBlocks.length) empty.style.display = "flex";
  renderConnections();
  scheduleCloudSync();
}

function clearCanvas() {
  const s = getSubject(_currentSubjectId);
  if (!s || !s.canvasBlocks.length) {
    toast("ℹ️", "Canvas is already empty");
    return;
  }
  showModal({
    title: "🗑 Clear Canvas?",
    body: `<p style="color:var(--text-2);font-size:13.5px">Remove all <strong>${s.canvasBlocks.length}</strong> block(s) and <strong>${s.connections.length}</strong> connection(s)?</p>`,
    confirmText: "Clear All",
    confirmClass: "modal-btn-danger",
    onConfirm: () => {
      s.canvasBlocks = [];
      s.connections = [];
      scheduleCloudSync();
      closeModal();
      document.querySelectorAll(".canvas-block").forEach((n) => n.remove());
      document.getElementById("conn-svg").innerHTML = "";
      document.getElementById("canvas-empty-state").style.display = "flex";
      toast("🗑", "Canvas cleared");
    },
  });
}

/* ── Connections ── */
function toggleConnectMode() {
  const cs = canvasState.connect;
  cs.active = !cs.active;
  cs.fromId = null;
  document
    .getElementById("btn-connect-mode")
    ?.classList.toggle("active-mode", cs.active);
  const hint = document.getElementById("conn-mode-hint");
  if (hint) hint.style.display = cs.active ? "block" : "none";
  document
    .querySelectorAll(".canvas-block.connecting-source")
    .forEach((n) => n.classList.remove("connecting-source"));
}

function handleBlockConnect(blockId) {
  const cs = canvasState.connect;
  if (!cs.active) return;
  if (!cs.fromId) {
    cs.fromId = blockId;
    document
      .querySelector(`.canvas-block[data-id="${blockId}"]`)
      ?.classList.add("connecting-source");
    return;
  }
  if (cs.fromId === blockId) {
    document
      .querySelector(`.canvas-block[data-id="${blockId}"]`)
      ?.classList.remove("connecting-source");
    cs.fromId = null;
    return;
  }
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  const dup = s.connections.find(
    (c) =>
      (c.from === cs.fromId && c.to === blockId) ||
      (c.from === blockId && c.to === cs.fromId),
  );
  if (!dup) {
    s.connections.push({
      id: "conn_" + Date.now(),
      from: cs.fromId,
      to: blockId,
    });
    renderConnections();
    scheduleCloudSync();
    toast("⟷", "Blocks connected");
  } else toast("ℹ️", "Already connected");
  document
    .querySelector(`.canvas-block[data-id="${cs.fromId}"]`)
    ?.classList.remove("connecting-source");
  cs.fromId = null;
  toggleConnectMode();
}

function getBlockCenter(id) {
  const el = document.querySelector(`.canvas-block[data-id="${id}"]`);
  if (!el) return null;
  return {
    x: parseFloat(el.style.left) + el.offsetWidth / 2,
    y: parseFloat(el.style.top) + el.offsetHeight / 2,
  };
}

function renderConnections() {
  const svg = document.getElementById("conn-svg");
  if (!svg) return;
  svg.innerHTML = "";
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  s.connections.forEach((conn) => {
    const a = getBlockCenter(conn.from),
      b = getBlockCenter(conn.to);
    if (!a || !b) return;
    const mx = (a.x + b.x) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "conn-path");
    path.dataset.connId = conn.id;
    path.setAttribute(
      "d",
      `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`,
    );
    path.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e.clientX, e.clientY, [
        {
          icon: "🗑",
          label: "Delete Connection",
          action: () => deleteConnection(conn.id),
          danger: true,
        },
      ]);
    });
    svg.appendChild(path);
  });
}

function deleteConnection(connId) {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  s.connections = s.connections.filter((c) => c.id !== connId);
  renderConnections();
  scheduleCloudSync();
  toast("🗑", "Connection removed");
}

function initCanvasEvents() {
  const panel = document.getElementById("canvas-panel");
  if (!panel) return;
  panel.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      camera.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY);
      scheduleCloudSync();
    },
    { passive: false },
  );
  panel.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (canvasState.spaceDown && !canvasState.drag.active) {
      const p = canvasState.pan;
      p.active = true;
      p.sx = e.clientX;
      p.sy = e.clientY;
      p.ox0 = camera.ox;
      p.oy0 = camera.oy;
      panel.classList.add("panning");
      e.preventDefault();
    }
  });
  document.addEventListener("mousemove", (e) => {
    const p = canvasState.pan,
      d = canvasState.drag;
    if (p.active) {
      camera.ox = p.ox0 + (e.clientX - p.sx);
      camera.oy = p.oy0 + (e.clientY - p.sy);
      camera.apply();
    }
    if (d.active) {
      const r = panel.getBoundingClientRect();
      const el = document.querySelector(
        `.canvas-block[data-id="${d.blockId}"]`,
      );
      if (el) {
        el.style.left =
          (e.clientX - r.left - camera.ox) / camera.scale - d.nx0 + "px";
        el.style.top =
          (e.clientY - r.top - camera.oy) / camera.scale - d.ny0 + "px";
      }
      renderConnections();
    }
  });
  document.addEventListener("mouseup", () => {
    const p = canvasState.pan,
      d = canvasState.drag;
    if (p.active) {
      p.active = false;
      panel.classList.remove("panning");
      scheduleCloudSync();
    }
    if (d.active) {
      const s = getSubject(_currentSubjectId),
        el = document.querySelector(`.canvas-block[data-id="${d.blockId}"]`);
      if (s && el) {
        const b = s.canvasBlocks.find((b) => b.id === d.blockId);
        if (b) {
          b.x = parseInt(el.style.left);
          b.y = parseInt(el.style.top);
        }
      }
      el?.classList.remove("dragging");
      d.active = false;
      d.blockId = null;
      scheduleCloudSync();
    }
  });
  panel.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".canvas-block")) return;
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      {
        icon: "⊙",
        label: "Reset View",
        action: () => {
          camera.reset();
          toast("⊙", "View reset");
        },
      },
      {
        icon: "＋",
        label: "Add Block Here",
        action: () => addBlockAt(e.clientX, e.clientY),
      },
      { type: "sep" },
      { icon: "🗑", label: "Clear Canvas", action: clearCanvas, danger: true },
    ]);
  });
  document.addEventListener("keydown", (e) => {
    if (
      e.code === "Space" &&
      !["TEXTAREA", "INPUT"].includes(e.target.tagName)
    ) {
      e.preventDefault();
      canvasState.spaceDown = true;
      if (!canvasState.pan.active) panel.classList.add("pan-ready");
    }
    if (e.key === "Escape") {
      closeModal();
      closeCtxMenu();
      if (canvasState.connect.active) toggleConnectMode();
    }
    if (
      (e.key === "n" || e.key === "N") &&
      !["TEXTAREA", "INPUT"].includes(e.target.tagName)
    ) {
      if (document.getElementById("tab-canvas")?.classList.contains("active"))
        addBlock();
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      canvasState.spaceDown = false;
      panel.classList.remove("pan-ready");
    }
  });
  document.addEventListener("click", () => closeCtxMenu());
}

/* ══════════════════════════════════════════════════════════════
   TEXT NOTES
══════════════════════════════════════════════════════════════ */
function updateSaveBadge(state) {
  const badge = document.getElementById("notes-save-badge");
  if (!badge) return;
  badge.textContent = state === "saving" ? "Saving…" : "Saved";
  badge.className =
    "notes-autosave-badge" + (state === "saving" ? " saving" : "");
}
function onNotesInput(e) {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  updateSaveBadge("saving");
  clearTimeout(_notesSaveTimer);
  _notesSaveTimer = setTimeout(() => {
    s.textNotes = e.target.value;
    scheduleCloudSync();
    updateSaveBadge("saved");
  }, 600);
}

/* ══════════════════════════════════════════════════════════════
   RESOURCES — Firebase Storage upload
══════════════════════════════════════════════════════════════ */
function renderResources(filter) {
  if (filter !== undefined) _currentResFilter = filter;
  const s = getSubject(_currentSubjectId),
    list = document.getElementById("res-list");
  if (!s || !list) return;
  let items = s.resources;
  if (_currentResFilter !== "all")
    items = items.filter((r) => r.type === _currentResFilter);
  if (!items.length) {
    list.innerHTML = `<div class="res-empty"><div class="res-empty-icon">${_currentResFilter === "all" ? "📭" : "🔍"}</div><div>${_currentResFilter === "all" ? "No resources yet" : "No " + _currentResFilter + "s added"}</div></div>`;
    return;
  }
  list.innerHTML = items.map((r) => resItemHtml(r)).join("");
}

function resItemHtml(r) {
  if (r.isFile) return fileCardHtml(r);
  const icons = {
    link: "🔗",
    video: "▶️",
    doc: "📄",
    note: "📝",
    pdf: "📕",
    image: "🖼",
  };
  const classes = {
    link: "ri-link",
    video: "ri-video",
    doc: "ri-doc",
    note: "ri-note",
    pdf: "ri-pdf",
    image: "ri-image",
  };
  return `<div class="res-item"><div class="res-item-row">
    <div class="res-type-icon ${classes[r.type] || "ri-link"}">${icons[r.type] || "🔗"}</div>
    <div class="res-info">
      <div class="res-item-title">${escHtml(r.title)}</div>
      ${r.url ? `<div class="res-item-meta"><a href="${escAttr(r.url)}" target="_blank" rel="noopener">${escHtml(r.url.length > 42 ? r.url.slice(0, 42) + "…" : r.url)}</a></div>` : ""}
    </div>
    <div class="res-item-actions">
      <button class="res-action-icon ${r.fav ? "fav-on" : ""}" onclick="toggleResFav('${r.id}')" title="Favourite">★</button>
      <button class="res-action-icon del" onclick="deleteResource('${r.id}')" title="Delete">🗑</button>
    </div>
  </div></div>`;
}

function fileCardHtml(r) {
  const src = r.downloadURL || r.dataURL || "";
  const preview =
    r.type === "image" && src
      ? `<img class="file-preview-img" src="${escAttr(src)}" loading="lazy" alt="${escHtml(r.title)}">`
      : `<div class="file-preview-placeholder">${r.type === "pdf" ? "📕" : r.type === "text" ? "📄" : "📦"}</div>`;
  return `<div class="res-item file-card">${preview}
    <div class="file-card-body">
      <div class="file-card-info"><div class="file-card-name">${escHtml(r.title)}</div><div class="file-card-meta">${r.sizeMB} MB · ${(r.ext || "?").toUpperCase()}</div></div>
      <div class="file-card-actions">
        ${(r.type === "image" || r.type === "pdf") && src ? `<button class="res-action-icon" onclick="previewResource('${r.id}')" title="Preview">👁</button>` : ""}
        ${src ? `<button class="res-action-icon" onclick="openResource('${r.id}')" title="Open">↗</button>` : ""}
        <button class="res-action-icon ${r.fav ? "fav-on" : ""}" onclick="toggleResFav('${r.id}')" title="Fav">★</button>
        <button class="res-action-icon del" onclick="deleteResource('${r.id}')" title="Delete">🗑</button>
      </div>
    </div>
  </div>`;
}

async function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = "";
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  if (!_currentUser) {
    toast("❌", "Not signed in");
    return;
  }
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_FILE_MB) {
    toast(
      "⚠️",
      `File too large (${sizeMB.toFixed(1)} MB). Max: ${MAX_FILE_MB} MB`,
      5000,
    );
    return;
  }
  const ext = file.name.split(".").pop().toLowerCase();
  const type =
    ext === "pdf"
      ? "pdf"
      : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)
        ? "image"
        : "text";
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `uploads/${_currentUser.uid}/${Date.now()}_${safeName}`;
  const fRef = storageRef(fbStorage, storagePath);
  const progressWrap = document.getElementById("res-upload-progress");
  const progressBar = document.getElementById("res-upload-bar");
  const progressPct = document.getElementById("res-upload-pct");
  const progressName = document.getElementById("res-upload-name");
  if (progressWrap) {
    progressWrap.style.display = "block";
    if (progressName) progressName.textContent = file.name;
    if (progressBar) progressBar.style.width = "0%";
    if (progressPct) progressPct.textContent = "0%";
  }
  toast("⏳", `Uploading ${file.name}…`);
  const task = uploadBytesResumable(fRef, file);
  task.on(
    "state_changed",
    (snap) => {
      const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
      if (progressBar) progressBar.style.width = pct + "%";
      if (progressPct) progressPct.textContent = pct + "%";
    },
    (err) => {
      console.error(err);
      toast("❌", "Upload failed: " + err.code);
      if (progressWrap) progressWrap.style.display = "none";
    },
    async () => {
      try {
        const downloadURL = await getDownloadURL(task.snapshot.ref);
        s.resources.push({
          id: "res_" + Date.now(),
          title: file.name,
          type,
          isFile: true,
          ext,
          sizeMB: +sizeMB.toFixed(2),
          downloadURL,
          storagePath,
          fav: false,
        });
        scheduleCloudSync();
        renderResources();
        toast("✅", `"${file.name}" uploaded`);
      } catch (e) {
        toast("❌", "Could not get download URL");
      } finally {
        if (progressWrap) progressWrap.style.display = "none";
      }
    },
  );
}

function previewResource(resId) {
  const s = getSubject(_currentSubjectId),
    r = s?.resources.find((x) => x.id === resId);
  if (!r) return;
  const src = r.downloadURL || r.dataURL || "";
  if (r.type === "image")
    showModal({
      title: `🖼 ${escHtml(r.title)}`,
      body: `<img src="${escAttr(src)}" style="width:100%;border-radius:8px;margin-bottom:12px">`,
      confirmText: "↗ Open",
      onConfirm: () => {
        window.open(src, "_blank");
        return false;
      },
    });
  else if (r.type === "pdf")
    showModal({
      title: `📕 ${escHtml(r.title)}`,
      body: `<iframe src="${escAttr(src)}" style="width:100%;height:420px;border-radius:8px;border:none"></iframe>`,
      confirmText: "↗ Open",
      onConfirm: () => {
        window.open(src, "_blank");
        return false;
      },
    });
}
function openResource(resId) {
  const s = getSubject(_currentSubjectId),
    r = s?.resources.find((x) => x.id === resId);
  const src = r?.downloadURL || r?.dataURL;
  if (src) window.open(src, "_blank");
}
function deleteResource(resId) {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  const r = s.resources.find((r) => r.id === resId);
  if (!r) return;
  if (r.storagePath && _currentUser)
    deleteObject(storageRef(fbStorage, r.storagePath)).catch((e) =>
      console.warn("Storage delete skipped:", e.code),
    );
  s.resources = s.resources.filter((x) => x.id !== resId);
  scheduleCloudSync();
  renderResources();
  toast("🗑", "Resource removed");
}
function toggleResFav(resId) {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  const r = s.resources.find((r) => r.id === resId);
  if (r) {
    r.fav = !r.fav;
    scheduleCloudSync();
    renderResources();
  }
}
function saveLink() {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  const title = document.getElementById("res-link-title").value.trim();
  const url = document.getElementById("res-link-url").value.trim();
  if (!title) {
    toast("⚠️", "Please enter a title");
    return;
  }
  s.resources.push({
    id: "res_" + Date.now(),
    title,
    url,
    type: _newLinkType,
    fav: false,
    isFile: false,
  });
  scheduleCloudSync();
  document.getElementById("res-link-title").value = "";
  document.getElementById("res-link-url").value = "";
  toggleResForm(false);
  renderResources();
  toast("✅", "Resource saved");
}
function toggleResForm(show) {
  const form = document.getElementById("res-add-form");
  if (!form) return;
  const visible = show != null ? show : form.style.display === "none";
  form.style.display = visible ? "" : "none";
  if (visible) document.getElementById("res-link-title")?.focus();
}
function setResLinkType(el, type) {
  document
    .querySelectorAll(".res-type-btn")
    .forEach((b) => b.classList.remove("active"));
  el.classList.add("active");
  _newLinkType = type;
}
function setResFilter(el, filter) {
  document
    .querySelectorAll(".res-filter-btn")
    .forEach((b) => b.classList.remove("active"));
  el.classList.add("active");
  renderResources(filter);
}

/* ══════════════════════════════════════════════════════════════
   EXPORT / IMPORT
══════════════════════════════════════════════════════════════ */
function exportSubject() {
  const s = getSubject(_currentSubjectId);
  if (!s) return;
  downloadJSON(
    {
      _alumly: true,
      version: 5,
      exportedAt: new Date().toISOString(),
      subject: s,
    },
    `alumly-${s.name.replace(/\s+/g, "-").toLowerCase()}.json`,
  );
  toast("⬇", `"${s.name}" exported`);
}
function exportAll() {
  downloadJSON(
    {
      _alumly: true,
      version: 5,
      exportedAt: new Date().toISOString(),
      data: APP_STATE,
    },
    `alumly-backup-${new Date().toISOString().slice(0, 10)}.json`,
  );
  toast("⬇", "Full backup exported");
}
function downloadJSON(obj, filename) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function triggerImport() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data._alumly) throw new Error("Not an Alumly file");
      if (data.data) {
        APP_STATE = {
          subjects: (data.data.subjects || []).map(normalizeSubject),
          settings: data.data.settings || {
            theme: "dark",
            lastViewedSubject: null,
          },
        };
        scheduleCloudSync();
        showDashboard();
        toast("✅", `Backup imported (${APP_STATE.subjects.length} subjects)`);
      } else if (data.subject) {
        const imported = normalizeSubject({
          ...data.subject,
          id: "subj_" + Date.now(),
        });
        APP_STATE.subjects.push(imported);
        scheduleCloudSync();
        renderSidebar();
        renderDashboard();
        toast("✅", `"${imported.name}" imported`);
      }
    } catch (err) {
      toast("❌", "Invalid Alumly file");
    }
  };
  input.click();
}

/* ══════════════════════════════════════════════════════════════
   CONTEXT MENU
══════════════════════════════════════════════════════════════ */
function showCtxMenu(x, y, items) {
  const menu = document.getElementById("ctx-menu");
  menu.innerHTML = items
    .map((item, idx) =>
      item.type === "sep"
        ? '<div class="ctx-sep"></div>'
        : `<button class="ctx-item${item.danger ? " danger" : ""}" data-idx="${idx}"><span>${item.icon}</span>${item.label}</button>`,
    )
    .join("");
  menu.querySelectorAll("[data-idx]").forEach((btn) =>
    btn.addEventListener("click", () => {
      closeCtxMenu();
      items[+btn.dataset.idx].action();
    }),
  );
  menu.style.display = "block";
  const mw = menu.offsetWidth,
    mh = menu.offsetHeight;
  menu.style.left = (x + mw > window.innerWidth ? x - mw : x) + "px";
  menu.style.top = (y + mh > window.innerHeight ? y - mh : y) + "px";
}
function closeCtxMenu() {
  const m = document.getElementById("ctx-menu");
  if (m) m.style.display = "none";
}

/* ══════════════════════════════════════════════════════════════
   MODAL
══════════════════════════════════════════════════════════════ */
function showModal({
  title,
  body,
  confirmText = "Confirm",
  confirmClass = "modal-btn-confirm",
  onConfirm,
  cancelText = "Cancel",
}) {
  const mount = document.getElementById("modal-mount");
  mount.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal-box">
    <div class="modal-title">${title}</div>
    <div id="modal-body">${body}</div>
    <div class="modal-footer">
      <button class="modal-btn-cancel" id="modal-cancel-btn">${cancelText}</button>
      <button class="${confirmClass}" id="modal-confirm-btn">${confirmText}</button>
    </div>
  </div></div>`;
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  document
    .getElementById("modal-cancel-btn")
    .addEventListener("click", closeModal);
  document.getElementById("modal-confirm-btn").addEventListener("click", () => {
    if (onConfirm() !== false) closeModal();
  });
  wireSubjectFormEvents();
}
function closeModal() {
  document.getElementById("modal-mount").innerHTML = "";
}

/* ══════════════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════════════ */
function toast(icon, msg, duration = 2600) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${icon}</span><span>${escHtml(String(msg))}</span>`;
  document.getElementById("toast-rack").appendChild(el);
  setTimeout(() => {
    el.style.cssText +=
      "transition:opacity .28s,transform .28s;opacity:0;transform:translateX(14px)";
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/* ══════════════════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
  applyTheme("dark");

  document
    .getElementById("btn-google-signin")
    ?.addEventListener("click", signInWithGoogle);
  document
    .getElementById("btn-add-subject")
    ?.addEventListener("click", openAddSubjectModal);
  document
    .getElementById("btn-theme-toggle")
    ?.addEventListener("click", toggleTheme);
  document
    .getElementById("btn-export-all")
    ?.addEventListener("click", exportAll);
  document
    .getElementById("btn-import")
    ?.addEventListener("click", triggerImport);
  document
    .getElementById("btn-dashboard-new-subject")
    ?.addEventListener("click", openAddSubjectModal);
  document
    .getElementById("btn-back-to-dashboard")
    ?.addEventListener("click", showDashboard);
  document
    .getElementById("btn-ws-export")
    ?.addEventListener("click", exportSubject);
  document.getElementById("btn-add-note")?.addEventListener("click", addBlock);
  document
    .getElementById("btn-connect-mode")
    ?.addEventListener("click", toggleConnectMode);
  document.getElementById("btn-reset-view")?.addEventListener("click", () => {
    camera.reset();
    toast("⊙", "View reset");
  });
  document
    .getElementById("btn-clear-canvas")
    ?.addEventListener("click", clearCanvas);
  document
    .querySelectorAll(".ws-tab")
    .forEach((tab) =>
      tab.addEventListener("click", () => switchWorkspaceTab(tab.dataset.tab)),
    );
  document
    .getElementById("subject-notes-area")
    ?.addEventListener("input", onNotesInput);
  document
    .getElementById("btn-upload-file")
    ?.addEventListener("click", () =>
      document.getElementById("file-input")?.click(),
    );
  document
    .getElementById("file-input")
    ?.addEventListener("change", handleFileUpload);
  document
    .getElementById("btn-add-link")
    ?.addEventListener("click", () => toggleResForm(true));
  document.getElementById("btn-save-link")?.addEventListener("click", saveLink);
  document
    .getElementById("btn-cancel-link")
    ?.addEventListener("click", () => toggleResForm(false));
  document
    .querySelectorAll(".res-type-btn")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        setResLinkType(btn, btn.dataset.type),
      ),
    );
  document
    .querySelectorAll(".res-filter-btn")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        setResFilter(btn, btn.dataset.filter),
      ),
    );

  /* ── Auth state observer — main app entry point ── */
  onAuthStateChanged(fbAuth, (user) => {
    if (user) onUserSignedIn(user);
    else {
      _currentUser = null;
      showAuthGate(true);
    }
  });
});

/* ── Expose functions called via inline onclick in dynamic HTML ── */
Object.assign(window, {
  toggleResFav,
  deleteResource,
  previewResource,
  openResource,
  openSubject,
  openAddSubjectModal,
  openEditSubjectModal,
  confirmDeleteSubject,
});
