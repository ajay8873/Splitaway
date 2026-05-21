/* 
   ════════════════════════════════════════════
   SPLITAWAY — CORE LOGIC v3
   ════════════════════════════════════════════ 
*/

// ── CONFIG ──
const SUPABASE_URL  = 'https://lgoxncdahbijpfrzhsuf.supabase.co';
const SUPABASE_ANON = 'sb_publishable_C6SJIM7Qzgk9UEf-Bz64MA_XvDjXQep';

// ── STATE ──
let supabaseClient   = null;
let currentUser      = null;
let currentTripId    = null;
let currentTripPhase = 'done';
let friends          = [];
let expenses         = [];
let currency         = { sym: '₹', code: 'INR' };
let hasUnsavedEdits  = false;
let selectedSplit    = new Set();
let isAuthPending    = false;
let realtimeChannel  = null;
let unsavedModalCallback = null; // what to do after the modal resolves

// Suggestion state
let isTripOwner      = false;
let pendingSuggestions = [];
let sugSplitSelected = new Set();
let settlements      = [];
let doneSettlements  = new Set();

// Cross-device sync state
let syncQueue        = [];
let isSyncing        = false;
let lastSyncTime     = null;
let isOffline        = typeof navigator !== 'undefined' ? !navigator.onLine : false;
let syncRetryTimer   = null;

// ── CONSTANTS ──
const LS_PREFIX = 'splitaway_v2:';
const LS_INDEX  = LS_PREFIX + 'trips_index';
const LS_DELETED = LS_PREFIX + 'deleted_trips';
const tripKey   = id => LS_PREFIX + 'trip:' + id;

// Enhanced localStorage functions with sync metadata
const lsSet = (k, v) => {
  const data = { data: v, syncedAt: new Date().toISOString() };
  localStorage.setItem(k, JSON.stringify(data));
};

const lsGet = k => { 
  try { 
    const item = localStorage.getItem(k);
    if (!item) return null;
    const parsed = JSON.parse(item);
    return parsed?.data || null;
  } catch(e) { 
    return null; 
  }
};

const lsGetWithMeta = k => {
  try {
    const item = localStorage.getItem(k);
    if (!item) return null;
    return JSON.parse(item);
  } catch(e) {
    return null;
  }
};

const getDeletedTrips = () => lsGet(LS_DELETED) || [];
const isTripDeleted = (id) => getDeletedTrips().some(item => item?.id === id);
const rememberDeletedTrip = (id, meta = {}) => {
  const list = getDeletedTrips().filter(item => item?.id !== id);
  list.unshift({
    id,
    deletedAt: new Date().toISOString(),
    ownerId: meta.ownerId || null
  });
  lsSet(LS_DELETED, list);
};
const forgetDeletedTrip = (id) => {
  const list = getDeletedTrips().filter(item => item?.id !== id);
  lsSet(LS_DELETED, list);
};
const removeTripFromLocalCache = (id) => {
  localStorage.removeItem(tripKey(id));
  const index = lsGet(LS_INDEX) || [];
  const next = index.filter(x => x !== id);
  if (next.length !== index.length) lsSet(LS_INDEX, next);
};
const normalizeExpense = (expense) => ({
  ...expense,
  desc: expense?.desc ?? expense?.description ?? '',
  amount: Number(expense?.amount ?? 0),
  payer: expense?.payer || '',
  cat: expense?.cat || '',
  split: Array.isArray(expense?.split) ? [...expense.split] : []
});
const normalizeTripRecord = (tripData, meta = {}) => ({
  id: tripData.id,
  name: tripData.name || 'Untitled Trip',
  currency: tripData.currency || currency,
  friends: Array.isArray(tripData.friends) ? [...tripData.friends] : [],
  expenses: Array.isArray(tripData.expenses) ? tripData.expenses.map(normalizeExpense) : [],
  updated_at: tripData.updated_at || new Date().toISOString(),
  syncedToSupabase: meta.syncedToSupabase ?? tripData.syncedToSupabase ?? false,
  ownerId: meta.ownerId ?? tripData.ownerId ?? tripData.user_id ?? null
});
const storeTripLocally = (key, tripData, meta = {}) => {
  const normalized = normalizeTripRecord(tripData, meta);
  lsSet(key, normalized);
  return normalized;
};
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8); return v.toString(16); });

const COLORS = [
  '#e05c3a','#2a8a6a','#d4820a','#4a6fa5','#7b5ea7',
  '#b5531a','#1d7a6a','#c94b35','#3a7cbf','#8e6ac0',
  '#a03a60','#3a8a4a','#c47a0a','#2a5fa5','#7a3ab5'
];
const getColor = i => COLORS[i % COLORS.length];

// ══════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initFX();
  initSupabase();
  loadOrCreateDefault();
  setupGlobalEvents();
  setupBackButtonGuard();
});

function initFX() {
  // Cursor glow
  if (window.matchMedia('(pointer:fine)').matches) {
    const glow = document.createElement('div');
    glow.id = 'cursor-glow';
    document.body.appendChild(glow);
    document.addEventListener('mousemove', e => {
      glow.style.left = e.clientX + 'px';
      glow.style.top  = e.clientY + 'px';
    });
  }

  setTimeout(() => showPwaPopup(), 1800);
}

function initSupabase() {
  try {
    if (!window.supabase) return;
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

    if (window.location.hash.includes('access_token=') || window.location.hash.includes('type=recovery'))
      isAuthPending = true;

    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      currentUser = session?.user || null;
      isAuthPending = false;
      
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        updateAuthUI();
        syncTripsFromSupabase();
      } else if (event === 'PASSWORD_RECOVERY') {
        toggleAuthMode('update-password');
      } else if (event === 'USER_UPDATED') {
        updateAuthUI();
      } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        updateAuthUI();
      } else {
        updateAuthUI();
      }
    });

    supabaseClient.auth.getSession().then(({ data: { session } }) => {
      if (!isAuthPending) {
        currentUser = session?.user || null;
        updateAuthUI();
        if (currentUser) syncTripsFromSupabase();
      }
    });
  } catch (err) { console.error('Supabase init failed:', err); }
}

// ══════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════

window.updateAuthUI = () => {
  if (isAuthPending) return;

  const profileBtn = document.getElementById('landingProfileBtn');
  const dropdown   = document.getElementById('dropdownUserName');
  const heroActions = document.querySelector('.hero-actions-container');

  const urlParams = new URLSearchParams(window.location.search);
  const isResetFlow = urlParams.get('reset') === '1' || window.location.hash.includes('type=recovery');

  if (currentUser || isResetFlow) {
    if (isResetFlow) {
      showAuth('update-password');
      return;
    }

    const name    = currentUser?.user_metadata?.full_name || currentUser?.email || 'Account';
    const initial = name.charAt(0).toUpperCase();

    // Update avatar
    if (profileBtn) {
      profileBtn.textContent = initial;
      const charCode = initial.charCodeAt(0);
      profileBtn.style.background = `linear-gradient(135deg, ${getColor(charCode)}, #ffbf00)`;
      profileBtn.style.display = 'flex';
    }

    // Dropdown header
    if (dropdown) dropdown.textContent = name;

    // Landing hero buttons change for logged-in users
    if (heroActions && currentUser) {
      heroActions.innerHTML = `
        <button class="btn btn-amber" onclick="newTrip()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
          New Trip
        </button>
        <button class="btn btn-outline" onclick="openTripsPanel()">My Dashboard</button>
      `;
    }

    if (currentUser) {
      if (urlParams.has('id')) {
        const id = urlParams.get('id');
        
        // Re-evaluate owner status even if trip ID is same (auth might have just arrived)
        const tKey = tripKey(id);
        const tData = lsGet(tKey);
        if (tData) {
          isTripOwner = !!(currentUser && tData.ownerId && currentUser.id === tData.ownerId) ||
                        !!(currentUser && tData.user_id && currentUser.id === tData.user_id);
        }

        if (currentTripId !== id) {
          currentTripPhase = 'view';
          loadTrip(id).then(ok => {
            if (ok) { startRealtime(id); showApp(); }
            else showLanding();
          });
        } else {
          showApp();
          // Ensure trip is saved to account if logged in now
          if (!isTripOwner) saveTripToAccount(id, 'Shared Trip');
        }
      }
      else if (isResetFlow) {
        // Just finished reset? Clean URL
        const newUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, '', newUrl);
        showLanding();
      } else if (currentTripId) {
        showApp();
      } else {
        // Logged in normally? Go to landing/homepage
        showLanding();
      }
    }
  } else {
    if (profileBtn) profileBtn.style.display = 'none';
    if (heroActions) {
      heroActions.innerHTML = `
        <button class="btn btn-amber" onclick="guardedShowAuth('signup')">Get Started Free</button>
        <button class="btn btn-outline" onclick="guardedShowAuth('login')">Login</button>
      `;
    }
    if (!urlParams.has('id') && !currentTripId) {
      showLanding();
    }
  }
};

