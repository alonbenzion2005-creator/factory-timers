// ─────────────────────────────────────────────────────────────────────────
//  STEP 1 of setup — paste your free Firebase config below.
//
//  How to get it (takes ~3 minutes, no credit card):
//    1. Go to  https://console.firebase.google.com  →  "Add project".
//    2. In the project, open  Build → Realtime Database → "Create database"
//       → choose a location → start in "Test mode".
//    3. Open  Project settings (⚙ top-left) → scroll to "Your apps"
//       → click the  </>  (Web) icon → register the app.
//    4. Firebase shows a  firebaseConfig = { ... }  object. Copy the values
//       into the object below (replace every PASTE_… placeholder).
//
//  Full walkthrough with screenshots-worth of detail is in README.md.
// ─────────────────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT.firebaseapp.com",
  databaseURL: "PASTE_https://PROJECT-default-rtdb.firebaseio.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

// The default shared "room". Both phones must use the same room name to see
// the same timers. You can also change it any time from inside the app.
export const DEFAULT_ROOM = "factory";
