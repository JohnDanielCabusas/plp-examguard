// ============================================================
// FIREBASE SYNC  —  Real-time Firestore backend
// ============================================================
//
// SETUP (one-time, ~5 minutes):
//   1. Go to https://console.firebase.google.com
//   2. Create a project → "Web app" → copy the config below
//   3. Firestore Database → Create database (start in test mode)
//   4. Paste your config values into FIREBASE_CONFIG below
//
// Firestore Security Rules (Firestore → Rules tab):
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//       match /{document=**} {
//         allow read, write: if true;
//       }
//     }
//   }
// ============================================================

const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};

const FirebaseSync = {
  db: null,
  _unsubscribers: [],
  _readyEmitted: false,

  _writeLocal(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    window.DB?.clearCacheKey?.(key);
  },

  // ---- Public: call once per page load ----
  async init() {
    // DB.init() has already seeded localStorage, so the UI can render immediately.
    this._emitReady();

    try {
      if (this._hasPlaceholderConfig()) {
        console.warn('[FirebaseSync] Firebase config is incomplete. Running in localStorage-only mode.');
        return;
      }

      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }
      this.db = firebase.firestore();

      // First-run check: if Firestore is empty, seed from localStorage (admin's browser seeds first)
      const settingsSnap = await this.db.collection('settings').doc('main').get();
      if (!settingsSnap.exists) {
        await this._seedFromLocalStorage();
      } else {
        await this._pullFromFirestore();
      }

      this._setupListeners();
    } catch (e) {
      // Firebase config not filled in, project missing, or offline — fall back gracefully
      console.warn('[FirebaseSync] Running in localStorage-only mode:', e.message);
    }

  },

  // ---- Seed Firestore from current localStorage (first run on any device) ----
  async _seedFromLocalStorage() {
    const BATCH_MAX = 490; // Firestore limit is 500 ops per batch
    const ops = [];

    const settings = this._local('acs_settings');
    if (settings) ops.push(['settings', 'main', settings]);

    for (const col of ['admins', 'students', 'subjects', 'exams', 'sessions', 'logs']) {
      for (const item of this._localArray('acs_' + col)) {
        if (item.id) ops.push([col, item.id, item]);
      }
    }

    for (let i = 0; i < ops.length; i += BATCH_MAX) {
      const batch = this.db.batch();
      ops.slice(i, i + BATCH_MAX).forEach(([col, id, data]) => {
        batch.set(this.db.collection(col).doc(id), data);
      });
      await batch.commit();
    }
  },

  // ---- Overwrite localStorage with current Firestore data (all subsequent loads) ----
  async _pullFromFirestore() {
    const COLS = ['admins', 'students', 'subjects', 'exams', 'sessions', 'logs'];
    const [settingsDoc, ...snaps] = await Promise.all([
      this.db.collection('settings').doc('main').get(),
      ...COLS.map(c => this.db.collection(c).get()),
    ]);

    if (settingsDoc.exists) {
      this._writeLocal('acs_settings', settingsDoc.data());
    }
    COLS.forEach((col, i) => {
      this._writeLocal('acs_' + col, snaps[i].docs.map(d => d.data()));
    });
  },

  // ---- Real-time listeners: push Firestore changes into localStorage on every client ----
  // This is what lets the waiting room and admin monitor work across devices.
  _setupListeners() {
    const listenCol = (col, lsKey) =>
      this.db.collection(col).onSnapshot(snap => {
        this._writeLocal(lsKey, snap.docs.map(d => d.data()));
      });

    const listenDoc = (path, lsKey) =>
      this.db.doc(path).onSnapshot(snap => {
        if (snap.exists) this._writeLocal(lsKey, snap.data());
      });

    this._unsubscribers = [
      listenDoc('settings/main', 'acs_settings'),
      listenCol('admins',        'acs_admins'),
      listenCol('students',      'acs_students'),
      listenCol('subjects',      'acs_subjects'),
      listenCol('exams',         'acs_exams'),   // exam status changes propagate here
      listenCol('sessions',      'acs_sessions'), // student progress visible to admin
      listenCol('logs',          'acs_logs'),
    ];
  },

  // ---- Write helpers: called from data.js immediately after each localStorage write ----

  syncSettings(data) {
    this.db?.collection('settings').doc('main').set(data).catch(console.error);
  },

  syncDoc(col, data) {
    if (!this.db || !data?.id) return;
    this.db.collection(col).doc(data.id).set(data).catch(console.error);
  },

  deleteDoc(col, id) {
    if (!this.db || !id) return;
    this.db.collection(col).doc(id).delete().catch(console.error);
  },

  // ---- Utils ----
  _local(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  _localArray(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
  },
  _hasPlaceholderConfig() {
    return Object.values(FIREBASE_CONFIG).some(value => String(value || '').includes('YOUR_'));
  },
  _emitReady() {
    if (this._readyEmitted) return;
    this._readyEmitted = true;
    document.dispatchEvent(new Event('firebaseReady'));
  },
};