/**
 * guardedShowAuth — only opens auth if not already logged in.
 * This prevents auth page from opening after a successful login.
 */
window.guardedShowAuth = (mode) => {
  if (currentUser) {
    // Already logged in — go straight to app/dashboard
    if (currentTripId) showApp();
    else openTripsPanel();
    return;
  }
  showAuth(mode);
};

window.performAuth = async (type) => {
  if (!supabaseClient) return toast('Not connected to server');
  const email    = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value.trim();
  
  const btnId = type === 'login' ? 'authBtnLogin' : (type === 'signup' ? 'authBtnSignup' : 'authBtnForgot');
  const btn = document.getElementById(btnId);
  if (!email && type !== 'update-password') return toast('Please enter email');
  
  if ((type === 'login' || type === 'signup') && !password) {
    return toast('Please enter password');
  }
  if ((type === 'login' || type === 'signup') && password.length < 6) {
    return toast('Password must be at least 6 characters');
  }

  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Processing…';
  toast('Processing, please wait...', 10000);

  let response;
  if (type === 'signup') {
    const name = document.getElementById('authName').value.trim();
    if (!name) { toast('Please enter your name'); btn.disabled = false; btn.textContent = orig; return; }
    response = await supabaseClient.auth.signUp({
      email, password,
      options: { data: { full_name: name }, emailRedirectTo: window.location.origin }
    });
  } else if (type === 'login') {
    response = await supabaseClient.auth.signInWithPassword({ email, password });
  } else if (type === 'forgot') {
    response = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname + '?reset=1'
    });
  }

  btn.disabled = false; btn.textContent = orig;
  const { data, error } = response;

  if (error) { toast(error.message); return; }
  
  if (type === 'forgot') {
    toast('Reset link sent to your email! ✉️');
    toggleAuthMode('login');
  } else if (type === 'signup' && !data.session) {
    toast('Check your email to confirm ✉️');
  } else {
    if (data.session) { 
      currentUser = data.user; 
      await syncTripsFromSupabase();
      updateAuthUI(); 
    }
  }
};

window.performPasswordUpdate = async () => {
  if (!supabaseClient) return toast('Not connected to server');
  const password = document.getElementById('authNewPassword').value.trim();
  if (!password || password.length < 6) return toast('Password must be at least 6 characters');

  const btn = document.getElementById('authBtnUpdate');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  toast('Updating password, please wait...', 10000);

  const { error } = await supabaseClient.auth.updateUser({ password });
  
  btn.disabled = false;
  btn.textContent = 'Update Password';

  if (error) { toast(error.message); }
  else {
    toast('Password updated! You are now logged in. 🎉');
    const newUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, '', newUrl);
    updateAuthUI();
  }
};

window.performLogout = async () => {
  closeManageAccount();
  
  // Clear all local storage data related to this app
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LS_PREFIX)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));

  if (supabaseClient) await supabaseClient.auth.signOut();
  location.reload();
};

window.toggleAuthMode = (mode) => {
  const isSignup = mode === 'signup';
  const isForgot = mode === 'forgot';
  const isUpdate = mode === 'update-password';
  const authBox = document.querySelector('.auth-box');
  if (authBox) authBox.dataset.mode = mode;

  document.getElementById('authTitle').textContent = isForgot ? 'Reset Password' : (isUpdate ? 'New Password' : (isSignup ? 'Join Splitaway' : 'Welcome Back'));
  document.getElementById('authSub').textContent = isForgot ? 'We will send a recovery link to your email.' : (isUpdate ? 'Set a fresh password for your account.' : 'Join the new standard of trip splitting.');
  
  document.getElementById('authNameGroup').style.display     = isSignup ? 'block' : 'none';
  document.getElementById('authPasswordGroup').style.display = (isSignup || mode === 'login') ? 'block' : 'none';
  document.getElementById('authUpdateGroup').style.display   = isUpdate ? 'block' : 'none';
  
  document.getElementById('authBtnLogin').style.display  = mode === 'login' ? 'block' : 'none';
  document.getElementById('authBtnSignup').style.display = isSignup ? 'block' : 'none';
  document.getElementById('authBtnForgot').style.display = isForgot ? 'block' : 'none';
  document.getElementById('authBtnUpdate').style.display = isUpdate ? 'block' : 'none';

  const forgotLink = document.getElementById('authForgotLink');
  if (forgotLink) forgotLink.style.display = mode === 'login' ? 'block' : 'none';

  const link = document.getElementById('authToggleLink');
  if (isUpdate) {
     link.style.display = 'none';
  } else {
     link.style.display = 'block';
     if (isForgot) {
       link.textContent = 'Back to sign in';
       link.onclick = () => { toggleAuthMode('login'); return false; };
     } else if (isSignup) {
       link.textContent = 'Already have an account? Sign in';
       link.onclick = () => { toggleAuthMode('login'); return false; };
     } else {
       link.textContent = "Don't have an account? Sign up";
       link.onclick = () => { toggleAuthMode('signup'); return false; };
     }
  }
};

// ══════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════

window.handleLogoClick = (e) => {
  e.preventDefault();
  if (currentUser) {
    if (hasUnsavedEdits) {
      showUnsavedModal(() => { hasUnsavedEdits = false; showLanding(); });
    } else {
      showLanding();
    }
  } else {
    showLanding();
  }
};

window.showLanding = () => {
  setView('landing');
};

window.showAuth = (mode) => {
  // Guard: if already logged in, don't show auth
  if (currentUser && mode !== 'update-password') { showLanding(); return; }
  setView('auth');
  toggleAuthMode(mode || 'login');
};

window.showApp = () => {
  setView('app');
  // Push a history entry so the back button triggers popstate
  if (!history.state?.splitawayApp) {
    history.pushState({ splitawayApp: true, tripId: currentTripId }, '');
  }
  const appEl = document.getElementById('app');
  if (appEl) {
    // Set phase class without wiping out is-owner
    appEl.classList.remove('phase-name', 'phase-friends', 'phase-done', 'phase-view');
    appEl.classList.add('phase-' + currentTripPhase);
    
    if (isTripOwner) appEl.classList.add('is-owner');
    else appEl.classList.remove('is-owner');

    const sActions = document.getElementById('settleActions');
    if (sActions) sActions.style.display = (!isTripOwner && currentTripPhase === 'view') ? 'block' : 'none';
  }
  refreshAll();

  // Load suggestions for the owner
  if (isTripOwner && currentTripPhase === 'view' && currentTripId) {
    loadSuggestions(currentTripId);
  }
};

function setView(name) {
  const landingView = document.getElementById('landingView');
  const authView    = document.getElementById('authView');
  const appSection  = document.getElementById('appSection');
  [landingView, authView, appSection].forEach(el => {
    if (el) { el.classList.remove('active'); el.style.display = ''; }
  });

  if (name === 'landing' && landingView) landingView.classList.add('active');
  if (name === 'auth'    && authView)    authView.classList.add('active');
  if (name === 'app'     && appSection)  appSection.classList.add('active');
}

window.goToPhase = (p) => {
  if (p === 'friends') {
    const name = document.getElementById('tripName')?.value?.trim();
    if (!name) { toast('Please enter a trip name first'); return; }
  }
  if (p === 'done' && friends.length === 0) {
    toast('Add at least one friend first'); return;
  }
  currentTripPhase = p;
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.classList.remove('phase-name', 'phase-friends', 'phase-done', 'phase-view');
    appEl.classList.add('phase-' + p);
  }
  if (p === 'done' || p === 'view') refreshAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (p !== 'view') markUnsaved();
};

// ══════════════════════════════════════════
// BACK BUTTON / UNSAVED CHANGES GUARD
// ══════════════════════════════════════════

function setupBackButtonGuard() {
  // Warn on tab close / reload when there are unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedEdits) {
      e.preventDefault();
      e.returnValue = ''; // required for some browsers
    }
  });

  // Intercept browser/hardware back button
  window.addEventListener('popstate', (e) => {
    const appActive = document.getElementById('appSection')?.classList.contains('active');
    if (!appActive) return;

    if (hasUnsavedEdits) {
      // Re-push the state to "cancel" the back navigation
      history.pushState({ splitawayApp: true, tripId: currentTripId }, '');
      // Show the modal; on "Leave" we'll navigate away
      showUnsavedModal(() => {
        hasUnsavedEdits = false;
        showLanding();
      });
    } else {
      // No unsaved changes — just go to landing
      showLanding();
    }
  });
}

// ── UNSAVED MODAL ──

