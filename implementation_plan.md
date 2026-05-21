# Implementation Plan — Bug Fixes and Stability Improvements

This implementation plan details the fixes for ten critical technical, usability, security, and PWA-related bugs identified in the Splitaway codebase. These fixes will ensure a robust offline-first experience, correct authorization flows, data sync consistency, and prevent HTML injection/XSS.

## User Review Required

> [!IMPORTANT]
> **Real-time Sync & RLS**: The fix for the guest deletion loop assumes the `trip_members` table handles member association. When a guest leaves/deletes a trip, we will remove their record from `trip_members` instead of deleting the trip itself (which would fail anyway due to Supabase RLS).
> For the owner, deleting a trip will sequentially delete child expenses first to prevent foreign key violations, then delete from `trips` and associated `trip_members`.

> [!NOTE]
> **Settlement Checkmark Key Change**: Instead of referencing transient list indices to mark settlements as done, we will use a persistent string key format `from + '->' + to` to avoid checklist shifting when balances/expenses are updated.

## Proposed Changes

### Application Logic

#### [MODIFY] [app.js](file:///c:/mehta/splitaway/app.js)
- **`loadOrCreateDefault` ReferenceError**: Get the trip name dynamically from the cached `localStorage` trip data instead of referencing the undefined variable `tripData`.
- **New Trip Owner UI**: Set `isTripOwner = true;` inside `_createNewTrip()` to ensure that creators have immediate access to owner-only actions without waiting for a server sync.
- **Background Sync Hijacking**: Ensure background sync in `syncTripsFromSupabase` only updates the active UI/state via `applyTripData()` if the synced trip ID matches the currently viewable `currentTripId`.
- **Settlement Checklist State**: Migrate `doneSettlements` from transaction indices to unique string keys (`s.from + '->' + s.to`) so that checkbox state remains correct when expenses or balances change.
- **Guest Deletion Loop & Foreign Key Violations**: Update `deleteTripFromSupabase` to delete entries from `trip_members` if the user is a guest, and sequentially delete child `expenses` first if the user is the owner.
- **XSS & HTML Injection**: Escape friend names and initials using `escHtml()` in `refreshFriends()`, `refreshSplitGrid()`, `refreshPayerSelect()`, and `refreshSugSplitGrid()`.
- **Dynamic Currency**: Replace hardcoded rupee `₹` symbols in UI templates (expenses list, balances, totals, confirm dialogues) with the trip's custom `currency.sym` symbol.
- **Client-side Password Validation**: Prevent empty passwords or passwords shorter than 6 characters from triggering Supabase API calls in `performAuth()`.
- **Real-time Suggestion Listeners**: Update `startRealtime()` to listen to all events (`*`) instead of just `INSERT` for suggestions, allowing instant removal/update of suggestions when accepted or rejected by other clients.

---

### Service Worker & Caching

#### [MODIFY] [sw.js](file:///c:/mehta/splitaway/sw.js)
- **CDN Pre-caching**: Add the Supabase Client CDN, Vanilla Tilt CDN, and Google Fonts URLs to `ASSETS_TO_CACHE` for offline page loading.
- **Cross-origin (CORS) Caching**: Update the fetch handler to cache both same-origin (`basic`) and cross-origin (`cors`) responses so external assets are successfully cached for offline use.

## Verification Plan

### Automated / Browser Tests
- I will verify the changes by inspecting the JS logic and using the browser tools once implemented.

### Manual Verification
1. **Offline Mode Validation**:
   - Turn off network connections or simulate offline mode in devtools.
   - Reload the page; verify that CDNs and styles are served by the Service Worker and the app starts successfully.
   - Edit a trip and add an expense; verify that changes are saved locally and a sync pending warning is shown.
2. **XSS Protection**:
   - Add a friend named `<img src=x onerror=alert(1)>`. Verify that the name is rendered as plain text and no alert is triggered.
3. **Settlement State Consistency**:
   - Check a settlement item, then add a new expense. Verify that the checkmark does not shift to a different person.
4. **Real-time Actions**:
   - Confirm that deleting a trip as a guest deletes the `trip_members` entry and does not throw RLS database errors.
