/* ─────────────────────────────────────────────────────────
         IMPORTS  (Firebase v10 modular CDN — no npm required)
      ───────────────────────────────────────────────────────── */
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

      /* ─────────────────────────────────────────────────────────
         FIREBASE INITIALISATION
      ───────────────────────────────────────────────────────── */
      const firebaseConfig = {
        apiKey: "AIzaSyCWzwUc9dYgPsYlZnhFDD6W4Mat9IO2udQ",
        authDomain: "alumly-app.firebaseapp.com",
        projectId: "alumly-app",
        storageBucket: "alumly-app.firebasestorage.app",
        messagingSenderId: "98501411316",
        appId: "1:98501411316:web:11a4fca7f669c64c2c79a1",
      };
      const fbApp = initializeApp(firebaseConfig);
      const fbAuth = getAuth(fbApp);
      const fbDb = getFirestore(fbApp);
      const provider = new GoogleAuthProvider();

      /* ═══════════════════════════════════════════════════════════════
   SECTION 1 — STATE & PERSISTENCE
   ─────────────────────────────────────────────────────────────────
   Two modes:
     GUEST MODE  — localStorage only, no sign-in required.
     GOOGLE MODE — Firestore, real-time cloud sync, cross-device.

   isGuestMode flag drives all persistence decisions.
   save() is the single write call used by all other modules.
═══════════════════════════════════════════════════════════════ */
      const STORAGE_KEY = "alumly_guest_v1";
      const NOTE_COLORS = [
        "#7b6ef6",
        "#c8f564",
        "#f56464",
        "#64d6f5",
        "#f5c442",
        "#f564c8",
        "#64f596",
      ];
      const SUBJ_COLORS = [
        "#7b6ef6",
        "#c8f564",
        "#f56464",
        "#64d6f5",
        "#f5c442",
        "#f564c8",
        "#64f596",
        "#f5a064",
      ];
      const SUBJ_ICONS = [
        "📘",
        "📗",
        "📙",
        "📕",
        "📓",
        "📔",
        "🗂️",
        "💼",
        "🎓",
        "🧠",
        "🔬",
        "🧪",
        "💻",
        "📈",
        "🌍",
        "🎨",
      ];

      const POMODORO_PRESETS = {
        classic: { label: "25 / 5", workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15 },
        deep: { label: "50 / 10", workMinutes: 50, shortBreakMinutes: 10, longBreakMinutes: 20 },
      };
      let pomodoroInterval = null;
      let state = {
        subjects: [],
        currentSubjectId: null,
        pomodoro: defaultPomodoroState(),
      };
      let isGuestMode = false; // true while user chose "Continue as Guest"
      let currentUser = null; // Firebase Auth user, null in guest mode
      let unsubSnap = null; // Firestore listener unsubscribe handle
      let syncTimer = null; // Debounce handle for cloud writes
      let activeResourceId = null;
      let activeResourceFilter = "all";
      let reopenResourcesOverlayAfterSave = false;
      let resourceFocusMode = false;
      let pomodoroPanelOpen = false;
      let modalHidesTopbar = false;
      let activeCanvasNoteId = null;
      let canvasClipboard = null;
      let canvasEventsInitialized = false;
      let canvasFocusMode = false;
      let draggedSubjectId = null;
      let draggedSubjectDropIndex = null;
      let suppressSubjectCardClick = false;
      const canvasHistory = new Map();
      let dirtyCanvasSubjectIds = new Set();
      const persistedCanvasBySubject = new Map();
      const THEME_KEY = "alumly_theme_v1";
      const LOCAL_BACKUP_KEY = "alumly_local_backup_v1";
      let currentTheme = localStorage.getItem(THEME_KEY) || "dark";

      function applyTheme(theme) {
        currentTheme = theme === "light" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", currentTheme);
        localStorage.setItem(THEME_KEY, currentTheme);
      }

      function defaultPomodoroState() {
        const preset = POMODORO_PRESETS.classic;
        return {
          preset: "classic",
          mode: "work",
          workMinutes: preset.workMinutes,
          shortBreakMinutes: preset.shortBreakMinutes,
          longBreakMinutes: preset.longBreakMinutes,
          remainingMs: preset.workMinutes * 60000,
          isRunning: false,
          endTime: null,
          completedWorkSessions: 0,
          totalFocusMinutes: 0,
        };
      }

      function toggleTheme() {
        applyTheme(currentTheme === "dark" ? "light" : "dark");
        if (state.currentSubjectId) openSubject(state.currentSubjectId);
        else renderDashboard();
      }

      function themeToggleButtonHtml() {
        return `<button class="btn theme-btn" onclick="toggleTheme()">${currentTheme === "dark" ? "☀ Light" : "🌙 Dark"}</button>`;
      }

      applyTheme(currentTheme);

      function normalizePomodoro(raw = {}) {
        const presetKey =
          raw.preset && POMODORO_PRESETS[raw.preset] ? raw.preset : "classic";
        const preset = POMODORO_PRESETS[presetKey];
        const workMinutes = Number(raw.workMinutes) > 0 ? Number(raw.workMinutes) : preset.workMinutes;
        const shortBreakMinutes =
          Number(raw.shortBreakMinutes) > 0
            ? Number(raw.shortBreakMinutes)
            : preset.shortBreakMinutes;
        const longBreakMinutes =
          Number(raw.longBreakMinutes) > 0
            ? Number(raw.longBreakMinutes)
            : preset.longBreakMinutes;
        const mode = ["work", "shortBreak", "longBreak"].includes(raw.mode)
          ? raw.mode
          : "work";
        const fallbackMs =
          mode === "work"
            ? workMinutes * 60000
            : mode === "shortBreak"
              ? shortBreakMinutes * 60000
              : longBreakMinutes * 60000;
        const rawEndTime = Number(raw.endTime) || null;
        const hasExpiredRun =
          !!rawEndTime && !!raw.isRunning && rawEndTime <= Date.now();
        const endTime = hasExpiredRun
          ? Date.now()
          : rawEndTime && rawEndTime > Date.now()
            ? rawEndTime
            : null;
        return {
          preset: presetKey,
          mode,
          workMinutes,
          shortBreakMinutes,
          longBreakMinutes,
          remainingMs:
            hasExpiredRun
              ? 0
              : endTime != null
              ? Math.max(0, endTime - Date.now())
              : Number(raw.remainingMs) > 0
                ? Number(raw.remainingMs)
                : fallbackMs,
          isRunning: hasExpiredRun || (!!endTime && !!raw.isRunning),
          endTime,
          completedWorkSessions: Math.max(0, Number(raw.completedWorkSessions) || 0),
          totalFocusMinutes: Math.max(
            0,
            Number(raw.totalFocusMinutes) ||
              (Math.max(0, Number(raw.focusSessionPoints) || 0) * 25),
          ),
        };
      }

      function normalizeAppData(raw) {
        if (Array.isArray(raw)) {
          return {
            subjects: raw.map(normalizeSubject),
            pomodoro: defaultPomodoroState(),
          };
        }
        return {
          subjects: Array.isArray(raw?.subjects) ? raw.subjects.map(normalizeSubject) : [],
          pomodoro: normalizePomodoro(raw?.pomodoro),
        };
      }

      function serializeAppData(subjects = getPersistableSubjects()) {
        return {
          subjects,
          pomodoro: normalizePomodoro(state.pomodoro),
        };
      }

      function normalizeResource(item) {
        return {
          id: item.id || "res_" + Date.now(),
          type: item.type || "note",
          title: item.title || "",
          body: item.body || "",
          url: item.url || "",
          pinned: !!(item.pinned ?? item.fav),
          updatedAt: item.updatedAt || item.createdAt || Date.now(),
        };
      }

      function normalizeSubject(s) {
        const existingResources = Array.isArray(s.resources)
          ? s.resources.map((item) =>
              normalizeResource(
                item.type === "note" && !item.body
                  ? { ...item, body: item.body || item.url || "" }
                  : item,
              ),
            )
          : [];
        const migratedNotebookResources = Array.isArray(s.notebookNotes)
          ? s.notebookNotes.map((note) =>
              normalizeResource({
                id: note.id,
                type: "note",
                title: note.title,
                body: note.body,
                pinned: note.pinned,
                updatedAt: note.updatedAt,
              }),
            )
          : [];
        return {
          ...s,
          notes: Array.isArray(s.notes) ? s.notes : [],
          resources:
            existingResources.length > 0
              ? existingResources
              : migratedNotebookResources,
          connections: Array.isArray(s.connections) ? s.connections : [],
          priority: !!s.priority,
          isCompleted: !!s.isCompleted,
          emoji: s.emoji || "📘",
          viewport: {
            scale: s.viewport?.scale ?? 1,
            ox: s.viewport?.ox ?? 0,
            oy: s.viewport?.oy ?? 0,
          },
        };
      }
      function getSubject(id) {
        return state.subjects.find((s) => s.id === id) ?? null;
      }

      function canvasSnapshotForSubject(subject) {
        return {
          notes: JSON.parse(JSON.stringify(subject.notes || [])),
          connections: JSON.parse(JSON.stringify(subject.connections || [])),
          viewport: {
            scale: subject.viewport?.scale ?? 1,
            ox: subject.viewport?.ox ?? 0,
            oy: subject.viewport?.oy ?? 0,
          },
        };
      }

      function syncPersistedCanvasSubjects(subjects = state.subjects) {
        const activeIds = new Set((subjects || []).map((subject) => subject.id));
        (subjects || []).forEach((subject) => {
          persistedCanvasBySubject.set(
            subject.id,
            canvasSnapshotForSubject(subject),
          );
        });
        Array.from(persistedCanvasBySubject.keys()).forEach((id) => {
          if (!activeIds.has(id)) persistedCanvasBySubject.delete(id);
        });
      }

      function getPersistableSubjects(persistCanvasIds = []) {
        const allowedCanvasIds = new Set(persistCanvasIds);
        return state.subjects.map((subject) => {
          if (
            !dirtyCanvasSubjectIds.has(subject.id) ||
            allowedCanvasIds.has(subject.id)
          ) {
            return subject;
          }
          const snapshot =
            persistedCanvasBySubject.get(subject.id) ||
            canvasSnapshotForSubject({ notes: [], connections: [], viewport: {} });
          return {
            ...subject,
            notes: snapshot.notes,
            connections: snapshot.connections,
            viewport: snapshot.viewport,
          };
        });
      }

      function updateCanvasSaveUi() {
        const btn = document.getElementById("canvas-save-btn");
        const status = document.getElementById("canvas-save-status");
        const hasDirtyCanvas =
          !!state.currentSubjectId && dirtyCanvasSubjectIds.has(state.currentSubjectId);
        if (btn) {
          btn.classList.toggle("pending", hasDirtyCanvas);
          btn.textContent = "Finish & Save";
        }
        if (status) {
          status.textContent = hasDirtyCanvas
            ? "Canvas changes are only local until you save."
            : "Canvas is saved.";
        }
      }

      function markCanvasDirty(subjectId = state.currentSubjectId) {
        if (!subjectId) return;
        dirtyCanvasSubjectIds.add(subjectId);
        updateCanvasSaveUi();
      }

      function getCanvasHistoryState(subjectId = state.currentSubjectId) {
        if (!subjectId) return null;
        if (!canvasHistory.has(subjectId)) {
          canvasHistory.set(subjectId, { undo: [], redo: [] });
        }
        return canvasHistory.get(subjectId);
      }

      function cloneCanvasSnapshot(snapshot) {
        return JSON.parse(JSON.stringify(snapshot));
      }

      function pushCanvasHistory(subjectId = state.currentSubjectId) {
        const subject = getSubject(subjectId);
        if (!subject) return;
        const history = getCanvasHistoryState(subjectId);
        if (!history) return;
        const snapshot = cloneCanvasSnapshot(canvasSnapshotForSubject(subject));
        const last = history.undo[history.undo.length - 1];
        if (last && JSON.stringify(last) === JSON.stringify(snapshot)) return;
        history.undo.push(snapshot);
        if (history.undo.length > 80) history.undo.shift();
        history.redo = [];
      }

      function applyCanvasSnapshot(subjectId, snapshot) {
        const subject = getSubject(subjectId);
        if (!subject || !snapshot) return;
        subject.notes = cloneCanvasSnapshot(snapshot.notes || []);
        subject.connections = cloneCanvasSnapshot(snapshot.connections || []);
        subject.viewport = {
          scale: snapshot.viewport?.scale ?? 1,
          ox: snapshot.viewport?.ox ?? 0,
          oy: snapshot.viewport?.oy ?? 0,
        };
        activeCanvasNoteId = null;
        renderCanvas();
        renderSidebar();
        markCanvasDirty(subjectId);
      }

      function undoCanvas() {
        const subjectId = state.currentSubjectId;
        const subject = getSubject(subjectId);
        const history = getCanvasHistoryState(subjectId);
        if (!subject || !history?.undo.length) {
          showToast("↶", "Nothing to undo");
          return;
        }
        history.redo.push(cloneCanvasSnapshot(canvasSnapshotForSubject(subject)));
        const snapshot = history.undo.pop();
        applyCanvasSnapshot(subjectId, snapshot);
        showToast("↶", "Canvas change undone");
      }

      function redoCanvas() {
        const subjectId = state.currentSubjectId;
        const subject = getSubject(subjectId);
        const history = getCanvasHistoryState(subjectId);
        if (!subject || !history?.redo.length) {
          showToast("↷", "Nothing to redo");
          return;
        }
        history.undo.push(cloneCanvasSnapshot(canvasSnapshotForSubject(subject)));
        const snapshot = history.redo.pop();
        applyCanvasSnapshot(subjectId, snapshot);
        showToast("↷", "Canvas change restored");
      }

      function setActiveCanvasNote(noteId = null) {
        activeCanvasNoteId = noteId;
        document.querySelectorAll(".note").forEach((el) => {
          el.classList.toggle("selected", el.dataset.id === noteId);
        });
      }

      function getActiveCanvasNote() {
        const subject = getSubject(state.currentSubjectId);
        if (!subject || !activeCanvasNoteId) return null;
        return subject.notes.find((note) => note.id === activeCanvasNoteId) || null;
      }

      function copyCanvasNote() {
        const note = getActiveCanvasNote();
        if (!note) {
          showToast("📋", "Select a note to copy");
          return;
        }
        canvasClipboard = cloneCanvasSnapshot({
          notes: [note],
          connections: [],
          viewport: {},
        }).notes[0];
        showToast("📋", "Note copied");
      }

      function pasteCanvasNote() {
        const subject = getSubject(state.currentSubjectId);
        if (!subject || !canvasClipboard) {
          showToast("📋", "Nothing copied yet");
          return;
        }
        pushCanvasHistory();
        const source = cloneCanvasSnapshot({ notes: [canvasClipboard] }).notes[0];
        const duplicateIndex = subject.notes.filter((note) =>
          note.id.startsWith("note_"),
        ).length;
        const note = {
          ...source,
          id: "note_" + Date.now(),
          x: Math.round((source.x ?? 0) + 36),
          y: Math.round((source.y ?? 0) + 28),
        };
        if (!note.color) {
          note.color = NOTE_COLORS[duplicateIndex % NOTE_COLORS.length];
        }
        subject.notes.push(note);
        document.getElementById("canvas-empty").style.display = "none";
        _mountNote(note, false);
        setActiveCanvasNote(note.id);
        markCanvasDirty();
        showToast("📌", "Note pasted");
      }

      function finishAndSaveCanvas() {
        const subjectId = state.currentSubjectId;
        if (!subjectId) return;
        if (!dirtyCanvasSubjectIds.has(subjectId)) {
          showToast("💾", "Canvas is already saved");
          return;
        }
        save({ persistCanvasIds: [subjectId] });
        persistedCanvasBySubject.set(
          subjectId,
          canvasSnapshotForSubject(getSubject(subjectId) || {}),
        );
        dirtyCanvasSubjectIds.delete(subjectId);
        updateCanvasSaveUi();
        showToast("✅", "Canvas saved");
      }

      function persistLocalBackup(subjects = getPersistableSubjects()) {
        try {
          localStorage.setItem(
            LOCAL_BACKUP_KEY,
            JSON.stringify({
              savedAt: Date.now(),
              ...serializeAppData(subjects),
            }),
          );
        } catch (e) {
          console.warn("[Alumly] Local backup failed:", e);
        }
      }

      function loadLocalBackup() {
        try {
          const raw = localStorage.getItem(LOCAL_BACKUP_KEY);
          if (!raw) return null;
          const rawParsed = JSON.parse(raw);
          const parsed = normalizeAppData(rawParsed);
          return {
            savedAt: rawParsed.savedAt || null,
            subjects: parsed.subjects,
            pomodoro: parsed.pomodoro,
          };
        } catch (e) {
          console.warn("[Alumly] Local backup restore failed:", e);
          return null;
        }
      }

      function restoreFromLocalBackup(reason = "Recovered local backup") {
        const backup = loadLocalBackup();
        if (!backup) return false;
        state.subjects = backup.subjects || [];
        state.pomodoro = backup.pomodoro || defaultPomodoroState();
        dirtyCanvasSubjectIds.clear();
        syncPersistedCanvasSubjects();
        ensurePomodoroTicker();
        showToast("💾", reason, 3500);
        return true;
      }

      /* ── Guest persistence (localStorage) ── */
      function _guestSave(subjects = getPersistableSubjects()) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeAppData(subjects)));
          _showSyncBadge("local");
        } catch (e) {
          showToast("⚠️", "Local storage full — export your data", 4000);
        }
      }
      function _guestLoad() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = normalizeAppData(JSON.parse(raw));
            state.subjects = parsed.subjects;
            state.pomodoro = parsed.pomodoro;
            dirtyCanvasSubjectIds.clear();
            syncPersistedCanvasSubjects();
            ensurePomodoroTicker();
          }
        } catch (e) {
          /* start fresh */
        }
      }

      /* ── Cloud persistence (Firestore) ── */
      function scheduleCloudWrite(subjects = getPersistableSubjects()) {
        clearTimeout(syncTimer);
        _showSyncBadge("syncing");
        syncTimer = setTimeout(async () => {
          if (!currentUser) return;
          try {
            const ref = doc(fbDb, "users", currentUser.uid);
            await setDoc(ref, serializeAppData(subjects), { merge: false });
            _showSyncBadge("saved");
          } catch (err) {
            console.error("[Alumly] Firestore write:", err);
            _showSyncBadge("error");
            showToast("❌", "Cloud sync failed — check your connection", 4000);
          }
        }, 500);
      }
      function attachRealtimeListener(uid) {
        if (unsubSnap) unsubSnap();
        const ref = doc(fbDb, "users", uid);
        unsubSnap = onSnapshot(
          ref,
          (snap) => {
            if (!snap.exists()) return;
            const parsed = normalizeAppData(snap.data());
            state.subjects = parsed.subjects;
            state.pomodoro = parsed.pomodoro;
            dirtyCanvasSubjectIds.clear();
            syncPersistedCanvasSubjects();
            persistLocalBackup();
            ensurePomodoroTicker();
            renderSidebar();
            if (state.currentSubjectId) {
              getSubject(state.currentSubjectId)
                ? (renderCanvas(), renderResources())
                : renderDashboard();
            } else {
              renderDashboard();
            }
          },
          (err) => {
            console.error("[Alumly] onSnapshot:", err);
            _showSyncBadge("error");
          },
        );
      }

      /* ── Unified save() — routes to guest or cloud ── */
      function save(options = {}) {
        const subjects = getPersistableSubjects(options.persistCanvasIds || []);
        persistLocalBackup(subjects);
        isGuestMode ? _guestSave(subjects) : scheduleCloudWrite(subjects);
      }

      /* ── Sync badge ── */
      let _syncBadgeTimer = null;
      function _showSyncBadge(status) {
        const badge = document.getElementById("sync-badge");
        if (!badge) return;
        clearTimeout(_syncBadgeTimer);
        badge.className = "show " + status;
        const text = badge.querySelector(".sync-text");
        if (text)
          text.textContent =
            status === "syncing"
              ? "Syncing…"
              : status === "saved"
                ? "Saved to cloud"
                : status === "local"
                  ? "Saved locally"
                  : "Sync error";
        if (status !== "syncing")
          _syncBadgeTimer = setTimeout(
            () => badge.classList.remove("show"),
            3000,
          );
      }

      /* ═══════════════════════════════════════════════════════════════
   SECTION 1b — AUTHENTICATION  (Google + Guest)
═══════════════════════════════════════════════════════════════ */

      function _renderUserStrip(user) {
        const strip = document.getElementById("sidebar-user-strip");
        if (!strip) return;
        strip.style.display = "flex";
        if (isGuestMode) {
          strip.innerHTML = `<svg width="20" height="20" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;color:var(--text-3)">
               <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" stroke-width="1.5"/>
               <path d="M2 13c0-2.5 2.5-4 6-4s6 1.5 6 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
             </svg>
             <span class="sidebar-username">Guest</span>
             <span class="sidebar-guest-badge">Local</span>
             <button id="btn-signout" onclick="handleSignOut()" title="Sign in with Google">Sign in</button>`;
        } else {
          const photo = user && user.photoURL ? user.photoURL : "";
          const name = user ? user.displayName || user.email || "User" : "User";
          strip.innerHTML = `<img class="sidebar-avatar" src="${photo}" onerror="this.style.display='none'" alt=""/>
             <span class="sidebar-username">${escHtml(name)}</span>
             <button id="btn-signout" onclick="handleSignOut()" title="Sign out">Sign out</button>`;
        }
      }

      async function handleSignIn() {
        document.getElementById("auth-gate").classList.add("loading");
        try {
          await signInWithPopup(fbAuth, provider);
        } catch (err) {
          console.error("[Alumly] Sign-in error:", err);
          document.getElementById("auth-gate").classList.remove("loading");
          if (err.code !== "auth/popup-closed-by-user")
            showToast("❌", "Sign-in failed — please try again", 4000);
        }
      }

      function handleGuestLogin() {
        isGuestMode = true;
        _guestLoad();
        if (!state.subjects.length) {
          restoreFromLocalBackup("Recovered your latest local backup");
        }
        document.getElementById("auth-gate").classList.add("hidden");
        document.getElementById("app").classList.add("ready");
        _renderUserStrip(null);
        renderDashboard();
        _showSyncBadge("local");
        showToast("👤", "Running as Guest — data saved locally only", 3500);
      }

      async function handleSignOut() {
        if (unsubSnap) {
          unsubSnap();
          unsubSnap = null;
        }
        clearTimeout(syncTimer);
        const wasGuest = isGuestMode;
        state = {
          subjects: [],
          currentSubjectId: null,
          pomodoro: defaultPomodoroState(),
        };
        clearInterval(pomodoroInterval);
        pomodoroInterval = null;
        dirtyCanvasSubjectIds.clear();
        persistedCanvasBySubject.clear();
        isGuestMode = false;
        currentUser = null;
        document.getElementById("app").classList.remove("ready");
        document
          .getElementById("auth-gate")
          .classList.remove("hidden", "loading");
        const strip = document.getElementById("sidebar-user-strip");
        if (strip) strip.style.display = "none";
        if (!wasGuest) await signOut(fbAuth);
      }

      onAuthStateChanged(fbAuth, async (user) => {
        if (user) {
          isGuestMode = false;
          currentUser = user;
          let loadedFromCloud = false;
          try {
            const snap = await getDoc(doc(fbDb, "users", user.uid));
            if (snap.exists()) {
              const parsed = normalizeAppData(snap.data());
              state.subjects = parsed.subjects;
              state.pomodoro = parsed.pomodoro;
              dirtyCanvasSubjectIds.clear();
              syncPersistedCanvasSubjects();
              ensurePomodoroTicker();
              loadedFromCloud = true;
            }
          } catch (err) {
            console.error("[Alumly] Initial load:", err);
            restoreFromLocalBackup("Recovered your latest local backup");
          }
          if (!loadedFromCloud && !state.subjects.length) {
            restoreFromLocalBackup("Recovered your latest local backup");
          }
          attachRealtimeListener(user.uid);
          document.getElementById("auth-gate").classList.add("hidden");
          document.getElementById("app").classList.add("ready");
          _renderUserStrip(user);
          renderDashboard();
        } else if (!isGuestMode) {
          document.getElementById("app").classList.remove("ready");
          document
            .getElementById("auth-gate")
            .classList.remove("hidden", "loading");
          const strip = document.getElementById("sidebar-user-strip");
          if (strip) strip.style.display = "none";
        }
      });

      document
        .getElementById("btn-google-login")
        .addEventListener("click", handleSignIn);
      document
        .getElementById("btn-guest-login")
        .addEventListener("click", handleGuestLogin);
      window.addEventListener("beforeunload", () => persistLocalBackup());
      document.addEventListener("click", () => closePomodoroPanel());

      function getPomodoroDurationMs(mode = state.pomodoro.mode) {
        const timer = state.pomodoro;
        return (
          (mode === "work"
            ? timer.workMinutes
            : mode === "shortBreak"
              ? timer.shortBreakMinutes
              : timer.longBreakMinutes) * 60000
        );
      }

      function formatPomodoroTime(ms) {
        const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      }

      function pomodoroModeLabel(mode = state.pomodoro.mode) {
        return mode === "work"
          ? "Focus"
          : mode === "shortBreak"
            ? "Short Break"
            : "Long Break";
      }

      function pomodoroCyclesUntilLongBreak() {
        const remainder = state.pomodoro.completedWorkSessions % 4;
        return remainder === 0 ? 4 : 4 - remainder;
      }

      function formatFocusMinutes(minutes) {
        const safeMinutes = Math.max(0, Number(minutes) || 0);
        return `${safeMinutes} min`;
      }

      function syncPomodoroDom() {
        const timer = normalizePomodoro(state.pomodoro);
        state.pomodoro = timer;
        const remaining = timer.isRunning && timer.endTime
          ? Math.max(0, timer.endTime - Date.now())
          : timer.remainingMs;
        document.querySelectorAll("[data-pomodoro-time]").forEach((el) => {
          el.textContent = formatPomodoroTime(remaining);
        });
        document.querySelectorAll("[data-pomodoro-mode]").forEach((el) => {
          el.textContent = pomodoroModeLabel(timer.mode);
        });
        document.querySelectorAll("[data-pomodoro-status]").forEach((el) => {
          el.textContent = timer.isRunning ? "Running now" : "Ready to start";
        });
        document.querySelectorAll("[data-pomodoro-cycle]").forEach((el) => {
          el.textContent =
            timer.mode === "work"
              ? `Long break in ${pomodoroCyclesUntilLongBreak()} focus session${pomodoroCyclesUntilLongBreak() === 1 ? "" : "s"}`
              : `${timer.completedWorkSessions} focus session${timer.completedWorkSessions === 1 ? "" : "s"} finished`;
        });
        document.querySelectorAll("[data-pomodoro-start]").forEach((el) => {
          el.textContent = timer.isRunning ? "Pause" : "Start";
          el.classList.toggle("active", timer.isRunning);
        });
        document.querySelectorAll(".pomodoro-trigger").forEach((el) => {
          el.classList.toggle("running", timer.isRunning);
        });
        document.querySelectorAll("[data-pomodoro-root]").forEach((el) => {
          el.setAttribute("data-mode", timer.mode);
          el.classList.toggle("is-running", timer.isRunning);
        });
        document.querySelectorAll("[data-pomodoro-preset]").forEach((el) => {
          el.classList.toggle("active", el.dataset.pomodoroPreset === timer.preset);
        });
        document.querySelectorAll("[data-pomodoro-mode-chip]").forEach((el) => {
          el.classList.toggle("active", el.dataset.pomodoroModeChip === timer.mode);
        });
        document.querySelectorAll(".pomodoro-shell").forEach((el) => {
          el.classList.toggle("open", pomodoroPanelOpen);
        });
        document.querySelectorAll(".pomodoro-popover").forEach((el) => {
          el.classList.toggle("open", pomodoroPanelOpen);
        });
      }

      function handlePomodoroCompletion() {
        const timer = state.pomodoro;
        if (timer.mode === "work") {
          timer.completedWorkSessions += 1;
          timer.totalFocusMinutes += Math.max(0, Number(timer.workMinutes) || 0);
          timer.mode =
            timer.completedWorkSessions % 4 === 0 ? "longBreak" : "shortBreak";
          timer.remainingMs = getPomodoroDurationMs(timer.mode);
          showToast("🍅", "Focus session complete. Break time.");
        } else {
          timer.mode = "work";
          timer.remainingMs = getPomodoroDurationMs("work");
          showToast("✨", "Break complete. Ready for the next focus block.");
        }
        timer.isRunning = false;
        timer.endTime = null;
        syncPomodoroDom();
        save();
      }

      function pomodoroTick() {
        if (!state.pomodoro.isRunning || !state.pomodoro.endTime) {
          clearInterval(pomodoroInterval);
          pomodoroInterval = null;
          syncPomodoroDom();
          return;
        }
        const remaining = Math.max(0, state.pomodoro.endTime - Date.now());
        state.pomodoro.remainingMs = remaining;
        if (remaining <= 0) {
          handlePomodoroCompletion();
          return;
        }
        syncPomodoroDom();
      }

      function ensurePomodoroTicker() {
        syncPomodoroDom();
        if (state.pomodoro.isRunning && state.pomodoro.endTime) {
          if (!pomodoroInterval) {
            pomodoroInterval = setInterval(pomodoroTick, 1000);
          }
          pomodoroTick();
        } else if (pomodoroInterval) {
          clearInterval(pomodoroInterval);
          pomodoroInterval = null;
        }
      }

      function setPomodoroPreset(presetKey) {
        const preset = POMODORO_PRESETS[presetKey];
        if (!preset) return;
        state.pomodoro.preset = presetKey;
        state.pomodoro.workMinutes = preset.workMinutes;
        state.pomodoro.shortBreakMinutes = preset.shortBreakMinutes;
        state.pomodoro.longBreakMinutes = preset.longBreakMinutes;
        state.pomodoro.isRunning = false;
        state.pomodoro.endTime = null;
        state.pomodoro.remainingMs = getPomodoroDurationMs(state.pomodoro.mode);
        ensurePomodoroTicker();
      }

      function setPomodoroMode(mode) {
        if (!["work", "shortBreak", "longBreak"].includes(mode)) return;
        state.pomodoro.mode = mode;
        state.pomodoro.isRunning = false;
        state.pomodoro.endTime = null;
        state.pomodoro.remainingMs = getPomodoroDurationMs(mode);
        ensurePomodoroTicker();
      }

      function togglePomodoro() {
        const timer = state.pomodoro;
        if (timer.isRunning && timer.endTime) {
          timer.remainingMs = Math.max(0, timer.endTime - Date.now());
          timer.isRunning = false;
          timer.endTime = null;
        } else {
          timer.remainingMs = Math.max(
            1000,
            timer.remainingMs || getPomodoroDurationMs(timer.mode),
          );
          timer.isRunning = true;
          timer.endTime = Date.now() + timer.remainingMs;
          save();
        }
        ensurePomodoroTicker();
      }

      function resetPomodoro() {
        state.pomodoro.isRunning = false;
        state.pomodoro.endTime = null;
        state.pomodoro.remainingMs = getPomodoroDurationMs(state.pomodoro.mode);
        ensurePomodoroTicker();
      }

      function pomodoroTriggerHtml() {
        const timer = normalizePomodoro(state.pomodoro);
        const remaining = timer.isRunning && timer.endTime
          ? Math.max(0, timer.endTime - Date.now())
          : timer.remainingMs;
        return `
    <div class="pomodoro-shell ${pomodoroPanelOpen ? "open" : ""}" onclick="event.stopPropagation()">
      <button class="btn pomodoro-trigger ${timer.isRunning ? "running" : ""}" onclick="togglePomodoroPanel(event)">
        <span class="pomodoro-trigger-label">Pomodoro</span>
        <span class="pomodoro-trigger-time" data-pomodoro-time>${formatPomodoroTime(remaining)}</span>
      </button>
      <div class="pomodoro-popover ${pomodoroPanelOpen ? "open" : ""}">
        ${pomodoroPanelHtml()}
      </div>
    </div>`;
      }

      function pomodoroPanelHtml() {
        const timer = normalizePomodoro(state.pomodoro);
        const remaining = timer.isRunning && timer.endTime
          ? Math.max(0, timer.endTime - Date.now())
          : timer.remainingMs;
        return `
    <div class="pomodoro-card" data-pomodoro-root data-mode="${timer.mode}">
      <div class="pomodoro-head">
        <div>
          <div class="pomodoro-eyebrow">Pomodoro</div>
          <div class="pomodoro-mode" data-pomodoro-mode>${pomodoroModeLabel(timer.mode)}</div>
        </div>
        <div class="pomodoro-status" data-pomodoro-status>${timer.isRunning ? "Running now" : "Ready to start"}</div>
      </div>
      <div class="pomodoro-time" data-pomodoro-time>${formatPomodoroTime(remaining)}</div>
      <div class="pomodoro-actions">
        <button class="btn active" data-pomodoro-start onclick="togglePomodoro()">${timer.isRunning ? "Pause" : "Start"}</button>
        <button class="btn" onclick="resetPomodoro()">Reset</button>
      </div>
      <div class="pomodoro-modes">
        <button class="pomodoro-chip ${timer.mode === "work" ? "active" : ""}" data-pomodoro-mode-chip="work" onclick="setPomodoroMode('work')">Focus</button>
        <button class="pomodoro-chip ${timer.mode === "shortBreak" ? "active" : ""}" data-pomodoro-mode-chip="shortBreak" onclick="setPomodoroMode('shortBreak')">Short Break</button>
        <button class="pomodoro-chip ${timer.mode === "longBreak" ? "active" : ""}" data-pomodoro-mode-chip="longBreak" onclick="setPomodoroMode('longBreak')">Long Break</button>
      </div>
      <div class="pomodoro-presets">
        ${Object.entries(POMODORO_PRESETS)
          .map(
            ([key, preset]) =>
              `<button class="pomodoro-chip ${timer.preset === key ? "active" : ""}" data-pomodoro-preset="${key}" onclick="setPomodoroPreset('${key}')">${preset.label}</button>`,
          )
          .join("")}
      </div>
      <div class="pomodoro-meta" data-pomodoro-cycle>${
        timer.mode === "work"
          ? `Long break in ${pomodoroCyclesUntilLongBreak()} focus session${pomodoroCyclesUntilLongBreak() === 1 ? "" : "s"}`
          : `${timer.completedWorkSessions} focus session${timer.completedWorkSessions === 1 ? "" : "s"} finished`
      }</div>
    </div>`;
      }

      function togglePomodoroPanel(event) {
        if (event) event.stopPropagation();
        pomodoroPanelOpen = !pomodoroPanelOpen;
        syncPomodoroDom();
      }

      function closePomodoroPanel() {
        if (!pomodoroPanelOpen) return;
        pomodoroPanelOpen = false;
        syncPomodoroDom();
      }

      function syncCanvasFocusUi() {
        const panel = document.getElementById("canvas-panel");
        const isFocused = !!(
          panel &&
          document.fullscreenElement &&
          document.fullscreenElement === panel
        );
        canvasFocusMode = isFocused;
        panel?.classList.toggle("canvas-focus-mode", isFocused);
        const focusBtn = document.getElementById("canvas-focus-btn");
        if (focusBtn) focusBtn.textContent = isFocused ? "⤫ Exit Focus" : "⛶ Focus";
        const exitBtn = document.getElementById("canvas-focus-exit-btn");
        if (exitBtn) exitBtn.style.display = isFocused ? "inline-flex" : "none";
        updateCanvasMinimap();
      }

      async function toggleCanvasFocusMode() {
        const panel = document.getElementById("canvas-panel");
        if (!panel || !document.fullscreenEnabled) {
          showToast("⚠️", "Fullscreen is not available in this browser");
          return;
        }
        try {
          if (document.fullscreenElement === panel) {
            await document.exitFullscreen();
          } else {
            await panel.requestFullscreen();
          }
        } catch {
          showToast("❌", "Unable to switch canvas focus mode");
        }
        syncCanvasFocusUi();
      }

      function updateCanvasMinimap() {
        const panel = document.getElementById("canvas-panel");
        const stage = document.getElementById("canvas-minimap-stage");
        const notesLayer = document.getElementById("canvas-minimap-notes");
        const viewport = document.getElementById("canvas-minimap-viewport");
        const empty = document.getElementById("canvas-minimap-empty");
        const subject = getSubject(state.currentSubjectId);
        if (!panel || !stage || !notesLayer || !viewport || !empty || !subject) return;

        const notes = subject.notes || [];
        if (!notes.length) {
          notesLayer.innerHTML = "";
          viewport.style.display = "none";
          empty.style.display = "grid";
          return;
        }

        const panelRect = panel.getBoundingClientRect();
        const panelWorldW = Math.max(1, panelRect.width / camera.scale);
        const panelWorldH = Math.max(1, panelRect.height / camera.scale);
        const xs = notes.map((note) => [note.x, note.x + 240]).flat();
        const ys = notes.map((note) => [note.y, note.y + 140]).flat();
        xs.push((-camera.ox) / camera.scale, (-camera.ox) / camera.scale + panelWorldW);
        ys.push((-camera.oy) / camera.scale, (-camera.oy) / camera.scale + panelWorldH);
        const minX = Math.min(...xs) - 120;
        const maxX = Math.max(...xs) + 120;
        const minY = Math.min(...ys) - 120;
        const maxY = Math.max(...ys) + 120;
        const worldW = Math.max(1, maxX - minX);
        const worldH = Math.max(1, maxY - minY);
        const stageW = stage.clientWidth;
        const stageH = stage.clientHeight;

        notesLayer.innerHTML = notes
          .map((note) => {
            const left = ((note.x + 120 - minX) / worldW) * stageW;
            const top = ((note.y + 70 - minY) / worldH) * stageH;
            return `<div class="canvas-minimap-note" style="left:${left}px;top:${top}px;background:${note.color || "var(--accent)"}"></div>`;
          })
          .join("");

        const viewportLeft = (((-camera.ox) / camera.scale) - minX) / worldW * stageW;
        const viewportTop = (((-camera.oy) / camera.scale) - minY) / worldH * stageH;
        const viewportWidth = Math.min(stageW, panelWorldW / worldW * stageW);
        const viewportHeight = Math.min(stageH, panelWorldH / worldH * stageH);
        viewport.style.display = "block";
        viewport.style.left = `${viewportLeft}px`;
        viewport.style.top = `${viewportTop}px`;
        viewport.style.width = `${Math.max(18, viewportWidth)}px`;
        viewport.style.height = `${Math.max(14, viewportHeight)}px`;
        empty.style.display = "none";
      }

      /* ═══════════════════════════════════════════════════════════════
   SECTION 2 — CAMERA / INFINITE CANVAS ENGINE  ← UNTOUCHED
═══════════════════════════════════════════════════════════════ */

      const camera = {
        scale: 1,
        ox: 0, // offset x
        oy: 0, // offset y
        MIN_SCALE: 0.15,
        MAX_SCALE: 3.5,

        apply() {
          const world = document.getElementById("canvas-world");
          if (!world) return;
          world.style.transform = `translate(${this.ox}px, ${this.oy}px) scale(${this.scale})`;
          // Move dot grid with camera
          const panel = document.getElementById("canvas-panel");
          if (panel) {
            panel.style.setProperty("--grid-ox", (this.ox % 28) + "px");
            panel.style.setProperty("--grid-oy", (this.oy % 28) + "px");
          }
          const zd = document.getElementById("zoom-display");
          if (zd) zd.textContent = Math.round(this.scale * 100) + "%";
          updateCanvasMinimap();

          // Persist viewport
          const s = getSubject(state.currentSubjectId);
          if (s) s.viewport = { scale: this.scale, ox: this.ox, oy: this.oy };
        },

        // Convert screen coords → world coords
        toWorld(sx, sy) {
          return {
            x: (sx - this.ox) / this.scale,
            y: (sy - this.oy) / this.scale,
          };
        },

        // Zoom centred on screen point (sx, sy)
        zoomAt(sx, sy, delta) {
          const factor = delta > 0 ? 0.9 : 1.1;
          const newScale = Math.min(
            this.MAX_SCALE,
            Math.max(this.MIN_SCALE, this.scale * factor),
          );
          const scaleChange = newScale / this.scale;
          this.ox = sx - scaleChange * (sx - this.ox);
          this.oy = sy - scaleChange * (sy - this.oy);
          this.scale = newScale;
          this.apply();
        },

        reset() {
          this.scale = 1;
          this.ox = 0;
          this.oy = 0;
          this.apply();
          markCanvasDirty();
        },

        loadFrom(viewport) {
          if (!viewport) return;
          this.scale = viewport.scale ?? 1;
          this.ox = viewport.ox ?? 0;
          this.oy = viewport.oy ?? 0;
          this.apply();
        },
      };

      // ── Canvas interaction state ──
      const pan = { active: false, sx: 0, sy: 0, ox0: 0, oy0: 0 };
      const drag = {
        active: false,
        noteId: null,
        sx: 0,
        sy: 0,
        nx0: 0,
        ny0: 0,
        snapshot: null,
      };
      let spaceDown = false;

      function initCanvasEvents() {
        const panel = document.getElementById("canvas-panel");
        if (!panel || canvasEventsInitialized) return;
        canvasEventsInitialized = true;

        // Ctrl + scroll → zoom
        panel.addEventListener(
          "wheel",
          (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            camera.zoomAt(
              e.clientX - rect.left,
              e.clientY - rect.top,
              e.deltaY,
            );
            markCanvasDirty();
          },
          { passive: false },
        );

        // Space + drag → pan
        panel.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          if (e.target === panel || e.target.id === "canvas-world") {
            setActiveCanvasNote(null);
          }
          if (spaceDown && !drag.active) {
            pan.active = true;
            pan.sx = e.clientX;
            pan.sy = e.clientY;
            pan.ox0 = camera.ox;
            pan.oy0 = camera.oy;
            panel.classList.add("panning");
            e.preventDefault();
          }
        });

        document.addEventListener("mousemove", (e) => {
          if (pan.active) {
            camera.ox = pan.ox0 + (e.clientX - pan.sx);
            camera.oy = pan.oy0 + (e.clientY - pan.sy);
            camera.apply();
          }
          if (drag.active) {
            const rect = panel.getBoundingClientRect();
            const wx = (e.clientX - rect.left - camera.ox) / camera.scale;
            const wy = (e.clientY - rect.top - camera.oy) / camera.scale;
            const newX = wx - drag.nx0;
            const newY = wy - drag.ny0;
            const el = document.querySelector(
              `.note[data-id="${drag.noteId}"]`,
            );
            if (el) {
              el.style.left = newX + "px";
              el.style.top = newY + "px";
            }
            updateConnections();
            updateCanvasMinimap();
          }
        });

        document.addEventListener("mouseup", (e) => {
          if (pan.active) {
            pan.active = false;
            panel.classList.remove("panning");
            markCanvasDirty();
          }
          if (drag.active) {
            // persist final position
            const s = getSubject(state.currentSubjectId);
            if (s) {
              const note = s.notes.find((n) => n.id === drag.noteId);
              const el = document.querySelector(
                `.note[data-id="${drag.noteId}"]`,
              );
              if (note && el) {
                note.x = parseInt(el.style.left);
                note.y = parseInt(el.style.top);
              }
              if (drag.snapshot) {
                const before = JSON.stringify(drag.snapshot);
                const after = JSON.stringify(canvasSnapshotForSubject(s));
                if (before !== after) {
                  const history = getCanvasHistoryState(state.currentSubjectId);
                  history.undo.push(drag.snapshot);
                  if (history.undo.length > 80) history.undo.shift();
                  history.redo = [];
                }
              }
            }
            const el = document.querySelector(
              `.note[data-id="${drag.noteId}"]`,
            );
            if (el) el.classList.remove("dragging");
            drag.active = false;
            drag.noteId = null;
            drag.snapshot = null;
            markCanvasDirty();
          }
        });

        // Right-click context menu
        panel.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showCtxMenu(e.clientX, e.clientY, [
            { icon: "⊙", label: "Reset View", action: resetView },
            {
              icon: "＋",
              label: "Add Note Here",
              action: () => addNoteAt(e.clientX, e.clientY),
            },
            { type: "sep" },
            {
              icon: "🗑",
              label: "Clear Canvas",
              action: clearCanvas,
              danger: true,
            },
          ]);
        });

        // Space key
        document.addEventListener("keydown", (e) => {
          const targetTag = e.target.tagName;
          const isTypingTarget =
            targetTag === "TEXTAREA" ||
            targetTag === "INPUT" ||
            e.target.isContentEditable;
          const shortcutKey = e.ctrlKey || e.metaKey;
          if (
            e.code === "Space" &&
            !isTypingTarget
          ) {
            e.preventDefault();
            spaceDown = true;
            if (!pan.active) panel.classList.add("pan-ready");
          }
          if (!isTypingTarget && state.currentSubjectId) {
            if (e.key === "n" || e.key === "N") {
              e.preventDefault();
              addNote();
              return;
            }
            if (e.key === "r" || e.key === "R") {
              e.preventDefault();
              resetView();
              return;
            }
            if (e.key === "w" || e.key === "W") {
              e.preventDefault();
              openResourcesOverlay();
              return;
            }
            if (shortcutKey && (e.key === "c" || e.key === "C")) {
              if (!isTypingTarget) {
                e.preventDefault();
                copyCanvasNote();
                return;
              }
            }
            if (shortcutKey && (e.key === "v" || e.key === "V")) {
              if (!isTypingTarget) {
                e.preventDefault();
                pasteCanvasNote();
                return;
              }
            }
            if (shortcutKey && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
              if (!isTypingTarget) {
                e.preventDefault();
                undoCanvas();
                return;
              }
            }
            if (
              shortcutKey &&
              ((e.key === "y" || e.key === "Y") ||
                (e.shiftKey && (e.key === "z" || e.key === "Z")))
            ) {
              if (!isTypingTarget) {
                e.preventDefault();
                redoCanvas();
                return;
              }
            }
          }
          if (e.key === "Escape") {
            if (
              document.getElementById("canvas-panel") &&
              document.fullscreenElement === document.getElementById("canvas-panel")
            ) {
              toggleCanvasFocusMode();
              return;
            }
            closeModal();
            closeCtxMenu();
            if (connectMode.active) toggleConnectMode();
            setActiveCanvasNote(null);
          }
        });
        document.addEventListener("keyup", (e) => {
          if (e.code === "Space") {
            spaceDown = false;
            panel.classList.remove("pan-ready");
          }
        });

        // Click anywhere → close ctx menu
        document.addEventListener("click", () => closeCtxMenu());
      }

      function resetView() {
        pushCanvasHistory();
        camera.reset();
        showToast("⊙", "View reset");
      }

      /* ═══════════════════════════════════════════════════════════════
   SECTION 3 — NOTE SYSTEM  ← UNTOUCHED
═══════════════════════════════════════════════════════════════ */

      function renderCanvas() {
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        const world = document.getElementById("canvas-world");
        if (!s.notes.find((note) => note.id === activeCanvasNoteId)) {
          activeCanvasNoteId = null;
        }

        // Remove all notes (keep svg)
        world.querySelectorAll(".note").forEach((n) => n.remove());

        document.getElementById("canvas-empty").style.display = s.notes.length
          ? "none"
          : "flex";

        s.notes.forEach((n) => _mountNote(n));
        renderConnections();
        camera.loadFrom(s.viewport);
        updateCanvasSaveUi();
        setActiveCanvasNote(activeCanvasNoteId);
        updateCanvasMinimap();
      }

      function addNote() {
        // Place in centre of current view
        const panel = document.getElementById("canvas-panel");
        const rect = panel.getBoundingClientRect();
        addNoteAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
      }

      function addNoteAt(screenX, screenY) {
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        pushCanvasHistory();
        const panel = document.getElementById("canvas-panel");
        const rect = panel.getBoundingClientRect();
        const wx = (screenX - rect.left - camera.ox) / camera.scale - 90;
        const wy = (screenY - rect.top - camera.oy) / camera.scale - 40;

        const note = {
          id: "note_" + Date.now(),
          x: Math.round(wx),
          y: Math.round(wy),
          text: "",
          color: NOTE_COLORS[s.notes.length % NOTE_COLORS.length],
        };
        s.notes.push(note);
        document.getElementById("canvas-empty").style.display = "none";
        _mountNote(note, true);
        setActiveCanvasNote(note.id);
        markCanvasDirty();
        updateCanvasMinimap();
      }

      function _mountNote(note, focusOnMount = false) {
        const el = document.createElement("div");
        el.className = "note";
        el.dataset.id = note.id;
        el.style.left = note.x + "px";
        el.style.top = note.y + "px";
        el.style.setProperty("--note-color", note.color);

        el.innerHTML = `
    <div class="note-bar" style="background:${note.color}"></div>
    <div class="note-body">
      <textarea class="note-text" placeholder="Type your thoughts…">${escHtml(note.text)}</textarea>
    </div>
    <div class="note-footer">
      <div class="note-colors">
        ${NOTE_COLORS.map(
          (c) => `
          <div class="note-color-dot" style="background:${c}"
               onclick="changeNoteColor('${note.id}','${c}')"></div>
        `,
        ).join("")}
      </div>
      <div class="note-btns">
        <button class="note-btn" id="nb-conn-${note.id}"
                onclick="handleNoteConnect('${note.id}')"
                title="Connect to another note">⟷</button>
        <button class="note-btn"
                onclick="deleteNote('${note.id}')"
                title="Delete note">🗑</button>
      </div>
    </div>`;

        const ta = el.querySelector(".note-text");
        ta.addEventListener("input", () => {
          pushCanvasHistory();
          updateNoteText(note.id, ta.value);
          _autoResize(ta);
        });
        ta.addEventListener("mousedown", (e) => e.stopPropagation());
        ta.addEventListener("focus", () => setActiveCanvasNote(note.id));
        _autoResize(ta);

        // Drag on note (but not when in connect mode)
        el.addEventListener("mousedown", (e) => {
          if (
            e.target.tagName === "TEXTAREA" ||
            e.target.tagName === "BUTTON" ||
            e.target.classList.contains("note-color-dot")
          )
            return;
          if (spaceDown) return; // let canvas pan take over
          if (connectMode.active) {
            handleNoteConnect(note.id);
            return;
          }
          e.preventDefault();
          setActiveCanvasNote(note.id);
          drag.active = true;
          drag.noteId = note.id;
          drag.snapshot = cloneCanvasSnapshot(canvasSnapshotForSubject(getSubject(state.currentSubjectId)));
          const panel = document.getElementById("canvas-panel");
          const rect = panel.getBoundingClientRect();
          const wx = (e.clientX - rect.left - camera.ox) / camera.scale;
          const wy = (e.clientY - rect.top - camera.oy) / camera.scale;
          drag.nx0 = wx - note.x;
          drag.ny0 = wy - note.y;
          el.classList.add("dragging");
        });

        document.getElementById("canvas-world").appendChild(el);
        if (focusOnMount) {
          setActiveCanvasNote(note.id);
          ta.focus();
        }
      }

      function _autoResize(ta) {
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
      }

      function updateNoteText(id, text) {
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        const n = s.notes.find((n) => n.id === id);
        if (n) {
          n.text = text;
          markCanvasDirty();
        }
      }

      function changeNoteColor(id, color) {
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        const n = s.notes.find((n) => n.id === id);
        if (n) {
          if (n.color === color) return;
          pushCanvasHistory();
          n.color = color;
        }
        const el = document.querySelector(`.note[data-id="${id}"]`);
        if (el) {
          el.style.setProperty("--note-color", color);
          el.querySelector(".note-bar").style.background = color;
        }
        markCanvasDirty();
        updateCanvasMinimap();
      }

      function deleteNote(id) {
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        pushCanvasHistory();
        // Remove connections involving this note
        s.connections = s.connections.filter(
          (c) => c.from !== id && c.to !== id,
        );
        s.notes = s.notes.filter((n) => n.id !== id);
        const el = document.querySelector(`.note[data-id="${id}"]`);
        if (el) {
          el.style.transition = "opacity 0.12s, transform 0.12s";
          el.style.opacity = "0";
          el.style.transform = "scale(0.85)";
          setTimeout(() => el.remove(), 130);
        }
        if (activeCanvasNoteId === id) setActiveCanvasNote(null);
        if (!s.notes.length)
          document.getElementById("canvas-empty").style.display = "flex";
        renderConnections();
        markCanvasDirty();
        updateCanvasMinimap();
      }

      function clearCanvas() {
        const s = getSubject(state.currentSubjectId);
        if (!s || !s.notes.length) {
          showToast("ℹ️", "Canvas is already empty");
          return;
        }
        showModal(`
    <h2>🗑 Clear Canvas?</h2>
    <p style="color:var(--muted);font-size:13.5px;margin-bottom:20px;">
      Remove all <strong style="color:var(--text)">${s.notes.length}</strong> note(s)
      and <strong style="color:var(--text)">${s.connections.length}</strong> connection(s)?
      This cannot be undone.
    </p>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" style="background:var(--danger)"
              onclick="_confirmClear()">Clear All</button>
    </div>
  `);
      }

      function _confirmClear() {
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        pushCanvasHistory();
        s.notes = [];
        s.connections = [];
        setActiveCanvasNote(null);
        markCanvasDirty();
        closeModal();
        document
          .getElementById("canvas-world")
          .querySelectorAll(".note")
          .forEach((n) => n.remove());
        document.getElementById("conn-svg").innerHTML = "";
        document.getElementById("canvas-empty").style.display = "flex";
        updateCanvasMinimap();
        showToast("🗑", "Canvas cleared");
      }

      /* ═══════════════════════════════════════════════════════════════
   SECTION 4 — NOTE CONNECTIONS (SVG OVERLAY)  ← UNTOUCHED
═══════════════════════════════════════════════════════════════ */

      const connectMode = {
        active: false,
        fromId: null,
      };

      function toggleConnectMode() {
        connectMode.active = !connectMode.active;
        connectMode.fromId = null;
        const btn = document.getElementById("connect-btn");
        const hint = document.getElementById("conn-hint");
        if (btn) btn.classList.toggle("connect-mode", connectMode.active);
        if (hint) hint.style.display = connectMode.active ? "block" : "none";
        // Unhighlight all notes
        document
          .querySelectorAll(".note.connecting-source")
          .forEach((n) => n.classList.remove("connecting-source"));
      }

      function handleNoteConnect(noteId) {
        if (!connectMode.active) {
          toggleConnectMode();
        }
        if (!connectMode.active) return;
        if (!connectMode.fromId) {
          connectMode.fromId = noteId;
          const el = document.querySelector(`.note[data-id="${noteId}"]`);
          if (el) el.classList.add("connecting-source");
          showToast("⟷", "Select another note to connect");
          return;
        }
        if (connectMode.fromId === noteId) {
          // Deselect
          const el = document.querySelector(`.note[data-id="${noteId}"]`);
          if (el) el.classList.remove("connecting-source");
          connectMode.fromId = null;
          return;
        }
        // Add connection
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        const dup = s.connections.find(
          (c) =>
            (c.from === connectMode.fromId && c.to === noteId) ||
            (c.from === noteId && c.to === connectMode.fromId),
        );
        if (!dup) {
          pushCanvasHistory();
          s.connections.push({
            id: "conn_" + Date.now(),
            from: connectMode.fromId,
            to: noteId,
          });
          renderConnections();
          markCanvasDirty();
          showToast("⟷", "Notes connected");
        } else {
          showToast("ℹ️", "Already connected");
        }
        // Reset
        document
          .querySelector(`.note[data-id="${connectMode.fromId}"]`)
          ?.classList.remove("connecting-source");
        connectMode.fromId = null;
        toggleConnectMode();
      }

      function _getNoteCentre(noteId) {
        const el = document.querySelector(`.note[data-id="${noteId}"]`);
        if (!el) return null;
        const left = parseFloat(el.style.left) || 0;
        const top = parseFloat(el.style.top) || 0;
        return {
          x: left + el.offsetWidth / 2,
          y: top + el.offsetHeight / 2,
        };
      }

      function renderConnections() {
        const svg = document.getElementById("conn-svg");
        if (!svg) return;
        svg.innerHTML = "";
        const s = getSubject(state.currentSubjectId);
        if (!s) return;

        s.connections.forEach((conn) => {
          const a = _getNoteCentre(conn.from);
          const b = _getNoteCentre(conn.to);
          if (!a || !b) return;

          const mx = (a.x + b.x) / 2;
          const cp1 = { x: mx, y: a.y };
          const cp2 = { x: mx, y: b.y };

          const path = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path",
          );
          path.setAttribute("class", "conn-path");
          path.dataset.connId = conn.id;
          path.setAttribute(
            "d",
            `M ${a.x} ${a.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${b.x} ${b.y}`,
          );
          // Right-click to delete
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

      function updateConnections() {
        // Called while dragging — re-draw all paths without hitting state
        renderConnections();
      }

      function deleteConnection(connId) {
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        pushCanvasHistory();
        s.connections = s.connections.filter((c) => c.id !== connId);
        renderConnections();
        markCanvasDirty();
        showToast("🗑", "Connection removed");
      }

      /* ═══════════════════════════════════════════════════════════════
   SECTION 5 — SUBJECT NOTEBOOK
═══════════════════════════════════════════════════════════════ */

      function getResourceState() {
        return getSubject(state.currentSubjectId);
      }

      function getActiveResource(subject) {
        if (!subject || !activeResourceId) return null;
        return (
          (subject.resources || []).find(
            (item) => item.id === activeResourceId,
          ) || null
        );
      }

      function setResourceFilter(type) {
        activeResourceFilter = type;
        renderResources();
      }

      function syncResourceFocusUi() {
        const shell = document.getElementById("resource-center-shell");
        const btn = document.getElementById("resource-focus-btn");
        const isFullscreen = !!(
          shell &&
          document.fullscreenElement &&
          document.fullscreenElement === shell
        );
        resourceFocusMode = isFullscreen;
        if (shell) shell.classList.toggle("focus-mode-active", isFullscreen);
        if (btn) btn.textContent = isFullscreen ? "Exit Focus" : "Focus Mode";
      }

      async function toggleResourceFocusMode() {
        const shell = document.getElementById("resource-center-shell");
        if (!shell || !document.fullscreenEnabled) {
          showToast("⚠️", "Fullscreen is not available in this browser");
          return;
        }
        try {
          if (document.fullscreenElement === shell)
            await document.exitFullscreen();
          else await shell.requestFullscreen();
        } catch {
          showToast("❌", "Unable to switch fullscreen mode");
        }
        syncResourceFocusUi();
      }

      function exitResourceFocusMode() {
        const shell = document.getElementById("resource-center-shell");
        if (shell && document.fullscreenElement === shell) {
          document.exitFullscreen().catch(() => {});
        }
        resourceFocusMode = false;
        if (shell) shell.classList.remove("focus-mode-active");
        const btn = document.getElementById("resource-focus-btn");
        if (btn) btn.textContent = "Focus Mode";
      }

      function resourceTypeMeta(type) {
        return (
          {
            note: { icon: "📝", label: "Note" },
            link: { icon: "🔗", label: "Link" },
            app: { icon: "🧩", label: "App" },
            video: { icon: "▶️", label: "Video" },
          }[type] || { icon: "📦", label: "Resource" }
        );
      }

      function renderResources() {
        const s = getResourceState();
        if (!s) return;
        const allResources = [...(s.resources || [])].sort((a, b) => {
          if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        });
        const items =
          activeResourceFilter === "all"
            ? allResources
            : allResources.filter((item) => item.type === activeResourceFilter);
        const summary = document.getElementById("resource-summary");
        const row = document.getElementById("resource-type-row");
        const strip = document.getElementById("resource-strip");
        const detail = document.getElementById("resource-detail-panel");
        if (!summary || !row || !strip || !detail) return;

        if (!getActiveResource(s) && allResources.length) {
          activeResourceId = allResources[0].id;
        }
        let active = getActiveResource(s);
        if (
          items.length &&
          (!active || !items.find((item) => item.id === active.id))
        ) {
          activeResourceId = items[0].id;
          active = getActiveResource(s);
        }

        const counts = {
          all: allResources.length,
          note: allResources.filter((item) => item.type === "note").length,
          link: allResources.filter((item) => item.type === "link").length,
          app: allResources.filter((item) => item.type === "app").length,
          video: allResources.filter((item) => item.type === "video").length,
        };

        summary.innerHTML = `
          <div class="summary-pill"><span class="summary-label">Resources</span><span class="summary-value">${counts.all}</span></div>
          <div class="summary-pill"><span class="summary-label">Pinned</span><span class="summary-value">${allResources.filter((item) => item.pinned).length}</span></div>
          <div class="summary-pill"><span class="summary-label">Notes</span><span class="summary-value">${counts.note}</span></div>
          <div class="summary-pill"><span class="summary-label">External</span><span class="summary-value">${counts.link + counts.app + counts.video}</span></div>`;

        row.innerHTML = ["all", "note", "link", "app", "video"]
          .map((type) => {
            const meta =
              type === "all"
                ? { icon: "📚", label: "All" }
                : resourceTypeMeta(type);
            const count = counts[type] ?? counts.all;
            return `<button class="resource-type-btn ${activeResourceFilter === type ? "active" : ""}"
              onclick="setResourceFilter('${type}')">${meta.icon} ${meta.label} ${count}</button>`;
          })
          .join("");

        if (!items.length) {
          strip.innerHTML = `
            <div class="resource-empty">
              <div class="resource-empty-icon">📚</div>
              <strong>No ${activeResourceFilter === "all" ? "resources" : activeResourceFilter + "s"} yet</strong>
              <div>Add notes, links, app shortcuts, or videos for this subject.</div>
            </div>`;
          detail.innerHTML = emptyResourceDetail();
        } else {
          strip.innerHTML = items
            .map((item) => resourceCardHtml(item, s.color))
            .join("");
          detail.innerHTML = resourceDetailHtml(active, s);
        }
        syncResourceFocusUi();
      }

      function openResourcesOverlay() {
        reopenResourcesOverlayAfterSave = true;
        resourceFocusMode = false;
        showModal(
          `
    <div class="resource-center" id="resource-center-shell">
      <aside class="resource-center-sidebar">
        <div class="resource-overlay-copy">
          <h2 style="margin-bottom:0;">Resource Center</h2>
          <p>Collect working notes, references, media, and shortcuts in one premium knowledge space.</p>
        </div>
        <div class="resource-center-summary" id="resource-summary"></div>
        <div class="resource-type-row" id="resource-type-row"></div>
        <div class="resource-list-scroll" id="resource-strip"></div>
      </aside>
      <section class="resource-center-main">
        <div class="resource-center-header">
          <div class="resource-center-title">
            <h2 style="margin-bottom:0;">Focused Workspace</h2>
            <p>Review resources in a calmer, document-first environment designed for deeper work.</p>
          </div>
          <div class="resource-center-actions">
            <button class="btn-sm btn-ghost" id="resource-focus-btn" onclick="toggleResourceFocusMode()">Focus Mode</button>
            <button class="btn-sm btn-primary" onclick="openAddResourceModal()">＋ Add Resource</button>
            <button class="btn-sm btn-ghost" onclick="closeModal()">Close</button>
          </div>
        </div>
        <div class="resource-detail" id="resource-detail-panel"></div>
      </section>
    </div>
  `,
          "modal-immersive",
          { hideTopbar: true },
        );
        renderResources();
      }

      function emptyResourceDetail() {
        return `
          <div class="resource-empty-state">
            <div class="resource-empty-icon">✦</div>
            <strong>Build your resource system</strong>
            <div>Create a polished document, save a university link, or store a key video so everything stays connected to the subject.</div>
            <button class="btn-sm btn-primary" onclick="openAddResourceModal()">＋ Add Resource</button>
          </div>`;
      }

      function resourceDetailHtml(item, subject) {
        if (!item) return emptyResourceDetail();
        const meta = resourceTypeMeta(item.type);
        const body =
          item.type === "note"
            ? `<div class="resource-document-surface">
                 <h3>Document Preview</h3>
                 <div class="resource-document-text">${escHtml(item.body || "Empty note").replace(/\n/g, "<br>")}</div>
               </div>`
            : `<div class="resource-document-surface resource-link-preview">
                 <h3>${meta.label} Reference</h3>
                 <div class="resource-document-text">${escHtml(item.title || meta.label)}</div>
                 <a href="${escAttr(item.url || "#")}" target="_blank" rel="noopener">${escHtml(item.url || "No link available")}</a>
               </div>`;
        return `
          <div class="resource-detail-card">
            <div class="resource-detail-hero">
              <div>
                <div class="resource-detail-kicker">${meta.icon} ${meta.label}${item.pinned ? " • Pinned" : ""}</div>
                <div class="resource-detail-title">${escHtml(item.title || meta.label)}</div>
                <div class="resource-detail-meta">${fmtNoteDate(item.updatedAt)} • ${(subject.resources || []).length} total resources in this subject</div>
              </div>
              <div class="resource-detail-actions">
                <button class="btn" onclick="openEditResourceModal('${item.id}')">${item.type === "note" ? "Edit Document" : "Edit Resource"}</button>
                ${
                  item.type === "note"
                    ? `<button class="btn accent" onclick="exportResourcePdf('${item.id}')">Export PDF</button>`
                    : `<button class="btn accent" onclick="window.open('${escAttr(item.url || "#")}', '_blank', 'noopener,noreferrer')">Open</button>`
                }
                <button class="btn" onclick="toggleResourcePin('${item.id}')">${item.pinned ? "Unpin" : "Pin"}</button>
                <button class="btn danger" onclick="deleteResourceItem('${item.id}')">Delete</button>
              </div>
            </div>
            <div class="resource-detail-body">
              ${body}
            </div>
          </div>`;
      }

      function resourceCardHtml(item, color) {
        const meta = resourceTypeMeta(item.type);
        return `
          <div class="resource-card ${item.id === activeResourceId ? "active" : ""}" style="--subject-color:${color}"
            onclick="openResource('${item.id}')">
            <div class="resource-card-row">
              <div class="resource-card-type">${meta.icon}</div>
              <div class="resource-card-main">
                <div class="resource-card-title">${escHtml(item.title || meta.label)}</div>
                <div class="resource-card-meta">${meta.label}${item.pinned ? " • Pinned" : ""}</div>
              </div>
              <div class="resource-card-actions">
                <button class="resource-card-action ${item.pinned ? "active" : ""}" onclick="event.stopPropagation();toggleResourcePin('${item.id}')" title="Pin">★</button>
                <button class="resource-card-action" onclick="event.stopPropagation();openEditResourceModal('${item.id}')" title="Edit">✎</button>
                <button class="resource-card-action danger" onclick="event.stopPropagation();deleteResourceItem('${item.id}')" title="Delete">🗑</button>
              </div>
            </div>
          </div>`;
      }

      function fmtNoteDate(ts) {
        if (!ts) return "Just now";
        return new Intl.DateTimeFormat("en", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(ts));
      }

      function openResource(id) {
        const s = getResourceState();
        if (!s) return;
        const item = (s.resources || []).find((res) => res.id === id);
        if (!item) return;
        activeResourceId = id;
        if (document.getElementById("resource-detail-panel")) {
          renderResources();
          return;
        }
        if (item.url) {
          window.open(item.url, "_blank", "noopener,noreferrer");
        }
        renderResources();
      }

      function openAddResourceModal(type = "note") {
        reopenResourcesOverlayAfterSave =
          !!document.getElementById("resource-summary");
        showResourceModal({
          id: "",
          type,
          title: "",
          body: "",
          url: "",
          pinned: false,
        });
      }

      function openEditResourceModal(id) {
        const s = getResourceState();
        if (!s) return;
        const item = (s.resources || []).find((res) => res.id === id);
        if (!item) return;
        activeResourceId = id;
        reopenResourcesOverlayAfterSave =
          !!document.getElementById("resource-summary");
        showResourceModal(item);
      }

      function showResourceModal(item) {
        const meta = resourceTypeMeta(item.type);
        showModal(
          `
    <h2>${item.id ? "Edit" : "New"} ${meta.label}</h2>
    <input type="hidden" id="m-resource-id" value="${escAttr(item.id || "")}" />
    <input type="hidden" id="m-resource-type" value="${escAttr(item.type)}" />
    <div class="modal-field">
      <label class="modal-label">Type</label>
      <div class="resource-type-row" id="m-resource-type-row">
        ${["note", "link", "app", "video"]
          .map((type) => {
            const tMeta = resourceTypeMeta(type);
            return `<button type="button" class="resource-type-btn ${item.type === type ? "active" : ""}" onclick="setResourceModalType(this, '${type}')">${tMeta.icon} ${tMeta.label}</button>`;
          })
          .join("")}
      </div>
    </div>
    <div class="modal-field">
      <label class="modal-label">Title</label>
      <input class="modal-input" id="m-resource-title" value="${escAttr(item.title || "")}" placeholder="${meta.label} title" />
    </div>
    <div class="modal-field ${item.type === "note" ? "" : "hidden-resource-body"}" id="m-resource-body-wrap">
      <label class="modal-label">Content</label>
      <textarea class="modal-input resource-note-input ${item.type === "note" ? "doc-style" : ""}" id="m-resource-body">${escHtml(item.body || "")}</textarea>
      <div class="modal-help">${item.type === "note" ? "Designed like a premium writing surface for long-form thinking and polished drafts." : "Keep this concise and clear for fast scanning later."}</div>
    </div>
    <div class="modal-field ${item.type === "note" ? "hidden-resource-url" : ""}" id="m-resource-url-wrap">
      <label class="modal-label">URL</label>
      <input class="modal-input" id="m-resource-url" value="${escAttr(item.url || "")}" placeholder="https://..." />
    </div>
    <div class="modal-field" id="m-resource-presets-wrap" style="display:${item.type === "app" ? "" : "none"};">
      <label class="modal-label">Quick Shortcuts</label>
      <div class="resource-type-row">
        <button type="button" class="resource-type-btn" onclick="setResourcePreset('ChatGPT','https://chatgpt.com')">ChatGPT</button>
        <button type="button" class="resource-type-btn" onclick="setResourcePreset('Gemini','https://gemini.google.com')">Gemini</button>
        <button type="button" class="resource-type-btn" onclick="setResourcePreset('YouTube','https://youtube.com')">YouTube</button>
      </div>
    </div>
    <div class="modal-field">
      <label class="toggle-row" onclick="togglePriorityEl(this)">
        <div class="toggle ${item.pinned ? "on" : ""}" id="m-resource-pinned"></div>
        Pin this resource
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="${reopenResourcesOverlayAfterSave ? "openResourcesOverlay()" : "closeModal()"}">Cancel</button>
      <button class="btn-confirm" onclick="saveResourceFromModal()">Save</button>
      <button class="btn-confirm" id="m-resource-pdf-btn" style="background:var(--blue);color:#fff;display:${item.type === "note" ? "" : "none"};" onclick="saveResourceFromModal(true)">Save & PDF</button>
    </div>`,
          item.type === "note" ? "modal-wide" : "",
          { hideTopbar: true },
        );
        syncResourceModalFields(item.type);
      }

      function setResourceModalType(el, type) {
        document
          .querySelectorAll("#m-resource-type-row .resource-type-btn")
          .forEach((btn) => btn.classList.remove("active"));
        el.classList.add("active");
        document.getElementById("m-resource-type").value = type;
        syncResourceModalFields(type);
      }

      function syncResourceModalFields(type) {
        const bodyWrap = document.getElementById("m-resource-body-wrap");
        const urlWrap = document.getElementById("m-resource-url-wrap");
        const presetsWrap = document.getElementById("m-resource-presets-wrap");
        const pdfBtn = document.getElementById("m-resource-pdf-btn");
        const bodyInput = document.getElementById("m-resource-body");
        if (bodyWrap) bodyWrap.style.display = type === "note" ? "" : "none";
        if (urlWrap) urlWrap.style.display = type === "note" ? "none" : "";
        if (presetsWrap)
          presetsWrap.style.display = type === "app" ? "" : "none";
        if (pdfBtn) pdfBtn.style.display = type === "note" ? "" : "none";
        if (bodyInput) bodyInput.classList.toggle("doc-style", type === "note");
      }

      function setResourcePreset(title, url) {
        const titleEl = document.getElementById("m-resource-title");
        const urlEl = document.getElementById("m-resource-url");
        if (titleEl) titleEl.value = title;
        if (urlEl) urlEl.value = url;
      }

      function saveResourceFromModal(exportPdf = false) {
        const s = getResourceState();
        if (!s) return;
        const shouldReopenOverlay = reopenResourcesOverlayAfterSave;
        const id = document.getElementById("m-resource-id").value;
        const type = document.getElementById("m-resource-type").value;
        const title = document.getElementById("m-resource-title").value.trim();
        const body =
          document.getElementById("m-resource-body")?.value.trim() || "";
        const url =
          document.getElementById("m-resource-url")?.value.trim() || "";
        const pinned = document
          .getElementById("m-resource-pinned")
          .classList.contains("on");

        if (!title) {
          showToast("⚠️", "Please enter a title");
          return;
        }
        if (type !== "note" && !url) {
          showToast("⚠️", "Please enter a URL");
          return;
        }

        let item = id ? (s.resources || []).find((res) => res.id === id) : null;
        if (!item) {
          item = normalizeResource({ id: "res_" + Date.now() });
          s.resources.unshift(item);
        }
        item.type = type;
        item.title = title;
        item.body = type === "note" ? body : "";
        item.url = type === "note" ? "" : url;
        item.pinned = pinned;
        item.updatedAt = Date.now();
        activeResourceId = item.id;
        save();
        closeModal();
        if (shouldReopenOverlay) openResourcesOverlay();
        if (exportPdf && item.type === "note") performResourcePdfExport(item);
        showToast("✅", "Resource saved");
      }

      function toggleResourcePin(id = activeResourceId) {
        const s = getResourceState();
        if (!s || !id) return;
        const item = (s.resources || []).find((res) => res.id === id);
        if (!item) return;
        item.pinned = !item.pinned;
        item.updatedAt = Date.now();
        save();
        renderResources();
      }

      function deleteResourceItem(id) {
        const s = getResourceState();
        if (!s) return;
        s.resources = (s.resources || []).filter((res) => res.id !== id);
        if (activeResourceId === id) {
          activeResourceId = s.resources[0]?.id || null;
        }
        save();
        renderResources();
        showToast("🗑", "Resource removed");
      }

      function downloadBlobFile(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }

      function performResourcePdfExport(item) {
        if (!item || item.type !== "note") return;
        try {
          const bytes = buildNotePdfBytes(item);
          downloadBlobFile(
            new Blob([bytes], { type: "application/pdf" }),
            `${slugifyFileName(item.title || "alumly-note")}.pdf`,
          );
          showToast("📄", "PDF downloaded");
        } catch (err) {
          console.error("[Alumly] PDF export failed:", err);
          showToast("❌", "PDF export failed");
        }
      }

      function exportResourcePdf(id = activeResourceId) {
        const s = getResourceState();
        if (!s || !id) return;
        const item = (s.resources || []).find((res) => res.id === id);
        if (!item || item.type !== "note") return;
        performResourcePdfExport(item);
      }

      function slugifyFileName(value) {
        return (
          String(value)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "alumly-note"
        );
      }

      function pdfEscape(text) {
        return String(text)
          .replace(/\\/g, "\\\\")
          .replace(/\(/g, "\\(")
          .replace(/\)/g, "\\)")
          .replace(/[^\x20-\x7e]/g, "?");
      }

      function wrapPdfText(text, maxChars = 86) {
        const rawLines = String(text || "")
          .replace(/\r/g, "")
          .split("\n");
        const wrapped = [];
        rawLines.forEach((line) => {
          const clean = line.trimEnd();
          if (!clean) {
            wrapped.push("");
            return;
          }
          let current = "";
          clean.split(/\s+/).forEach((word) => {
            const candidate = current ? `${current} ${word}` : word;
            if (candidate.length > maxChars) {
              if (current) wrapped.push(current);
              current = word;
            } else {
              current = candidate;
            }
          });
          if (current) wrapped.push(current);
        });
        return wrapped.length ? wrapped : [""];
      }

      function buildPdfDocumentBytes(titleText, metaText, linesInput) {
        const title = pdfEscape(titleText || "Untitled");
        const meta = pdfEscape(metaText || "");
        const bodyLines = linesInput.map(pdfEscape);
        const pageHeight = 792;
        const topY = 742;
        const lineHeight = 18;
        const usableLines = 34;
        const pages = [];
        let cursor = 0;
        while (cursor < bodyLines.length || !pages.length) {
          pages.push(bodyLines.slice(cursor, cursor + usableLines));
          cursor += usableLines;
        }

        const objects = [];
        objects.push("<< /Type /Catalog /Pages 2 0 R >>");

        const pageKids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
        objects.push(
          `<< /Type /Pages /Count ${pages.length} /Kids [${pageKids}] >>`,
        );

        pages.forEach((lines, index) => {
          const pageObjId = 3 + index * 2;
          const contentObjId = pageObjId + 1;
          objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageHeight}] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >> >> /Contents ${contentObjId} 0 R >>`,
          );

          const textCommands = [
            "BT",
            "/F2 24 Tf",
            `50 ${topY} Td`,
            `(${title}) Tj`,
            "ET",
            "BT",
            "/F1 11 Tf",
            `50 ${topY - 26} Td`,
            `(${meta}) Tj`,
            "ET",
          ];

          let y = topY - 64;
          lines.forEach((line) => {
            textCommands.push("BT");
            textCommands.push("/F1 12 Tf");
            textCommands.push(`50 ${y} Td`);
            textCommands.push(`(${line}) Tj`);
            textCommands.push("ET");
            y -= lineHeight;
          });

          if (pages.length > 1) {
            textCommands.push("BT");
            textCommands.push("/F1 10 Tf");
            textCommands.push(`50 32 Td`);
            textCommands.push(`(Page ${index + 1} of ${pages.length}) Tj`);
            textCommands.push("ET");
          }

          const stream = textCommands.join("\n");
          objects.push(
            `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
          );
        });

        let pdf = "%PDF-1.4\n";
        const offsets = [0];
        objects.forEach((obj, i) => {
          offsets.push(pdf.length);
          pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
        });
        const xrefStart = pdf.length;
        pdf += `xref\n0 ${objects.length + 1}\n`;
        pdf += "0000000000 65535 f \n";
        offsets.slice(1).forEach((offset) => {
          pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
        });
        pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
        return new TextEncoder().encode(pdf);
      }

      function buildNotePdfBytes(item) {
        return buildPdfDocumentBytes(
          item.title || "Untitled note",
          `Exported from Alumly App, ${fmtNoteDate(item.updatedAt)}`,
          wrapPdfText(item.body || "Empty note"),
        );
      }

      function openPrintExportWindow({
        title = "Alumly Export",
        subtitle = "",
        bodyHtml = "",
        fileName = "alumly-export.pdf",
      }) {
        const printWindow = window.open("", "_blank", "noopener,noreferrer");
        if (!printWindow) {
          showToast("❌", "Allow pop-ups to export as PDF");
          return;
        }
        const safeTitle = escHtml(title);
        const safeSubtitle = escHtml(subtitle);
        printWindow.document.open();
        printWindow.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${safeTitle}</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #10203a;
        --muted: #66758f;
        --line: #d9e1ee;
        --panel: #ffffff;
        --accent: #295fdf;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", Arial, sans-serif;
        background: #eef3fb;
        color: var(--ink);
      }
      .sheet {
        max-width: 820px;
        margin: 0 auto;
        min-height: 100vh;
        padding: 56px 54px 72px;
        background: var(--panel);
      }
      .eyebrow {
        margin-bottom: 10px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--accent);
      }
      h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.15;
      }
      .meta {
        margin-top: 10px;
        color: var(--muted);
        font-size: 13px;
      }
      .divider {
        height: 1px;
        margin: 28px 0 30px;
        background: var(--line);
      }
      .content {
        font-size: 14px;
        line-height: 1.8;
        white-space: normal;
        word-break: break-word;
      }
      .print-note-body {
        white-space: normal;
      }
      .report-list {
        display: grid;
        gap: 12px;
      }
      .report-item {
        padding: 14px 16px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: #f7f9fd;
      }
      .report-label {
        margin-bottom: 4px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      @media print {
        body {
          background: #fff;
        }
        .sheet {
          max-width: none;
          min-height: auto;
          padding: 28px 18px 36px;
        }
        @page {
          size: A4;
          margin: 16mm;
        }
      }
    </style>
  </head>
  <body>
    <main class="sheet">
      <div class="eyebrow">Alumly App</div>
      <h1>${safeTitle}</h1>
      <div class="meta">${safeSubtitle}</div>
      <div class="divider"></div>
      <section class="content">${bodyHtml}</section>
    </main>
    <script>
      window.addEventListener("load", () => {
        document.title = ${JSON.stringify(fileName)};
        setTimeout(() => window.print(), 120);
      });
      window.addEventListener("afterprint", () => {
        setTimeout(() => window.close(), 120);
      });
    <\/script>
  </body>
</html>`);
        printWindow.document.close();
        showToast("📄", "Print dialog opened for PDF export");
      }

      function exportSubjectReportPdf() {
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        const summaryItems = [
          {
            label: "Exam Date",
            value: s.examDate ? fmtDate(s.examDate) : "Not set",
          },
          { label: "Priority", value: s.priority ? "Yes" : "No" },
          { label: "Completed", value: s.isCompleted ? "Yes" : "No" },
          { label: "Canvas Notes", value: String(s.notes.length) },
          { label: "Connections", value: String(s.connections.length) },
          { label: "Resources", value: String((s.resources || []).length) },
        ];
        const resourceItems = (s.resources || []).length
          ? (s.resources || [])
              .map((item, index) => {
                const meta = resourceTypeMeta(item.type);
                return `
                  <div class="report-item">
                    <div class="report-label">Resource ${index + 1}</div>
                    <strong>${escHtml(item.title || "Untitled")}</strong><br>
                    <span>${escHtml(meta.label)}${item.url ? ` • ${escHtml(item.url)}` : ""}</span>
                  </div>`;
              })
              .join("")
          : `<div class="report-item"><div class="report-label">Resources</div>No resources added yet.</div>`;

        openPrintExportWindow({
          title: `${s.name} Report`,
          subtitle: `Exported from Alumly App, ${fmtNoteDate(Date.now())}`,
          bodyHtml: `
            <div class="report-list">
              ${summaryItems
                .map(
                  (item) => `
                    <div class="report-item">
                      <div class="report-label">${escHtml(item.label)}</div>
                      <strong>${escHtml(item.value)}</strong>
                    </div>`,
                )
                .join("")}
            </div>
            <div class="divider"></div>
            <div class="eyebrow">Resource Overview</div>
            <div class="report-list">${resourceItems}</div>
          `,
          fileName: `${slugifyFileName(s.name || "subject-report")}-report.pdf`,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
   SECTION 6 — EXPORT / IMPORT
═══════════════════════════════════════════════════════════════ */

      function exportSubject() {
        const s = getSubject(state.currentSubjectId);
        if (!s) return;
        const payload = {
          _alumly: true,
          version: 2,
          exportedAt: new Date().toISOString(),
          subject: s,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json",
        });
        downloadBlobFile(
          blob,
          `alumly-${s.name.replace(/\s+/g, "-").toLowerCase()}.json`,
        );
        showToast("⬇", `Subject "${s.name}" exported`);
      }

      function triggerImport() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data._alumly || !data.subject) throw new Error("Invalid file");
            const imported = normalizeSubject({
              ...data.subject,
              id: "subj_" + Date.now(),
            });
            state.subjects.push(imported);
            save();
            renderDashboard();
            showToast("✅", `"${imported.name}" imported successfully`);
          } catch (err) {
            showToast("❌", "Invalid Alumly export file");
          }
        };
        input.click();
      }

      /* ═══════════════════════════════════════════════════════════════
   SECTION 7 — DASHBOARD & SUBJECT MANAGEMENT
═══════════════════════════════════════════════════════════════ */

      function renderSidebar() {
        const el = document.getElementById("sb-subjects");
        if (!state.subjects.length) {
          el.innerHTML = `<div style="font-size:11.5px;color:var(--muted);padding:7px 10px;">No subjects yet</div>`;
          return;
        }
        el.innerHTML = state.subjects
          .map(
            (s) => `
    <div class="subject-item ${s.id === state.currentSubjectId ? "active" : ""}" style="--subject-color:${s.color}"
         onclick="openSubject('${s.id}')">
      <div class="subject-icon-chip">${s.emoji || "📘"}</div>
      <div style="flex:1;min-width:0;">
        <div class="subject-name">${escHtml(s.name)}</div>
        ${s.isCompleted ? `<span class="exam-badge" style="color:var(--green)">✓ Completed</span>` : s.examDate ? `<span class="exam-badge">📅 ${fmtDate(s.examDate)}</span>` : ""}
      </div>
      <button class="subject-del" onclick="event.stopPropagation();deleteSubjectPrompt('${s.id}')"
              title="Delete">×</button>
    </div>
  `,
          )
          .join("");
      }

      function getNextExamSubject() {
        return state.subjects
          .filter((subject) => !subject.isCompleted && subject.examDate)
          .map((subject) => ({ subject, days: daysUntil(subject.examDate) }))
          .filter(({ days }) => days != null && days >= 0)
          .sort((a, b) => a.days - b.days)[0] || null;
      }

      function getPrioritySubjects() {
        return state.subjects
          .filter((subject) => subject.priority && !subject.isCompleted)
          .sort((a, b) => {
            const aDays = daysUntil(a.examDate);
            const bDays = daysUntil(b.examDate);
            if (aDays == null && bDays == null) return a.name.localeCompare(b.name);
            if (aDays == null) return 1;
            if (bDays == null) return -1;
            return aDays - bDays;
          });
      }

      function moveSubjectToIndex(subjectId, targetIndex) {
        const currentIndex = state.subjects.findIndex((subject) => subject.id === subjectId);
        if (currentIndex === -1) return false;
        const boundedIndex = Math.max(0, Math.min(targetIndex, state.subjects.length));
        const adjustedIndex =
          boundedIndex > currentIndex ? boundedIndex - 1 : boundedIndex;
        if (currentIndex === adjustedIndex) return false;
        const [moved] = state.subjects.splice(currentIndex, 1);
        state.subjects.splice(adjustedIndex, 0, moved);
        return true;
      }

      function handleSubjectCardClick(event, subjectId) {
        if (suppressSubjectCardClick || draggedSubjectId) {
          event.preventDefault();
          return;
        }
        openSubject(subjectId);
      }

      function handleSubjectCardDragStart(event, subjectId) {
        draggedSubjectId = subjectId;
        draggedSubjectDropIndex = state.subjects.findIndex((subject) => subject.id === subjectId);
        suppressSubjectCardClick = false;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", subjectId);
        event.currentTarget.classList.add("dragging");
      }

      function clearSubjectDropPreview() {
        document.querySelectorAll(".subject-card.drop-before, .subject-card.drop-after").forEach((card) => {
          card.classList.remove("drop-before", "drop-after");
        });
      }

      function previewSubjectDropIndex(dropIndex) {
        clearSubjectDropPreview();
        const cards = [
          ...document.querySelectorAll(".subjects-grid .subject-card[data-subject-id]"),
        ].filter((card) => card.dataset.subjectId !== draggedSubjectId);
        if (!cards.length || dropIndex == null) return;
        if (dropIndex >= cards.length) {
          cards[cards.length - 1].classList.add("drop-after");
          return;
        }
        const targetCard = cards[dropIndex];
        if (targetCard) targetCard.classList.add("drop-before");
      }

      function getSubjectDropIndexFromPoint(clientX, clientY) {
        const grid = document.getElementById("dashboard-subjects-grid");
        if (!grid) return null;
        const cards = [
          ...grid.querySelectorAll(".subject-card[data-subject-id]"),
        ].filter((card) => card.dataset.subjectId !== draggedSubjectId);
        if (!cards.length) return 0;

        const rows = [];
        cards.forEach((card) => {
          const rect = card.getBoundingClientRect();
          const lastRow = rows[rows.length - 1];
          if (!lastRow || Math.abs(lastRow.top - rect.top) > 24) {
            rows.push({ top: rect.top, bottom: rect.bottom, cards: [{ card, rect }] });
            return;
          }
          lastRow.bottom = Math.max(lastRow.bottom, rect.bottom);
          lastRow.cards.push({ card, rect });
        });

        let targetRow = rows[rows.length - 1];
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index];
          const nextRow = rows[index + 1];
          const boundary = nextRow
            ? row.bottom + (nextRow.top - row.bottom) / 2
            : Number.POSITIVE_INFINITY;
          if (clientY < boundary) {
            targetRow = row;
            break;
          }
        }

        for (const { card, rect } of targetRow.cards) {
          if (clientX < rect.left + rect.width / 2) {
            return cards.findIndex((candidate) => candidate === card);
          }
        }
        const lastCard = targetRow.cards[targetRow.cards.length - 1]?.card;
        const lastIndex = cards.findIndex((candidate) => candidate === lastCard);
        return lastIndex + 1;
      }

      function handleSubjectGridDragOver(event) {
        if (!draggedSubjectId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        draggedSubjectDropIndex = getSubjectDropIndexFromPoint(event.clientX, event.clientY);
        previewSubjectDropIndex(draggedSubjectDropIndex);
      }

      function handleSubjectGridDrop(event) {
        if (!draggedSubjectId) return;
        event.preventDefault();
        const dropIndex =
          draggedSubjectDropIndex != null
            ? draggedSubjectDropIndex
            : getSubjectDropIndexFromPoint(event.clientX, event.clientY);
        clearSubjectDropPreview();
        const moved = moveSubjectToIndex(draggedSubjectId, dropIndex);
        if (moved) {
          suppressSubjectCardClick = true;
          renderDashboard();
          save();
        }
      }

      function handleSubjectGridDragLeave(event) {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          clearSubjectDropPreview();
        }
      }

      function handleSubjectCardDragEnd(event) {
        event.currentTarget.classList.remove("dragging");
        clearSubjectDropPreview();
        draggedSubjectId = null;
        draggedSubjectDropIndex = null;
        window.setTimeout(() => {
          suppressSubjectCardClick = false;
        }, 0);
      }

      function openNextExamSubject() {
        const nextExam = getNextExamSubject();
        if (!nextExam) return;
        openSubject(nextExam.subject.id);
      }

      function openPrioritySubjectsModal() {
        const prioritySubjects = getPrioritySubjects();
        if (!prioritySubjects.length) {
          showToast("📌", "No priority subjects yet");
          return;
        }
        showModal(`
    <h2>Priority Subjects</h2>
    <div class="modal-help">Jump straight into your highest-priority work.</div>
    <div class="priority-list">
      ${prioritySubjects
        .map((subject) => {
          const days = subject.examDate ? daysUntil(subject.examDate) : null;
          const examMeta = subject.examDate
            ? `${fmtDate(subject.examDate)}${days === 0 ? " • Today" : days != null ? ` • ${days}d` : ""}`
            : "No exam date";
          return `
        <button class="priority-item" onclick="openPrioritySubject('${subject.id}')">
          <div class="priority-item-icon" style="background:${subject.color}22;color:${subject.color}">${subject.emoji || "📘"}</div>
          <div class="priority-item-copy">
            <div class="priority-item-title">${escHtml(subject.name)}</div>
            <div class="priority-item-meta">${examMeta}</div>
          </div>
          <div class="priority-item-arrow">→</div>
        </button>`;
        })
        .join("")}
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">Close</button>
    </div>`);
      }

      function openPrioritySubject(subjectId) {
        closeModal();
        openSubject(subjectId);
      }

      function renderDashboard() {
        if (document.getElementById("canvas-panel") && document.fullscreenElement === document.getElementById("canvas-panel")) {
          document.exitFullscreen().catch(() => {});
        }
        canvasFocusMode = false;
        document.getElementById("workspace").style.display = "none";
        document.getElementById("dashboard").style.display = "";
        pomodoroPanelOpen = false;
        state.currentSubjectId = null;
        activeResourceId = null;
        activeResourceFilter = "all";
        reopenResourcesOverlayAfterSave = false;
        document.getElementById("page-title").textContent = "Dashboard";
        document.getElementById("topbar-focus-actions").innerHTML = "";
        document.getElementById("topbar-actions").innerHTML = `
    <div id="sync-badge"><span class="sync-dot"></span><span class="sync-text"></span></div>
    ${pomodoroTriggerHtml()}
    ${themeToggleButtonHtml()}
    <button class="btn" onclick="triggerImport()">⬇ Import</button>
    <button class="btn active" onclick="openAddSubjectModal()">＋ New Subject</button>
  `;
        renderSidebar();

        const total = state.subjects.length;
        const priority = state.subjects.filter((s) => s.priority).length;
        const completed = state.subjects.filter((s) => s.isCompleted).length;
        const nextExam = getNextExamSubject();
        const totalFocusMinutes = state.pomodoro.totalFocusMinutes || 0;
        const prioritySubjects = getPrioritySubjects();

        const statsHtml = total
          ? `
    <div class="stats-bar">
      <div class="stat-card"><div class="stat-val">${total}</div><div class="stat-label">Subjects</div></div>
      <div class="stat-card stat-card-action ${nextExam ? "" : "is-disabled"}" ${nextExam ? 'onclick="openNextExamSubject()"' : ""} role="${nextExam ? "button" : "presentation"}" tabindex="${nextExam ? "0" : "-1"}" ${nextExam ? 'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openNextExamSubject();}"' : ""}>
        <div class="stat-val stat-val-text">${nextExam ? escHtml(nextExam.subject.name) : "None"}</div>
        <div class="stat-label">${nextExam ? `${fmtDate(nextExam.subject.examDate)}${nextExam.days === 0 ? " • Today" : ` • ${nextExam.days}d`}` : "Next Exam"}</div>
      </div>
      <div class="stat-card"><div class="stat-val stat-val-text">${formatFocusMinutes(totalFocusMinutes)}</div><div class="stat-label">Total Focused Time</div></div>
      ${priority ? `<div class="stat-card stat-card-action" onclick="openPrioritySubjectsModal()" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openPrioritySubjectsModal();}"><div class="stat-val" style="color:var(--accent3)">${prioritySubjects.length}</div><div class="stat-label">Priority</div></div>` : ""}
      ${completed ? `<div class="stat-card"><div class="stat-val" style="color:var(--green)">${completed}</div><div class="stat-label">Completed</div></div>` : ""}
    </div>`
          : "";

        const cardsHtml = !total
          ? `<div class="dash-empty">
         <div class="dash-empty-icon">📚</div>
         <h3>Start your first subject</h3>
         <p>Build a clean study space with a visual canvas and simple subject notes.</p>
       </div>`
          : state.subjects
              .map((s) => {
                const days = s.examDate ? daysUntil(s.examDate) : null;
                let countdownEl = "";
                if (days !== null) {
                  const cls =
                    days <= 7 ? "c-soon" : days <= 21 ? "c-mid" : "c-ok";
                  const label =
                    days < 0 ? "Past due" : days === 0 ? "Today!" : `${days}d`;
                  countdownEl = `<span class="countdown ${cls}">${label}</span>`;
                }
                return `
          <div class="subject-card" style="--card-color:${s.color}" draggable="true"
               data-subject-id="${s.id}"
               onclick="handleSubjectCardClick(event, '${s.id}')"
               ondragstart="handleSubjectCardDragStart(event, '${s.id}')"
               ondragend="handleSubjectCardDragEnd(event)">
            <div class="card-top">
              <div class="card-icon" style="background:${s.color}22">${s.emoji || "📘"}</div>
              <div style="display:flex;gap:5px;align-items:center;">
                ${s.priority ? '<span class="chip chip-priority">⚡ Priority</span>' : ""}
                ${s.isCompleted ? '<span class="chip" style="background:var(--green-dim);color:var(--green);">✓ Completed</span>' : ""}
                <button class="card-menu"
                        onclick="event.stopPropagation();openEditSubjectModal('${s.id}')"
                        title="Edit">✎</button>
              </div>
            </div>
            <div class="card-name">${escHtml(s.name)}</div>
            <div class="card-exam">
              ${
                s.isCompleted
                  ? '<span style="color:var(--green)">✓ Completed</span>'
                  : s.examDate
                    ? `📅 ${fmtDate(s.examDate)} ${countdownEl}`
                    : '<span style="opacity:.45">No deadline set</span>'
              }
            </div>
            <div class="card-stats">
              <div class="card-stat">🧠 <span>${s.notes.length}</span> canvas</div>
              <div class="card-stat">📝 <span>${(s.resources || []).filter((item) => item.type === "note").length}</span> notes</div>
              <div class="card-stat">📚 <span>${(s.resources || []).length}</span> resources</div>
              <div class="card-stat">🔗 <span>${s.connections.length}</span> links</div>
            </div>
          </div>`;
              })
              .join("") +
            `<button class="add-card" onclick="openAddSubjectModal()">
           <div class="add-card-icon">＋</div><div>Add Subject</div>
         </button>`;

        document.getElementById("dashboard").innerHTML = `
    <div class="dash-header">
      <div>
        <h1>Your <span>Premium Workspace</span></h1>
        <p>A calmer, global-ready productivity environment for planning, writing, linking sources, and exporting polished work.</p>
      </div>
    </div>
    ${statsHtml}
    <div class="subjects-grid" id="dashboard-subjects-grid"
         ondragover="handleSubjectGridDragOver(event)"
         ondrop="handleSubjectGridDrop(event)"
         ondragleave="handleSubjectGridDragLeave(event)">${cardsHtml}</div>`;
        ensurePomodoroTicker();
      }

      function openSubject(id) {
        pomodoroPanelOpen = false;
        state.currentSubjectId = id;
        /**
         * DATE BUG FIX: getSubject(id) is now unconditional — it finds the
         * subject by id regardless of whether examDate is in the past.
         * Past-due dates are shown as "Past due" labels on the dashboard card,
         * but they NEVER prevent opening the workspace.
         */
        const s = getSubject(id);
        if (!s) return;

        document.getElementById("dashboard").style.display = "none";
        document.getElementById("workspace").style.display = "flex";
        document.getElementById("page-title").innerHTML = `
    <span style="color:${s.color}">${s.emoji || "📘"}</span>
    ${escHtml(s.name)}
    ${s.priority ? '<span class="chip chip-priority" style="font-size:9.5px;margin-left:6px;">⚡ Priority</span>' : ""}
    ${s.isCompleted ? '<span class="chip" style="font-size:9.5px;margin-left:6px;background:var(--green-dim);color:var(--green);">✓ Completed</span>' : ""}
  `;
        document.getElementById("topbar-focus-actions").innerHTML = `
    <button class="btn" onclick="renderDashboard()">← Dashboard</button>
  `;
        document.getElementById("topbar-actions").innerHTML = `
    <div id="sync-badge"><span class="sync-dot"></span><span class="sync-text"></span></div>
    ${pomodoroTriggerHtml()}
    ${themeToggleButtonHtml()}
    <button class="btn header-resource-btn" onclick="openResourcesOverlay()">📚 Resources</button>
    <button class="btn accent" onclick="exportSubject()">⬆ Export</button>
    <button class="btn active" onclick="toggleCanvasFocusMode()">⛶ Canvas Focus</button>
  `;

        renderCanvas();
        renderResources();
        renderSidebar();
        initCanvasEvents();
        ensurePomodoroTicker();
        syncCanvasFocusUi();
      }

      /* ── Subject CRUD modals ── */

      function iconPickerHtml(selected = "📘") {
        return `
    <input type="hidden" id="m-emoji" value="${escAttr(selected)}" />
    <div class="icon-picker-grid">
      ${SUBJ_ICONS.map(
        (icon) => `
          <button type="button" class="icon-picker-btn ${icon === selected ? "selected" : ""}"
            onclick="selectSubjectIcon(this, '${icon}')">${icon}</button>`,
      ).join("")}
    </div>`;
      }

      function daysInMonth(month, year) {
        return new Date(year, month, 0).getDate();
      }

      function examDateFieldHtml(value = "") {
        const [yearValue, monthValue, dayValue] = String(value || "")
          .split("-")
          .map((part) => Number(part) || 0);
        const currentYear = new Date().getFullYear();
        const selectedYear = yearValue || 0;
        const selectedMonth = monthValue || 0;
        const selectedDay = dayValue || 0;
        const maxDay = selectedMonth
          ? daysInMonth(selectedMonth, selectedYear)
          : 31;
        const monthNames = [
          "Month",
          "January",
          "February",
          "March",
          "April",
          "May",
          "June",
          "July",
          "August",
          "September",
          "October",
          "November",
          "December",
        ];
        return `
    <input type="hidden" id="m-date" value="${escAttr(value || "")}" />
    <div class="date-field-grid">
      <div>
        <label class="date-field-label" for="m-date-day">Day</label>
        <select class="modal-input date-select" id="m-date-day" onchange="syncExamDateValue()">
          <option value="">Day</option>
          ${Array.from({ length: maxDay }, (_, index) => index + 1)
            .map(
              (day) =>
                `<option value="${String(day).padStart(2, "0")}" ${selectedDay === day ? "selected" : ""}>${day}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div>
        <label class="date-field-label" for="m-date-month">Month</label>
        <select class="modal-input date-select" id="m-date-month" onchange="syncExamDateValue(true)">
          ${monthNames
            .map(
              (label, index) =>
                `<option value="${index ? String(index).padStart(2, "0") : ""}" ${selectedMonth === index ? "selected" : ""}>${label}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div>
        <label class="date-field-label" for="m-date-year">Year</label>
        <select class="modal-input date-select" id="m-date-year" onchange="syncExamDateValue(true)">
          <option value="">Year</option>
          ${Array.from({ length: 12 }, (_, index) => currentYear - 1 + index)
            .map(
              (year) =>
                `<option value="${year}" ${selectedYear === year ? "selected" : ""}>${year}</option>`,
            )
            .join("")}
        </select>
      </div>
    </div>
    <div class="date-input-actions">
      <div class="modal-help">Date format is always day / month / year.</div>
      <button type="button" class="btn-text" onclick="clearExamDate()">Clear</button>
    </div>`;
      }

      function syncExamDateValue(refreshDays = false) {
        const dayEl = document.getElementById("m-date-day");
        const monthEl = document.getElementById("m-date-month");
        const yearEl = document.getElementById("m-date-year");
        const hiddenEl = document.getElementById("m-date");
        if (!dayEl || !monthEl || !yearEl || !hiddenEl) return;

        const month = monthEl.value;
        const year = yearEl.value;
        if (refreshDays) {
          const maxDay =
            month && year ? daysInMonth(Number(month), Number(year)) : 31;
          const currentDay = dayEl.value;
          dayEl.innerHTML =
            `<option value="">Day</option>` +
            Array.from({ length: maxDay }, (_, index) => index + 1)
              .map((day) => {
                const value = String(day).padStart(2, "0");
                return `<option value="${value}" ${currentDay === value ? "selected" : ""}>${day}</option>`;
              })
              .join("");
          if (currentDay && Number(currentDay) > maxDay) {
            dayEl.value = "";
          }
        }

        hiddenEl.value =
          dayEl.value && month && year ? `${year}-${month}-${dayEl.value}` : "";
      }

      function clearExamDate() {
        const hiddenEl = document.getElementById("m-date");
        const dayEl = document.getElementById("m-date-day");
        const monthEl = document.getElementById("m-date-month");
        const yearEl = document.getElementById("m-date-year");
        if (hiddenEl) hiddenEl.value = "";
        if (dayEl) dayEl.value = "";
        if (monthEl) monthEl.value = "";
        if (yearEl) yearEl.value = "";
        syncExamDateValue(true);
      }

      function openAddSubjectModal() {
        let selColor =
          SUBJ_COLORS[Math.floor(Math.random() * SUBJ_COLORS.length)];
        showModal(`
    <h2>✨ New Subject</h2>
    <div class="modal-field">
      <label class="modal-label">Subject Name</label>
      <input class="modal-input" id="m-name" placeholder="e.g. Calculus, World History…" autofocus />
    </div>
    <div class="modal-field">
      <label class="modal-label">Subject Icon</label>
      ${iconPickerHtml("📘")}
    </div>
    <div class="modal-field">
      <label class="modal-label">Exam Date (Optional)</label>
      ${examDateFieldHtml("")}
    </div>
    <div class="modal-field">
      <label class="modal-label">Colour</label>
      <div class="color-grid">
        ${SUBJ_COLORS.map(
          (c) =>
            `<div class="color-swatch ${c === selColor ? "sel" : ""}" style="background:${c}"
               onclick="selSwatch(this)"></div>`,
        ).join("")}
      </div>
    </div>
    <div class="modal-field">
      <label class="toggle-row" onclick="togglePriorityEl(this)">
        <div class="toggle" id="m-priority"></div>
        Mark as Priority
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" onclick="_confirmAddSubject()">Add Subject</button>
    </div>
  `, "", { hideTopbar: true });
        document.getElementById("m-name").focus();
      }

      function openEditSubjectModal(id) {
        const s = getSubject(id);
        if (!s) return;
        showModal(`
    <h2>✎ Edit Subject</h2>
    <div class="modal-field">
      <label class="modal-label">Name</label>
      <input class="modal-input" id="m-name" value="${escHtml(s.name)}" autofocus />
    </div>
    <div class="modal-field">
      <label class="modal-label">Subject Icon</label>
      ${iconPickerHtml(s.emoji || "📘")}
    </div>
    <div class="modal-field">
      <label class="modal-label">Exam Date</label>
      ${examDateFieldHtml(s.examDate || "")}
    </div>
    <div class="modal-field">
      <label class="modal-label">Colour</label>
      <div class="color-grid">
        ${SUBJ_COLORS.map(
          (c) =>
            `<div class="color-swatch ${c === s.color ? "sel" : ""}" style="background:${c}"
               onclick="selSwatch(this)"></div>`,
        ).join("")}
      </div>
    </div>
    <div class="modal-field">
      <label class="toggle-row" onclick="togglePriorityEl(this)">
        <div class="toggle ${s.priority ? "on" : ""}" id="m-priority"></div>
        Mark as Priority
      </label>
    </div>
    <div class="modal-field">
      <label class="toggle-row" onclick="togglePriorityEl(this)">
        <div class="toggle ${s.isCompleted ? "on" : ""}" id="m-completed"></div>
        Mark as Completed
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" style="color:var(--danger);border-color:color-mix(in srgb, var(--danger) 32%, var(--border));" onclick="deleteSubjectPrompt('${id}')">Delete Subject</button>
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" onclick="_confirmEditSubject('${id}')">Save</button>
    </div>
  `, "", { hideTopbar: true });
      }

      function selSwatch(el) {
        document
          .querySelectorAll(".color-swatch")
          .forEach((s) => s.classList.remove("sel"));
        el.classList.add("sel");
      }
      function selectSubjectIcon(el, icon) {
        document
          .querySelectorAll(".icon-picker-btn")
          .forEach((btn) => btn.classList.remove("selected"));
        el.classList.add("selected");
        document.getElementById("m-emoji").value = icon;
      }
      function togglePriorityEl(row) {
        row.querySelector(".toggle").classList.toggle("on");
      }
      function _getSelColor() {
        const sw = document.querySelector(".color-swatch.sel");
        return sw ? sw.style.background : SUBJ_COLORS[0];
      }

      function _confirmAddSubject() {
        const name = document.getElementById("m-name").value.trim();
        if (!name) {
          showToast("⚠️", "Please enter a name");
          return;
        }
        const subj = normalizeSubject({
          id: "subj_" + Date.now(),
          name,
          examDate: document.getElementById("m-date").value,
          emoji: document.getElementById("m-emoji").value.trim() || "📘",
          color: _getSelColor(),
          priority: document
            .getElementById("m-priority")
            .classList.contains("on"),
        });
        state.subjects.push(subj);
        save();
        closeModal();
        renderDashboard();
        showToast("✅", `"${name}" created`);
      }

      function _confirmEditSubject(id) {
        const s = getSubject(id);
        if (!s) return;
        const name = document.getElementById("m-name").value.trim();
        if (!name) {
          showToast("⚠️", "Please enter a name");
          return;
        }
        s.name = name;
        s.examDate = document.getElementById("m-date").value;
        s.emoji = document.getElementById("m-emoji").value.trim() || "📘";
        s.color = _getSelColor();
        s.priority = document
          .getElementById("m-priority")
          .classList.contains("on");
        s.isCompleted = document
          .getElementById("m-completed")
          .classList.contains("on");
        save();
        closeModal();
        if (state.currentSubjectId === id) openSubject(id);
        else renderDashboard();
        showToast("✅", "Subject updated");
      }

      function deleteSubjectPrompt(id) {
        const s = getSubject(id);
        if (!s) return;
        showModal(`
    <h2>🗑 Delete Subject?</h2>
    <p style="color:var(--muted);font-size:13.5px;margin-bottom:20px;">
      Delete <strong style="color:var(--text)">"${escHtml(s.name)}"</strong>?
      All canvas notes, resources, and connections will be lost permanently.
    </p>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" style="background:var(--danger)"
              onclick="_confirmDeleteSubject('${id}')">Delete</button>
    </div>
  `);
      }

      function _confirmDeleteSubject(id) {
        state.subjects = state.subjects.filter((s) => s.id !== id);
        dirtyCanvasSubjectIds.delete(id);
        persistedCanvasBySubject.delete(id);
        if (state.currentSubjectId === id) state.currentSubjectId = null;
        save();
        closeModal();
        renderDashboard();
        showToast("🗑", "Subject deleted");
      }

      /* ═══════════════════════════════════════════════════════════════
   SECTION 8 — CONTEXT MENU
═══════════════════════════════════════════════════════════════ */

      function showCtxMenu(x, y, items) {
        const menu = document.getElementById("ctx-menu");
        menu.innerHTML = items
          .map((item) => {
            if (item.type === "sep") return `<div class="ctx-sep"></div>`;
            return `<button class="ctx-item ${item.danger ? "danger" : ""}"
                    onclick="closeCtxMenu();(${item.action.toString()})()">
              <span>${item.icon}</span>${item.label}
            </button>`;
          })
          .join("");

        const vw = window.innerWidth,
          vh = window.innerHeight;
        menu.style.display = "block";
        const mw = menu.offsetWidth,
          mh = menu.offsetHeight;
        menu.style.left = (x + mw > vw ? x - mw : x) + "px";
        menu.style.top = (y + mh > vh ? y - mh : y) + "px";
      }

      function closeCtxMenu() {
        document.getElementById("ctx-menu").style.display = "none";
      }

      /* ═══════════════════════════════════════════════════════════════
   SECTION 9 — MODAL
═══════════════════════════════════════════════════════════════ */

      function showModal(html, cls = "", options = {}) {
        const mount = document.getElementById("modal-mount");
        modalHidesTopbar = !!options.hideTopbar;
        document
          .getElementById("topbar")
          ?.classList.toggle("hidden-by-modal", modalHidesTopbar);
        mount.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal ${cls}">${html}</div>
    </div>`;
        document
          .getElementById("modal-overlay")
          .addEventListener("click", (e) => {
            if (e.target === document.getElementById("modal-overlay"))
              closeModal();
          });
      }

      function closeModal() {
        exitResourceFocusMode();
        const mount = document.getElementById("modal-mount");
        mount.innerHTML = "";
        modalHidesTopbar = false;
        document.getElementById("topbar")?.classList.remove("hidden-by-modal");
        reopenResourcesOverlayAfterSave = false;
        resourceFocusMode = false;
      }

      document.addEventListener("fullscreenchange", () => {
        if (!document.getElementById("resource-center-shell")) {
          resourceFocusMode = false;
        } else {
          syncResourceFocusUi();
        }
        syncCanvasFocusUi();
      });

      /* ═══════════════════════════════════════════════════════════════
   SECTION 10 — TOAST
═══════════════════════════════════════════════════════════════ */

      function showToast(icon, msg, duration = 2600) {
        const el = document.createElement("div");
        el.className = "toast";
        el.innerHTML = `<span>${icon}</span>${msg}`;
        document.getElementById("toast-rack").appendChild(el);
        setTimeout(() => {
          el.style.transition = "opacity 0.28s, transform 0.28s";
          el.style.opacity = "0";
          el.style.transform = "translateX(14px)";
          setTimeout(() => el.remove(), 300);
        }, duration);
      }

      /* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

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
      function fmtDate(d) {
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

      function registerServiceWorker() {
        if (!("serviceWorker" in navigator)) return;

        window.addEventListener("load", async () => {
          try {
            await navigator.serviceWorker.register("./sw.js");
          } catch (error) {
            console.error("Service worker registration failed:", error);
          }
        });
      }

      registerServiceWorker();

      /* ═══════════════════════════════════════════════════════════════
   EXPOSE FUNCTIONS TO WINDOW
   ─────────────────────────────────────────────────────────────────
   Because this is a <script type="module">, all declarations are
   module-scoped by default. Inline onclick="…" attributes in the
   HTML need the functions on window, so we attach them explicitly.
═══════════════════════════════════════════════════════════════ */
      Object.assign(window, {
        // Auth
        handleSignOut,
        handleGuestLogin,
        // Canvas / Notes
        addNote,
        addNoteAt,
        finishAndSaveCanvas,
        renderDashboard,
        openSubject,
        toggleConnectMode,
        handleNoteConnect,
        changeNoteColor,
        deleteNote,
        clearCanvas,
        _confirmClear,
        resetView,
        updateConnections,
        deleteConnection,
        // Resources
        setResourceFilter,
        toggleResourceFocusMode,
        renderResources,
        openResource,
        openResourcesOverlay,
        toggleTheme,
        togglePomodoro,
        resetPomodoro,
        setPomodoroMode,
        setPomodoroPreset,
        togglePomodoroPanel,
        closePomodoroPanel,
        toggleCanvasFocusMode,
        openAddResourceModal,
        openEditResourceModal,
        setResourceModalType,
        setResourcePreset,
        saveResourceFromModal,
        toggleResourcePin,
        deleteResourceItem,
        // Export / Import
        exportSubjectReportPdf,
        exportResourcePdf,
        exportSubject,
        triggerImport,
        // Subject modals
        openAddSubjectModal,
        openEditSubjectModal,
        deleteSubjectPrompt,
        openNextExamSubject,
        openPrioritySubjectsModal,
        openPrioritySubject,
        handleSubjectCardClick,
        handleSubjectCardDragStart,
        handleSubjectGridDragOver,
        handleSubjectGridDragLeave,
        handleSubjectGridDrop,
        handleSubjectCardDragEnd,
        selSwatch,
        selectSubjectIcon,
        syncExamDateValue,
        clearExamDate,
        togglePriorityEl,
        _confirmAddSubject,
        _confirmEditSubject,
        _confirmDeleteSubject,
        // UI utilities
        showModal,
        closeModal,
        showCtxMenu,
        closeCtxMenu,
        showToast,
      });

      /* ═══════════════════════════════════════════════════════════════
   BOOT
   ─────────────────────────────────────────────────────────────────
   No loadState() / renderDashboard() here — the app is driven
   entirely by onAuthStateChanged above.  Once Firebase confirms
   the auth state, it fetches Firestore data and reveals the UI.
═══════════════════════════════════════════════════════════════ */