window.showUnsavedModal = (onLeaveCallback) => {
  unsavedModalCallback = onLeaveCallback || null;
  document.getElementById('unsavedModal')?.classList.add('active');
};

window.closeUnsavedModal = () => {
  document.getElementById('unsavedModal')?.classList.remove('active');
  unsavedModalCallback = null;
};

window.modalSaveAndLeave = async () => {
  const btn = document.getElementById('modalSaveBtn');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  await manualSave();
  if (btn) { btn.textContent = 'Save & Leave'; btn.disabled = false; }
  closeUnsavedModal();
  if (typeof unsavedModalCallback === 'function') unsavedModalCallback();
  else showLanding();
};

window.modalDiscardAndLeave = () => {
  hasUnsavedEdits = false;
  closeUnsavedModal();
  if (typeof unsavedModalCallback === 'function') unsavedModalCallback();
  else showLanding();
};

// ══════════════════════════════════════════
// TRIP LOGIC
// ══════════════════════════════════════════

window.loadOrCreateDefault = async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const urlId = urlParams.get('id');
  if (urlId) {
    currentTripPhase = 'view';
    const ok = await loadTrip(urlId);
    if (ok) { 
      startRealtime(urlId); 
      showApp(); 
      // If we're a guest, try to save this trip to our account index
      if (currentUser && !isTripOwner) {
        const cachedTrip = lsGet(tripKey(urlId));
        saveTripToAccount(urlId, cachedTrip?.name || 'Shared Trip');
      }
      return; 
    }
  }
  showLanding();
};

async function processSyncQueue() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    isOffline = true;
    return;
  }
  if (!supabaseClient || !currentUser || isSyncing || syncQueue.length === 0) return;
  
  isSyncing = true;
  const queue = [...syncQueue];
  syncQueue = [];
  
  const failedItems = [];
  
  for (const item of queue) {
    try {
      if (item.type === 'save') {
        const success = await pushTripToSupabase(item.data);
        if (success) {
          storeTripLocally(tripKey(item.tripId), item.data, {
            syncedToSupabase: true,
            ownerId: item.data.ownerId || currentUser.id
          });
        } else {
          failedItems.push(item);
        }
      }
    } catch (error) {
      console.error('Sync queue item failed:', error);
      failedItems.push(item);
    }
  }
  
  // Put failed items back in queue
  if (failedItems.length > 0) {
    syncQueue.unshift(...failedItems);
    isOffline = true;
    // Schedule retry
    if (syncRetryTimer) clearTimeout(syncRetryTimer);
    syncRetryTimer = setTimeout(() => processSyncQueue(), 30000);
  } else {
    isOffline = false;
    lastSyncTime = new Date().toISOString();
  }
  
  isSyncing = false;
}

// Online/offline detection
window.addEventListener('online', () => {
  isOffline = false;
  if (syncQueue.length > 0) {
    processSyncQueue();
  } else {
    syncTripsFromSupabase();
  }
});

window.addEventListener('offline', () => {
  isOffline = true;
});

// Enhanced loadTrip function
async function loadTrip(id) {
  hasUnsavedEdits = false;
  const ind = document.getElementById('saveIndicator');
  if (ind) ind.style.display = 'none';

  if (isTripDeleted(id)) return false;

  const localKey = tripKey(id);
  const localData = lsGetWithMeta(localKey);
  const localTrip = localData?.data;

  if (!supabaseClient) {
    // Offline mode - use local data only
    if (localTrip) { 
      applyTripData(localTrip); 
      return true; 
    }
    return false;
  }

  try {
    // Fetch from server
    const { data: trip, error } = await supabaseClient
      .from('trips')
      .select('*')
      .eq('id', id)
      .single();
      
    if (error) {
      // Network/server error - fall back to local data if we have it
      if (localTrip) {
        applyTripData(localTrip);
        return true;
      }
      return false;
    }

    if (!trip) {
      // No server row - only trust an unsynced local draft
      if (localTrip && localTrip.syncedToSupabase !== true && (!localTrip.ownerId || !currentUser || localTrip.ownerId === currentUser.id)) { 
        applyTripData(localTrip); 
        return true; 
      }
      return false;
    }

    // Fetch expenses
    const { data: exps } = await supabaseClient
      .from('expenses')
      .select('*')
      .eq('trip_id', id);

    const serverData = {
      id: trip.id,
      name: trip.name,
      currency: trip.currency || { sym: '₹', code: 'INR' },
      friends: trip.friends || [],
      expenses: (exps || []).map(e => ({ ...e, desc: e.description })),
      updated_at: trip.updated_at || new Date().toISOString(),
      syncedToSupabase: true,
      ownerId: trip.user_id || null
    };

    // Conflict resolution
    if (!localTrip) {
      // No local copy, use server data
      applyTripData(serverData);
      storeTripLocally(localKey, serverData, { syncedToSupabase: true, ownerId: trip.user_id || null });
    } else {
      // Compare timestamps
      const serverTime = new Date(serverData.updated_at).getTime();
      const localTime = new Date(localTrip.updated_at || 0).getTime();
      const canWriteTrip = !localTrip.ownerId || localTrip.ownerId === currentUser?.id;
      
      if (serverTime > localTime) {
        // Server is newer, update local
        applyTripData(serverData);
        storeTripLocally(localKey, serverData, { syncedToSupabase: true, ownerId: trip.user_id || null });
      } else if (localTime > serverTime) {
        // Local is newer, push to server
        if (canWriteTrip && await pushTripToSupabase(localTrip)) {
          storeTripLocally(localKey, localTrip, {
            syncedToSupabase: true,
            ownerId: localTrip.ownerId || currentUser?.id || null
          });
          applyTripData(localTrip);
        } else {
          storeTripLocally(localKey, serverData, { syncedToSupabase: true, ownerId: trip.user_id || null });
          applyTripData(serverData);
        }
      } else {
        // Times are equal, use local
        applyTripData(localTrip);
      }
    }
    
    saveTripToIndex(id);
    return true;
    
  } catch (e) { 
    console.error('loadTrip error:', e); 
    // Fallback to local data
    if (localTrip) { 
      applyTripData(localTrip); 
      return true; 
    }
    return false; 
  }
}

function applyTripData(data) {
  currentTripId  = data.id;
  friends        = data.friends  || [];
  expenses       = data.expenses || [];
  if (data.currency) currency = data.currency;
  selectedSplit  = new Set(data.friends || []);
  doneSettlements.clear();
  
  document.querySelectorAll('.currency-sym-label').forEach(el => el.textContent = currency.sym);
  
  isTripOwner    = !!(currentUser && data.ownerId && currentUser.id === data.ownerId) ||
                   !!(currentUser && data.user_id && currentUser.id === data.user_id);
                   
  const appEl = document.getElementById('app');
  if (appEl) {
    if (isTripOwner) appEl.classList.add('is-owner');
    else appEl.classList.remove('is-owner');
  }

  const nameEl   = document.getElementById('tripName');
  const titleEl  = document.getElementById('tripTitleDisplay');
  if (nameEl)  nameEl.value        = data.name || '';
  if (titleEl) titleEl.textContent = data.name || 'Trip Details';
  
  if (isTripOwner) loadSuggestions(data.id);
  
  refreshAll();
}

window.newTrip = () => {
  // Guard if editing existing trip
  if (hasUnsavedEdits) {
    showUnsavedModal(() => _createNewTrip());
    return;
  }
  _createNewTrip();
};

function _createNewTrip() {
  const id = uid();
  currentTripId = id;
  friends = []; expenses = [];
  selectedSplit = new Set();
  hasUnsavedEdits = false;
  isTripOwner = true;

  const nameEl  = document.getElementById('tripName');
  const titleEl = document.getElementById('tripTitleDisplay');
  if (nameEl)  nameEl.value        = '';
  if (titleEl) titleEl.textContent = 'Trip Details';

  closeTripsPanel();
  goToPhase('name');
  showApp();

  const url = new URL(window.location);
  url.searchParams.set('id', id);
  window.history.pushState({ splitawayApp: true, tripId: id }, '', url);
}

// ── Friends ──

window.addFriend = () => {
  const input = document.getElementById('friendNameInput');
  const n = input.value.trim();
  if (!n) return;
  if (friends.includes(n)) { toast(`${n} is already added`); return; }
  if (friends.length >= 15) { toast('Maximum 15 friends per trip'); return; }
  friends.push(n);
  input.value = '';
  input.focus();
  refreshAll(); markUnsaved();
};

window.removeFriend = (i) => {
  const name = friends[i];
  friends.splice(i, 1);
  expenses = expenses.filter(e => e.payer !== name && !e.split.includes(name));
  refreshAll(); markUnsaved();
};

// ── Expenses ──

