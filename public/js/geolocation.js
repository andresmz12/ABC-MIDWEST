// Geolocation tracker for automatic arrival detection
// Sends employee location every 5 minutes during store working hours

(function() {
  'use strict';

  const LOCATION_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes
  const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Check if current time falls within store's working hours
  function isWithinWorkingHours(openingTime, closingTime) {
    if (!openingTime || !closingTime) return false;

    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();
    const currentTime = currentHour * 60 + currentMin;

    const [openHour, openMin] = openingTime.split(':').map(Number);
    const [closeHour, closeMin] = closingTime.split(':').map(Number);

    const openTime = openHour * 60 + openMin;
    const closeTime = closeHour * 60 + closeMin;

    // Store operates overnight (e.g., 22:00 to 08:00)
    if (openTime > closeTime) {
      return currentTime >= openTime || currentTime < closeTime;
    }
    // Normal hours (e.g., 09:00 to 17:00)
    return currentTime >= openTime && currentTime < closeTime;
  }

  // Get device location from browser Geolocation API
  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy
          });
        },
        (error) => {
          reject(error);
        }
      );
    });
  }

  // Send location to server
  async function sendLocationToServer(lat, lng) {
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        console.log('[Geolocation] No token, skipping location update');
        return false;
      }

      const response = await fetch('/api/employee/location', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ lat, lng })
      });

      if (response.ok) {
        console.log(`[Geolocation] ✅ Location sent: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        return true;
      } else {
        console.error('[Geolocation] Server error:', response.status);
        return false;
      }
    } catch (error) {
      console.error('[Geolocation] Error sending location:', error.message);
      return false;
    }
  }

  // Fetch store schedule to check if any store is currently open
  async function isStoreCurrentlyOpen() {
    try {
      const token = localStorage.getItem('token');
      if (!token) return false;

      const response = await fetch('/api/employee/stores', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) return false;

      const stores = await response.json();
      if (!Array.isArray(stores)) return false;

      // Check if any assigned store is open right now
      for (const store of stores) {
        if (isWithinWorkingHours(store.opening_time, store.closing_time)) {
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('[Geolocation] Error checking store hours:', error.message);
      return false;
    }
  }

  // Main tracking function
  async function trackLocation() {
    try {
      // Only track if at least one store is open
      const storeOpen = await isStoreCurrentlyOpen();
      if (!storeOpen) {
        console.log('[Geolocation] No stores open, skipping location update');
        return;
      }

      // Get current location
      const { lat, lng, accuracy } = await getLocation();
      console.log(`[Geolocation] 📍 Location: ${lat.toFixed(4)}, ${lng.toFixed(4)} (±${accuracy.toFixed(0)}m)`);

      // Send to server
      await sendLocationToServer(lat, lng);
    } catch (error) {
      console.error('[Geolocation] Error tracking location:', error.message);
    }
  }

  // Request GPS permission and start tracking
  function initGeolocation() {
    if (!navigator.geolocation) {
      console.warn('[Geolocation] Geolocation not supported in this browser');
      return;
    }

    // Request permission once
    navigator.geolocation.getCurrentPosition(
      (position) => {
        console.log('✅ [Geolocation] GPS permission granted');
        // Start periodic updates
        startLocationTracking();
      },
      (error) => {
        console.warn('[Geolocation] GPS permission denied or unavailable:', error.message);
        // Optionally show UI banner to user
        showGPSBanner();
      }
    );
  }

  function startLocationTracking() {
    // Track immediately
    trackLocation();

    // Then track every 5 minutes
    setInterval(trackLocation, LOCATION_UPDATE_INTERVAL);
    console.log(`[Geolocation] 🔄 Tracking started (updates every ${LOCATION_UPDATE_INTERVAL / 1000}s)`);
  }

  function showGPSBanner() {
    const banner = document.getElementById('gps-banner');
    if (banner) {
      banner.style.display = 'block';
    }
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGeolocation);
  } else {
    initGeolocation();
  }
})();