window.addExpense = () => {
  const d = document.getElementById('expDesc').value.trim();
  const a = parseFloat(document.getElementById('expAmount').value);
  const p = document.getElementById('expPayer').value;
  const s = [...selectedSplit];

  if (!d)           return toast('Please enter a description');
  if (isNaN(a) || a <= 0) return toast('Please enter a valid amount');
  if (!p)           return toast('Please select who paid');
  if (!s.length)    return toast('Please select at least one person to split with');

  expenses.push({
    id:     Date.now(),
    desc:   d,
    amount: a,
    payer:  p,
    cat:    document.getElementById('expCat').value,
    split:  s
  });

  document.getElementById('expDesc').value   = '';
  document.getElementById('expAmount').value = '';
  selectedSplit.clear();

  refreshAll(); markUnsaved();
  toast('Expense added ✓');
};

window.removeExpense = (id) => {
  expenses = expenses.filter(e => e.id !== id);
  refreshAll(); markUnsaved();
};

// ══════════════════════════════════════════
// RENDER / REFRESH
// ══════════════════════════════════════════

window.refreshAll = () => {
  refreshFriends();
  refreshPayerSelect();
  refreshSplitGrid();
  refreshExpensesList();
  refreshSummary();
};

function refreshFriends() {
  const grid = document.getElementById('friendsGrid');
  if (!grid) return;

  if (!friends.length) {
    grid.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No friends added yet</div>';
  } else {
    grid.innerHTML = friends.map((f, i) => {
      const escapedF = escHtml(f);
      const initial = escHtml(f[0].toUpperCase());
      return `
        <div class="friend-chip">
          <div class="f-avatar" style="background:${getColor(i)}">${initial}</div>
          <span class="f-name" title="${escapedF}">${escapedF}</span>
          <button class="f-remove" onclick="removeFriend(${i})" title="Remove ${escapedF}">✕</button>
        </div>`;
    }).join('');
  }

  const cnt = document.getElementById('friendCount');
  if (cnt) cnt.textContent = friends.length;
}

function refreshPayerSelect() {
  const sel = document.getElementById('expPayer');
  if (sel) sel.innerHTML = friends.map(f => {
    const escapedF = escHtml(f);
    return `<option value="${escapedF}">${escapedF}</option>`;
  }).join('');
}

function refreshSplitGrid() {
  const grid = document.getElementById('splitGrid');
  if (!grid) return;
  grid.innerHTML = friends.map((f, i) => {
    const sel = selectedSplit.has(f);
    const escapedF = escHtml(f);
    const initial = escHtml(f[0].toUpperCase());
    return `
      <div class="split-check ${sel ? 'selected' : ''}" onclick="toggleSplit('${escHtml(escJs(f))}')">
        <div style="display:flex;align-items:center;justify-content:center;gap:7px">
          <div style="width:20px;height:20px;border-radius:5px;background:${sel ? '#1a1209' : getColor(i)};display:grid;place-items:center;font-size:9px;font-weight:900;color:${sel ? 'var(--amber)' : '#fff'}">${initial}</div>
          <span style="font-size:12px">${escapedF}</span>
        </div>
      </div>`;
  }).join('');
}

window.toggleSplit = (n) => {
  if (selectedSplit.has(n)) selectedSplit.delete(n); else selectedSplit.add(n);
  refreshSplitGrid();
};

window.selectAllSplit = () => { friends.forEach(f => selectedSplit.add(f)); refreshSplitGrid(); };
window.clearSplit     = () => { selectedSplit.clear(); refreshSplitGrid(); };

function refreshExpensesList() {
  const cnt  = document.getElementById('expCount');
  const list = document.getElementById('expensesList');
  if (cnt)  cnt.textContent = expenses.length;
  if (!list) return;

  if (!expenses.length) {
    list.innerHTML = '<li style="text-align:center;padding:24px 0;color:var(--text-muted);font-size:13px">No expenses yet — add one above</li>';
    return;
  }

  list.innerHTML = expenses.map(e => `
    <li class="expense-item">
      <div style="flex:1;min-width:0">
        <div class="expense-desc">${escHtml(e.desc)}</div>
        <div class="expense-meta">Paid by ${escHtml(e.payer)} · ${escHtml(e.cat || '')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-shrink:0">
        <span class="expense-amt">${currency.sym}${Number(e.amount).toLocaleString('en-IN', {maximumFractionDigits:2})}</span>
        <button class="expense-delete" onclick="removeExpense(${e.id})" title="Remove">✕</button>
      </div>
    </li>
  `).join('');
}

function refreshSummary() {
  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const totalEl = document.getElementById('totalSpent');
  if (totalEl) totalEl.textContent = currency.sym + total.toLocaleString('en-IN', { maximumFractionDigits: 2 });

  // 1. Calculate Base Balances (excluding Settlement expenses)
  const balBase = {};
  friends.forEach(f => balBase[f] = 0);
  expenses.filter(e => e.cat !== 'Settlement').forEach(e => {
    const share = Number(e.amount) / e.split.length;
    if (balBase[e.payer] !== undefined) balBase[e.payer] += Number(e.amount);
    e.split.forEach(p => { if (balBase[p] !== undefined) balBase[p] -= share; });
  });

  // 2. Calculate Actual Balances (including Settlements) for display
  const balActual = { ...balBase };
  expenses.filter(e => e.cat === 'Settlement').forEach(e => {
    if (balActual[e.payer] !== undefined) balActual[e.payer] += Number(e.amount);
    if (e.split && e.split[0] && balActual[e.split[0]] !== undefined) {
       balActual[e.split[0]] -= Number(e.amount);
    }
  });

  // Render Balances List (actual debt)
  const bList = document.getElementById('balancesList');
  if (bList) {
    bList.innerHTML = friends.map(f => {
      const b   = balActual[f];
      const cls = b > 0.01 ? 'bal-pos' : b < -0.01 ? 'bal-neg' : 'bal-zero';
      const txt = b > 0.01 ? `gets ${currency.sym}${b.toFixed(2)}` : b < -0.01 ? `owes ${currency.sym}${Math.abs(b).toFixed(2)}` : 'settled ✓';
      return `<li class="balance-row"><span>${escHtml(f)}</span><span class="${cls}">${txt}</span></li>`;
    }).join('');
  }

  // Render Settlements (using Base Balances for the "Original" debt)
  renderSettle(balBase);
}

function renderSettle(balBase) {
  const sList = document.getElementById('settleList');
  if (!sList) return;
  
  settlements = minimizeTransactions(balBase);

  // Sync the text of the header button with current owner/guest state
  const recordBtn = document.getElementById('btnRecordPayment');
  if (recordBtn) {
    recordBtn.textContent = isTripOwner ? 'Record Payment' : 'Suggest Payment';
  }
  
  const activeItems = settlements.length
    ? settlements.map((s, idx) => {
        const key = s.from + '->' + s.to;
        const isDone = doneSettlements.has(key);
        const paidAmt = expenses
          .filter(e => e.cat === 'Settlement' && e.payer === s.from && e.split && e.split[0] === s.to)
          .reduce((sum, e) => sum + Number(e.amount), 0);
          
        const remaining = s.amount - paidAmt;
        if (remaining < 0.01) return ''; // Fully paid

        const escFrom = escHtml(escJs(s.from));
        const escTo = escHtml(escJs(s.to));

        return `
          <div class="settle-item ${isDone ? 'done' : ''}">
            <input type="checkbox" class="settle-checkbox" ${isDone ? 'checked' : ''} onchange="handleCheckboxSettle('${escFrom}','${escTo}',${remaining},this)">
            <div style="flex:1; display:flex; align-items:center; gap:8px; min-width:0">
              <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${escHtml(s.from)}</span>
              <span class="settle-arrow">→</span>
              <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${escHtml(s.to)}</span>
            </div>
            <div style="text-align:right; flex-shrink:0; margin-left:auto; margin-right:8px">
              <div class="settle-amt" style="font-size:13px">${currency.sym}${Number(remaining).toFixed(2)}</div>
              ${paidAmt > 0 ? `<div style="font-size:9px; color:var(--teal); font-weight:700">Paid: ${currency.sym}${paidAmt.toFixed(2)}</div>` : `<div style="font-size:9px; opacity:0.6">Total: ${currency.sym}${s.amount.toFixed(2)}</div>`}
            </div>
            <button class="btn-settle-action" onclick="openSettleSuggestModal('${escFrom}','${escTo}',${remaining})">Settle</button>
          </div>`;
      }).filter(h => h !== '').join('')
    : '';

  const paidItems = expenses
    .filter(e => e.cat === 'Settlement')
    .map(e => `
      <div class="settle-item" style="opacity:0.8">
        <span style="color:var(--teal)">✓</span>
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${escHtml(e.payer)}</span>
        <span class="settle-arrow">→</span>
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${escHtml(e.split[0])}</span>
        <span class="settle-amt" style="color:var(--teal)">Paid</span>
        <span style="font-size:10px; opacity:0.6">${currency.sym}${Number(e.amount).toFixed(2)}</span>
      </div>
    `).join('');

  sList.innerHTML = (activeItems + paidItems) || '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">All settled! 🎉</div>';
}

async function quickSuggestSettleNoConfirm(from, to, amount) {
  const payload = {
    trip_id: currentTripId,
    description: `Settlement: ${from} → ${to}`,
    amount: amount,
    payer: from,
    cat: 'Settlement',
    split: [to],
    suggester_id: currentUser ? currentUser.id : null
  };

  toast('Sending suggestion, please wait...', 10000);
  const { error } = await supabaseClient.from('expense_suggestions').insert([payload]);
  if (error) {
    toast('Failed to send suggestion: ' + error.message);
  } else {
    toast('Settlement suggestion sent! ✉️', 1500);
    doneSettlements.add(from + '->' + to);
    refreshSummary();
  }
}

window.quickSuggestSettle = async (from, to, amount) => {
  if (!confirm(`Mark that ${from} paid ${to} ${currency.sym}${amount.toFixed(2)}? This will send a suggestion to the trip owner.`)) return;
  await quickSuggestSettleNoConfirm(from, to, amount);
};

window.handleCheckboxSettle = async (from, to, amount, checkboxEl) => {
  if (checkboxEl.checked) {
    const actionText = isTripOwner ? 'record a full payment' : 'suggest a full payment';
    if (!confirm(`Mark that ${from} paid ${to} ${currency.sym}${amount.toFixed(2)}? This will ${actionText}.`)) {
      checkboxEl.checked = false;
      return;
    }

    if (isTripOwner) {
      expenses.push({
        id:     Date.now(),
        desc:   `Settlement: ${from} → ${to}`,
        amount: amount,
        payer:  from,
        cat:    'Settlement',
        split:  [to]
      });
      refreshAll();
      toast('Recording payment, please wait...', 10000);
      await manualSave();
      toast('Payment recorded! ✓', 1500);
    } else {
      await quickSuggestSettleNoConfirm(from, to, amount);
    }
  } else {
    const key = from + '->' + to;
    if (doneSettlements.has(key)) {
      doneSettlements.delete(key);
    }
    refreshSummary();
  }
};

window.openSettleSuggestModal = (from, to, defaultAmount) => {
  const fromSel = document.getElementById('setSugFrom');
  const toSel   = document.getElementById('setSugTo');
  if (fromSel && toSel) {
    const opts = friends.map(f => `<option value="${escHtml(f)}">${escHtml(f)}</option>`).join('');
    fromSel.innerHTML = opts;
    toSel.innerHTML = opts;
    if (from) fromSel.value = from;
    if (to) toSel.value = to;
  }
  
  const amtInput = document.getElementById('setSugAmount');
  if (amtInput) {
    if (defaultAmount !== undefined && defaultAmount !== null) {
      amtInput.value = Number(defaultAmount).toFixed(2);
    } else {
      amtInput.value = '';
    }
  }

  // Dynamically update modal labels based on ownership
  const titleEl = document.querySelector('#settleSuggestModal .modal-title');
  const descEl  = document.querySelector('#settleSuggestModal .modal-desc');
  const btnEl   = document.querySelector('#settleSuggestModal .modal-actions button.btn-amber');

  if (isTripOwner) {
    if (titleEl) titleEl.textContent = 'Record Payment';
    if (descEl) descEl.textContent = 'Record a full or installment payment for this trip.';
    if (btnEl) btnEl.textContent = 'Record Payment';
  } else {
    if (titleEl) titleEl.textContent = 'Suggest Payment';
    if (descEl) descEl.textContent = "Notify the owner that you've settled a debt.";
    if (btnEl) btnEl.textContent = 'Send Suggestion';
  }

  document.getElementById('settleSuggestModal').classList.add('active');
};

window.closeSettleSuggestModal = () => {
  document.getElementById('settleSuggestModal').classList.remove('active');
};

window.submitSettleSuggestion = async () => {
  const from   = document.getElementById('setSugFrom').value;
  const to     = document.getElementById('setSugTo').value;
  const amount = parseFloat(document.getElementById('setSugAmount').value);

  if (from === to) return toast("You can't pay yourself!");
  if (isNaN(amount) || amount <= 0) return toast('Enter a valid amount.');

  if (isTripOwner) {
    expenses.push({
      id:     Date.now(),
      desc:   `Settlement: ${from} → ${to}`,
      amount: amount,
      payer:  from,
      cat:    'Settlement',
      split:  [to]
    });
    refreshAll();
    closeSettleSuggestModal();
    toast('Recording payment, please wait...', 10000);
    await manualSave();
    toast('Payment recorded! ✓', 1500);
  } else {
    await quickSuggestSettleNoConfirm(from, to, amount);
    closeSettleSuggestModal();
  }
};

function minimizeTransactions(bal) {
  const cred = [], debt = [];
  Object.entries(bal).forEach(([p, b]) => {
    if (b > 0.01)  cred.push({ n: p, a:  b });
    else if (b < -0.01) debt.push({ n: p, a: -b });
  });
  const res = []; let ci = 0, di = 0;
  while (ci < cred.length && di < debt.length) {
    const pay = Math.min(cred[ci].a, debt[di].a);
    res.push({ from: debt[di].n, to: cred[ci].n, amount: pay });
    cred[ci].a -= pay; debt[di].a -= pay;
    if (cred[ci].a < 0.01) ci++;
    if (debt[di].a < 0.01) di++;
  }
  return res;
}

// ══════════════════════════════════════════
// SAVE / SYNC
// ══════════════════════════════════════════

function markUnsaved() {
  hasUnsavedEdits = true;
  const ind = document.getElementById('saveIndicator');
  if (!ind) return;
  ind.style.display = 'inline-flex';
  ind.querySelector('span').textContent = 'Unsaved';
  const dot = ind.querySelector('.save-dot');
  if (dot) dot.style.background = '#ff4747';
}

async function deleteTripFromSupabase(tripId, ownerId = currentUser?.id) {
  if (!supabaseClient || !currentUser) return false;

  try {
    if (ownerId && currentUser.id !== ownerId) {
      // Guest leaving: delete from trip_members table instead of trips table
      const { error: memberError } = await supabaseClient
        .from('trip_members')
        .delete()
        .eq('trip_id', tripId)
        .eq('user_id', currentUser.id);

      if (memberError) {
        console.error('Guest leave trip error:', memberError);
        return false;
      }
      return true;
    }

    // Owner deleting: sequentially delete child tables first to avoid foreign key errors
    const { error: expenseError } = await supabaseClient
      .from('expenses')
      .delete()
      .eq('trip_id', tripId);

    if (expenseError) {
      console.error('Delete trip expenses error:', expenseError);
      return false;
    }

    // Also delete any pending suggestions associated with the trip
    try {
      await supabaseClient
        .from('expense_suggestions')
        .delete()
        .eq('trip_id', tripId);
    } catch (sugErr) {
      console.error('Delete suggestions error:', sugErr);
    }

    const { error: membersError } = await supabaseClient
      .from('trip_members')
      .delete()
      .eq('trip_id', tripId);

    if (membersError) {
      console.error('Delete trip members error:', membersError);
    }

    const { error: tripError } = await supabaseClient
      .from('trips')
      .delete()
      .eq('id', tripId)
      .eq('user_id', currentUser.id);

    if (tripError) {
      console.error('Delete trip error:', tripError);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Delete failed:', err);
    return false;
  }
}

async function pushTripToSupabase(tripData) {
  if (!supabaseClient || !currentUser) return false;
  const ownerId = tripData.ownerId || tripData.user_id || currentUser.id;
  if (!ownerId) return false;
  if (tripData.ownerId && currentUser?.id && tripData.ownerId !== currentUser.id) {
    console.warn('Refusing to overwrite a trip owned by another account');
    return false;
  }
  
  try {
    // Create a more robust upsert operation
    const { error: tErr } = await supabaseClient
      .from('trips')
      .upsert({
        id: tripData.id,
        name: tripData.name,
        friends: tripData.friends,
        updated_at: tripData.updated_at || new Date().toISOString(),
        user_id: ownerId,
        currency: tripData.currency || { sym: '₹', code: 'INR' }
      }, { 
        onConflict: 'id',
        ignoreDuplicates: false
      });
      
    if (tErr) { 
      console.error('Push trip error:', tErr); 
      return false; 
    }

    // Delete existing expenses and insert new ones
    const { error: deleteError } = await supabaseClient
      .from('expenses')
      .delete()
      .eq('trip_id', tripData.id);
    if (deleteError) {
      console.error('Clear expenses error:', deleteError);
      return false;
    }
      
    if (tripData.expenses && tripData.expenses.length) {
      const { error: eErr } = await supabaseClient
        .from('expenses')
        .insert(tripData.expenses.map(e => ({
          trip_id:     tripData.id,
          description: e.desc,
          amount:      Number(e.amount),
          payer:       e.payer,
          cat:         e.cat,
          split:       e.split
        })));
        
      if (eErr) { 
        console.error('Push expenses error:', eErr); 
        return false; 
      }
    }
    
    return true;
  } catch (err) { 
    console.error('Push failed:', err); 
    return false; 
  }
}

window.manualSave = async () => {
  if (!currentTripId) return;

  const ind = document.getElementById('saveIndicator');
  if (ind) { 
    ind.style.display = 'inline-flex'; 
    ind.querySelector('span').textContent = 'Saving…'; 
  }

  const name = document.getElementById('tripName')?.value?.trim() || 'Untitled Trip';
  const timestamp = new Date().toISOString();
  const localTrip = lsGet(tripKey(currentTripId)) || {};
  const ownerId = localTrip.ownerId || currentUser?.id || null;

  // 1. Save to localStorage (with sync metadata)
  const tripData = { 
    id: currentTripId, 
    name, 
    friends, 
    expenses, 
    updated_at: timestamp, 
    currency,
    syncedToSupabase: false,
    ownerId
  };
  storeTripLocally(tripKey(currentTripId), tripData, { syncedToSupabase: false, ownerId });
  saveTripToIndex(currentTripId);

  // 2. Save to Supabase (if connected & logged in)
  if (supabaseClient && currentUser) {
    const success = await pushTripToSupabase(tripData);
    if (!success) {
      // Add to sync queue for retry
      syncQueue.push({
        type: 'save',
        tripId: currentTripId,
        data: tripData,
        timestamp: timestamp
      });
      
      if (ind) {
        ind.querySelector('span').textContent = 'Sync Error';
        const dot = ind.querySelector('.save-dot');
        if (dot) dot.style.background = '#ff4747';
        setTimeout(() => { if (!hasUnsavedEdits) ind.style.display = 'none'; }, 3000);
      }
      toast('Saved locally (Sync failed). Will retry automatically.');
      hasUnsavedEdits = false;
      processSyncQueue();
      return;
    }
    storeTripLocally(tripKey(currentTripId), {
      ...tripData,
      syncedToSupabase: true
    }, { syncedToSupabase: true, ownerId });
  } else {
    // Offline mode - add to queue
    syncQueue.push({
      type: 'save',
      tripId: currentTripId,
      data: tripData,
      timestamp: timestamp
    });
    
    if (ind) {
      ind.querySelector('span').textContent = 'Saved Offline';
      const dot = ind.querySelector('.save-dot');
      if (dot) dot.style.background = 'var(--amber)';
    }
    toast('Saved locally. Will sync when online.');
    processSyncQueue();
  }

  hasUnsavedEdits = false;
  if (ind) {
    ind.querySelector('span').textContent = 'Synced ✓';
    const dot = ind.querySelector('.save-dot');
    if (dot) dot.style.background = 'var(--teal)';
    setTimeout(() => { if (!hasUnsavedEdits) ind.style.display = 'none'; }, 2200);
  }
  toast('Trip saved!');
};

// ==========================================
// EXPENSE SUGGESTIONS
// ==========================================

window.openSuggestionModal = () => {
  const payerSel = document.getElementById('sugPayer');
  if (payerSel) payerSel.innerHTML = friends.map(f => `<option value="${escHtml(f)}">${escHtml(f)}</option>`).join('');
  document.getElementById('sugDesc').value = '';
  document.getElementById('sugAmount').value = '';
  sugSplitSelected = new Set(friends);
  refreshSugSplitGrid();
  document.getElementById('suggestionModal').classList.add('active');
};

window.closeSuggestionModal = () => {
  document.getElementById('suggestionModal').classList.remove('active');
};

function refreshSugSplitGrid() {
  const grid = document.getElementById('sugSplitGrid');
  if (!grid) return;
  grid.innerHTML = friends.map((f, i) => {
    const sel = sugSplitSelected.has(f);
    const escapedF = escHtml(f);
    const initial = escHtml(f[0].toUpperCase());
    return `
      <div class="split-check ${sel ? 'selected' : ''}" onclick="toggleSugSplit('${escHtml(escJs(f))}')">
        <div style="display:flex;align-items:center;justify-content:center;gap:7px">
          <div style="width:20px;height:20px;border-radius:5px;background:${sel ? '#1a1209' : getColor(i)};display:grid;place-items:center;font-size:9px;font-weight:900;color:${sel ? 'var(--amber)' : '#fff'}">${initial}</div>
          <span style="font-size:12px">${escapedF}</span>
        </div>
      </div>`;
  }).join('');
}

window.toggleSugSplit = (name) => {
  if (sugSplitSelected.has(name)) sugSplitSelected.delete(name);
  else sugSplitSelected.add(name);
  refreshSugSplitGrid();
};

window.selectAllSugSplit = () => { friends.forEach(f => sugSplitSelected.add(f)); refreshSugSplitGrid(); };
window.clearSugSplit     = () => { sugSplitSelected.clear(); refreshSugSplitGrid(); };

window.submitSuggestion = async () => {
  if (!supabaseClient || !currentUser) { toast('You must be logged in to suggest an expense.'); return; }
  if (isTripOwner) { toast('You already own this trip - just add the expense directly.'); return; }

  const payer  = document.getElementById('sugPayer').value;
  const desc   = document.getElementById('sugDesc').value.trim();
  const amount = parseFloat(document.getElementById('sugAmount').value);
  const cat    = document.getElementById('sugCat').value;
  const split  = [...sugSplitSelected];

  if (!payer)                       return toast('Select who you are from the list.');
  if (!desc)                        return toast('Enter a description.');
  if (isNaN(amount) || amount <= 0) return toast('Enter a valid amount.');
  if (!split.length)                return toast('Select at least one person to split with.');

  toast('Submitting suggestion, please wait...', 10000);
  const { error } = await supabaseClient
    .from('expense_suggestions')
    .insert({
      trip_id:      currentTripId,
      description:  desc,
      amount:       amount,
      payer:        payer,
      cat:          cat,
      split:        split,
      suggester_id: currentUser.id
    });

  if (error) { 
    toast('Failed to submit: ' + error.message); 
    return; 
  }

  toast('Suggestion sent to owner! ✉️', 1500);
  closeSuggestionModal();
};

async function loadSuggestions(tripId) {
  if (!supabaseClient || !currentUser) return;

  const { data, error } = await supabaseClient
    .from('expense_suggestions')
    .select('*')
    .eq('trip_id', tripId)
    .eq('status', 'pending');

  if (!error && data) {
    pendingSuggestions = data;
    renderSuggestions();
  }
}

function renderSuggestions() {
  const card    = document.getElementById('suggestionsCard');
  const list    = document.getElementById('suggestionsList');
  const countEl = document.getElementById('suggestionCount');
  if (!card || !list) return;

  if (pendingSuggestions.length > 0 && isTripOwner) {
    card.style.display = 'block';
    countEl.textContent = pendingSuggestions.length;
  } else {
    card.style.display = 'none';
    return;
  }

  list.innerHTML = pendingSuggestions.map(s => `
    <li class="suggestion-item">
      <div class="suggestion-info">
        <div class="expense-desc">${escHtml(s.description)}</div>
        <div class="expense-meta">
          By <b>${escHtml(s.payer)}</b> &middot; ${escHtml(s.cat || '')}
          <div class="suggestion-split-info">Split: ${(s.split || []).map(escHtml).join(', ')}</div>
        </div>
      </div>
      <div class="suggestion-actions">
        <span class="suggestion-amt">${currency.sym}${Number(s.amount).toLocaleString('en-IN', {maximumFractionDigits:2})}</span>
        <div class="suggestion-btns">
          <button class="btn btn-accept" onclick="acceptSuggestion(${s.id})">Accept</button>
          <button class="btn btn-reject" onclick="rejectSuggestion(${s.id})">Reject</button>
        </div>
      </div>
    </li>
  `).join('');
}

window.acceptSuggestion = async (id) => {
  const suggestion = pendingSuggestions.find(s => s.id === id);
  if (!suggestion) return;

  expenses.push({
    id:     Date.now(),
    desc:   suggestion.description,
    amount: suggestion.amount,
    payer:  suggestion.payer,
    cat:    suggestion.cat,
    split:  suggestion.split || []
  });

  toast('Accepting expense, please wait...', 10000);
  await supabaseClient.from('expense_suggestions').delete().eq('id', id);
  await manualSave();
  toast('Expense accepted! ✓', 1500);
  pendingSuggestions = pendingSuggestions.filter(s => s.id !== id);
  renderSuggestions();
  refreshAll();
};

window.rejectSuggestion = async (id) => {
  toast('Rejecting suggestion...', 10000);
  await supabaseClient.from('expense_suggestions').delete().eq('id', id);
  toast('Suggestion rejected.', 1500);
  pendingSuggestions = pendingSuggestions.filter(s => s.id !== id);
  renderSuggestions();
};

async function syncTripsFromSupabase() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    isOffline = true;
    return;
  }
  if (!supabaseClient || !currentUser) return;
  
  try {
    isSyncing = true;

    // Retry any pending deletes before syncing fresh data
    for (const deletedTrip of getDeletedTrips()) {
      const removed = await deleteTripFromSupabase(deletedTrip.id, deletedTrip.ownerId || currentUser.id);
      if (removed) forgetDeletedTrip(deletedTrip.id);
    }
    
    // Fetch trips I own
    const { data: owned, error: err1 } = await supabaseClient
      .from('trips')
      .select('*, expenses(*)')
      .eq('user_id', currentUser.id)
      .order('updated_at', { ascending: false });

    // Fetch trips I am a member of
    const { data: memberData, error: err2 } = await supabaseClient
      .from('trip_members')
      .select('trip_id, trips(*, expenses(*))')
      .eq('user_id', currentUser.id);

    if (err1) throw err1;

    // Combine results
    const trips = [...(owned || [])];
    if (memberData) {
      memberData.forEach(m => {
        if (m.trips && !trips.some(t => t.id === m.trips.id)) {
          trips.push(m.trips);
        }
      });
    }

    // Process each trip with conflict resolution
    for (const serverTrip of (trips || [])) {
      const localKey = tripKey(serverTrip.id);
      const localData = lsGetWithMeta(localKey);
      const localTrip = localData?.data;
      if (isTripDeleted(serverTrip.id)) {
        continue;
      }
      
      if (!localTrip) {
        // No local copy, use server data
        const tripData = {
          id: serverTrip.id,
          name: serverTrip.name,
          currency: serverTrip.currency || { sym: '₹', code: 'INR' },
          friends: serverTrip.friends || [],
          expenses: (serverTrip.expenses || []).map(e => ({ ...e, desc: e.description })),
          updated_at: serverTrip.updated_at,
          syncedToSupabase: true,
          ownerId: serverTrip.user_id || null
        };
        storeTripLocally(localKey, tripData, { syncedToSupabase: true, ownerId: serverTrip.user_id || null });
        saveTripToIndex(serverTrip.id);
      } else {
        // Conflict resolution: compare timestamps
        const serverTime = new Date(serverTrip.updated_at || 0).getTime();
        const localTime = new Date(localTrip.updated_at || 0).getTime();
        const canWriteTrip = !localTrip.ownerId || localTrip.ownerId === currentUser.id;
        
        if (serverTime > localTime) {
          // Server is newer, update local
          const tripData = {
            id: serverTrip.id,
            name: serverTrip.name,
            currency: serverTrip.currency || { sym: '₹', code: 'INR' },
            friends: serverTrip.friends || [],
            expenses: (serverTrip.expenses || []).map(e => ({ ...e, desc: e.description })),
            updated_at: serverTrip.updated_at,
            syncedToSupabase: true,
            ownerId: serverTrip.user_id || null
          };
          storeTripLocally(localKey, tripData, { syncedToSupabase: true, ownerId: serverTrip.user_id || null });
          if (serverTrip.id === currentTripId) {
            applyTripData(tripData);
          }
        } else if (localTime > serverTime) {
          // Local is newer, push to server
          if (canWriteTrip) {
            const pushed = await pushTripToSupabase(localTrip);
            if (pushed) {
              storeTripLocally(localKey, localTrip, {
                syncedToSupabase: true,
                ownerId: localTrip.ownerId || currentUser.id
              });
            } else {
              storeTripLocally(localKey, localTrip, {
                syncedToSupabase: false,
                ownerId: localTrip.ownerId || currentUser.id
              });
            }
            if (serverTrip.id === currentTripId) {
              applyTripData(localTrip);
            }
          } else {
            const serverFallback = {
              id: serverTrip.id,
              name: serverTrip.name,
              currency: serverTrip.currency || currency,
              friends: serverTrip.friends || [],
              expenses: (serverTrip.expenses || []).map(e => ({ ...e, desc: e.description })),
              updated_at: serverTrip.updated_at,
              syncedToSupabase: true,
              ownerId: serverTrip.user_id || null
            };
            storeTripLocally(localKey, serverFallback, { syncedToSupabase: true, ownerId: serverTrip.user_id || null });
            if (serverTrip.id === currentTripId) {
              applyTripData(serverFallback);
            }
          }
        }
        // If times are equal, no action needed
      }
    }

    // Handle local trips not on server
    const serverIds = new Set((trips || []).map(t => t.id));
    const localIds = lsGet(LS_INDEX) || [];
    for (const localId of localIds) {
      if (serverIds.has(localId) || isTripDeleted(localId)) continue;

      const localTrip = lsGet(tripKey(localId));
      if (!localTrip) {
        removeTripFromLocalCache(localId);
        continue;
      }

      if (localTrip.syncedToSupabase === true) {
        removeTripFromLocalCache(localId);
        continue;
      }

      if (await pushTripToSupabase(localTrip)) {
        storeTripLocally(tripKey(localId), localTrip, {
          syncedToSupabase: true,
          ownerId: localTrip.ownerId || currentUser.id
        });
      }
    }

    lastSyncTime = new Date().toISOString();
    renderTripsPanel();
    
  } catch (err) { 
    console.error('Sync failed:', err);
    isOffline = true;
    // Schedule retry
    if (syncRetryTimer) clearTimeout(syncRetryTimer);
    syncRetryTimer = setTimeout(() => syncTripsFromSupabase(), 30000); // Retry in 30 seconds
  } finally {
    isSyncing = false;
  }
}

async function saveTripToAccount(tripId, tripName) {
  if (!currentUser) return;
  
  // 1. Save to local index for current session visibility
  saveTripToIndex(tripId);

  // 2. Try to save to Supabase trip_members table if it exists
  try {
    await supabaseClient.from('trip_members').upsert([{ 
      trip_id: tripId, 
      user_id: currentUser.id 
    }], { onConflict: 'trip_id,user_id' });
  } catch(e) {
    console.log("Supabase member sync skipped:", e);
  }
}

function saveTripToIndex(id) {
  const index = lsGet(LS_INDEX) || [];
  const next = [id, ...index.filter(x => x !== id)];
  lsSet(LS_INDEX, next);
}

// ══════════════════════════════════════════
// TRIPS PANEL
// ══════════════════════════════════════════

window.openTripsPanel = () => {
  document.getElementById('tripsOverlay')?.classList.add('active');
  document.getElementById('tripsPanel')?.classList.add('active');
  renderTripsPanel();
};

window.closeTripsPanel = () => {
  document.getElementById('tripsOverlay')?.classList.remove('active');
  document.getElementById('tripsPanel')?.classList.remove('active');
};

function renderTripsPanel() {
  const ids  = (lsGet(LS_INDEX) || []).filter(id => !isTripDeleted(id));
  const body = document.getElementById('tripsPanelBody');
  if (!body) return;

  if (!ids.length) {
    body.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--text-muted);font-size:13px">No saved trips yet</div>';
    return;
  }

  body.innerHTML = ids.map(id => {
    const t = lsGet(tripKey(id));
    if (!t) return '';
    const expCount = t.expenses?.length || 0;
    const total    = (t.expenses || []).reduce((s, e) => s + Number(e.amount), 0);
    const sym      = t.currency?.sym || '₹';
    const escapedId = escHtml(escJs(id));
    return `
      <div class="trip-saved-item" onclick="handleTripSelect('${escapedId}')">
        <div style="flex:1">
          <div class="trip-item-name">${escHtml(t.name || 'Untitled Trip')}</div>
          <div class="trip-item-meta">
            ${t.friends?.length || 0} friends · ${expCount} expense${expCount !== 1 ? 's' : ''}
            ${total > 0 ? ` · ${sym}${total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : ''}
          </div>
        </div>
        <button class="btn trip-delete-btn" onclick="deleteTrip(event, '${escapedId}')" title="Delete Trip">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
        </button>
      </div>`;
  }).join('');
}


window.deleteTrip = async (e, id) => {
  e.stopPropagation();
  if (!confirm('Are you sure you want to delete this trip? This action cannot be undone.')) return;

  const localTrip = lsGet(tripKey(id)) || {};
  rememberDeletedTrip(id, {
    ownerId: localTrip.ownerId || currentUser?.id || null
  });
  removeTripFromLocalCache(id);
  
  if (supabaseClient && currentUser) {
    toast('Deleting trip from server...', 10000);
    const removed = await deleteTripFromSupabase(id, localTrip.ownerId || currentUser.id);
    if (removed) {
      forgetDeletedTrip(id);
      toast('Trip deleted! ✓', 1500);
    } else {
      toast('Local copy removed. Server sync pending.');
    }
  } else {
    toast('Trip removed locally.', 1500);
  }
  
  renderTripsPanel();
  
  if (currentTripId === id) {
    showLanding();
    currentTripId = null;
    friends = [];
    expenses = [];
    settlements = [];
    doneSettlements = new Set();
  }
  toast('Trip deleted.');
};

window.recoverTripManually = async () => {
  const input = document.getElementById('recoverTripInput');
  const id    = input?.value?.trim();
  if (!id) { toast('Please enter a trip ID'); return; }
  currentTripPhase = 'view';
  toast('Recovering trip, please wait...', 10000);
  const ok = await loadTrip(id);
  if (ok) {
    saveTripToIndex(id);
    closeTripsPanel(); showApp();
    toast('Trip recovered! ✈️', 1500);
  } else {
    toast('Trip not found. Check the ID and try again.');
  }
};

// ══════════════════════════════════════════
// ACCOUNT MODAL
// ══════════════════════════════════════════

window.openManageAccount = () => {
  document.getElementById('landingProfileDropdown')?.classList.remove('open');
  if (!currentUser) { toast('Not logged in'); return; }
  
  const name    = currentUser.user_metadata?.full_name || 'Account';
  const email   = currentUser.email || '';
  const initial = name.charAt(0).toUpperCase();

  const avatarEl = document.getElementById('accountAvatarBig');
  const nameEl   = document.getElementById('accountModalName');
  const emailEl  = document.getElementById('accountModalEmail');
  const nameInput = document.getElementById('accountNameInput');

  if (avatarEl) {
    avatarEl.textContent = initial;
    avatarEl.style.background = `linear-gradient(135deg, ${getColor(initial.charCodeAt(0))}, #ffbf00)`;
  }
  if (nameEl) nameEl.textContent = name;
  if (emailEl) emailEl.textContent = email;
  if (nameInput) nameInput.value = name;

  toggleNameEdit(false);
  document.getElementById('manageAccountModal')?.classList.add('active');
};

window.closeManageAccount = () => {
  document.getElementById('manageAccountModal')?.classList.remove('active');
};

window.toggleNameEdit = (show) => {
  const display = document.getElementById('accountNameDisplay');
  const edit    = document.getElementById('accountNameEdit');
  if (display && edit) {
    display.style.display = show ? 'none' : 'flex';
    edit.style.display    = show ? 'flex' : 'none';
    if (show) document.getElementById('accountNameInput')?.focus();
  }
};

window.saveDisplayName = async () => {
  const newName = document.getElementById('accountNameInput')?.value?.trim();
  if (!newName) return toast('Name cannot be empty');
  if (!supabaseClient || !currentUser) return toast('Not connected to server');

  const btn = document.querySelector('#accountNameEdit .btn-amber');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '...';

  toast('Updating name, please wait...', 10000);
  const { data, error } = await supabaseClient.auth.updateUser({
    data: { full_name: newName }
  });

  btn.disabled = false;
  btn.textContent = '✓';

  if (error) { toast(error.message); }
  else {
    currentUser = data.user;
    updateAuthUI();
    document.getElementById('accountModalName').textContent = newName;
    const initial = newName.charAt(0).toUpperCase();
    document.getElementById('accountAvatarBig').textContent = initial;
    document.getElementById('accountAvatarBig').style.background = `linear-gradient(135deg, ${getColor(initial.charCodeAt(0))}, #ffbf00)`;
    toggleNameEdit(false);
    toast('Name updated! ✓');
  }
};

window.sendPasswordReset = async () => {
  const email = currentUser?.email;
  if (!email || !supabaseClient) return toast('Not connected to server');
  
  toast('Sending reset link, please wait...', 10000);
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname + '?reset=1'
  });
  
  if (error) toast(error.message);
  else toast('Reset link sent to your email! ✉️');
};

// ══════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════

window.shareTripLink = async () => {
  if (!currentTripId) { toast('No active trip'); return; }
  
  if (hasUnsavedEdits) {
    await manualSave();
  }

  const url = `${location.origin}${location.pathname}?id=${currentTripId}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => toast('Trip link copied! 🔗'));
  } else {
    prompt('Copy this trip link:', url);
  }
};

window.toast = (m, duration = 2600) => {
  const t = document.getElementById('toast');
  if (!t) { console.log('Toast:', m); return; }
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(t._timer);
  if (duration > 0) {
    t._timer = setTimeout(() => t.classList.remove('show'), duration);
  }
};

window.handleTripSelect = (id) => {
  const loadAction = async () => {
    closeTripsPanel();
    currentTripPhase = 'view';
    toast('Loading trip, please wait...', 10000); 
    const ok = await loadTrip(id);
    if (ok) { 
      startRealtime(id); 
      showApp();
      toast('Trip loaded! ✈️', 1500);
    } else {
      toast('Could not load trip');
    }
  };

  if (hasUnsavedEdits) {
    showUnsavedModal(loadAction);
  } else {
    loadAction();
  }
};

window.toggleProfileDropdown = (id) => {
  const d = document.getElementById(id);
  if (!d) return;
  d.classList.toggle('open');
  // Close on outside click
  if (d.classList.contains('open')) {
    setTimeout(() => {
      const close = (e) => { if (!d.contains(e.target)) { d.classList.remove('open'); document.removeEventListener('click', close); } };
      document.addEventListener('click', close);
    }, 10);
  }
};

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escJs(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// ══════════════════════════════════════════
// GLOBAL EVENTS
// ══════════════════════════════════════════

function setupGlobalEvents() {
  // Trip name → update header title + mark unsaved
  const tripNameInput = document.getElementById('tripName');
  if (tripNameInput) {
    tripNameInput.addEventListener('input', (e) => {
      const title = document.getElementById('tripTitleDisplay');
      if (title) title.textContent = e.target.value || 'Trip Details';
      markUnsaved();
    });
  }

  // Close dropdowns on outside click (profile handled per-dropdown)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.profile-dropdown.open').forEach(d => d.classList.remove('open'));
      closeUnsavedModal();
      closeManageAccount();
      if (typeof closeSuggestionModal === 'function') closeSuggestionModal();
    }
  });
  
  // PWA Install Prompt Logic
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.deferredPrompt = e;
    // Show popup only if not already installed and not recently dismissed
    if (!window.matchMedia('(display-mode: standalone)').matches) {
      const dismissed = localStorage.getItem('pwa_dismissed');
      if (!dismissed || (Date.now() - parseInt(dismissed, 10)) > 86400000) {
        showPwaPopup();
      }
    }
  });
}

window.installPWA = async () => {
  if (window.deferredPrompt) {
    window.deferredPrompt.prompt();
    const { outcome } = await window.deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      closePwaPopup();
      toast('App installed! 🎉');
    }
    window.deferredPrompt = null;
  } else {
    // Fallback for browsers that don't support beforeinstallprompt
    closePwaPopup();
    toast('Use your browser menu → "Add to Home Screen"');
  }
};

// ── PWA popup helpers ──
window.showPwaPopup = () => {
  const popup = document.getElementById('pwaInstallPopup');
  if (!popup) return;
  // Don't show if app is already installed
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  // Respect 24-hour dismissal
  const dismissed = localStorage.getItem('pwa_dismissed');
  if (dismissed && (Date.now() - parseInt(dismissed, 10)) < 86400000) return;

  popup.style.display = 'flex';
};

window.closePwaPopup = () => {
  const popup = document.getElementById('pwaInstallPopup');
  if (!popup) return;
  popup.style.display = 'none';
  // Remember dismissal (24 hours)
  localStorage.setItem('pwa_dismissed', Date.now());
};

// ══════════════════════════════════════════
// REALTIME (Supabase)
// ══════════════════════════════════════════

function startRealtime(id) {
  if (!supabaseClient) return;
  if (realtimeChannel) realtimeChannel.unsubscribe();
  realtimeChannel = supabaseClient.channel('trip:' + id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'trips',    filter: 'id=eq.'        + id }, () => loadTrip(id))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: 'trip_id=eq.'   + id }, () => loadTrip(id))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'expense_suggestions', filter: 'trip_id=eq.' + id }, () => { if (isTripOwner) loadSuggestions(id); })
    .subscribe();
}
