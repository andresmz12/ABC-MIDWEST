const { query } = require('../database');
const { sendGeofenceEmail } = require('./email');

// Haversine formula: calculate distance between two coordinates (in meters)
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // distance in meters
}

// Check if current time falls within store's working hours
function isStoreOpen(currentTime, openingTime, closingTime) {
  if (!openingTime || !closingTime) return false;

  // Parse times (HH:MM format)
  const [openHour, openMin] = openingTime.split(':').map(Number);
  const [closeHour, closeMin] = closingTime.split(':').map(Number);
  const [currHour, currMin] = currentTime.split(':').map(Number);

  const openMins = openHour * 60 + openMin;
  const closeMins = closeHour * 60 + closeMin;
  const currMins = currHour * 60 + currMin;

  // Store operates overnight (e.g., 22:00 to 08:00)
  if (openMins > closeMins) {
    return currMins >= openMins || currMins < closeMins;
  }
  // Normal hours (e.g., 09:00 to 17:00)
  return currMins >= openMins && currMins < closeMins;
}

// Main geofence check: detect arrivals and departures
async function checkArrivals() {
  try {
    const now = new Date();
    const currentTime = String(now.getHours()).padStart(2, '0') + ':' +
                        String(now.getMinutes()).padStart(2, '0');

    // Get all stores that are OPEN right now (have coordinates and valid hours)
    const { rows: openStores } = await query(`
      SELECT id, company_id, name, address, latitude, longitude, opening_time, closing_time
      FROM stores
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        AND opening_time IS NOT NULL AND closing_time IS NOT NULL
    `);

    if (openStores.length === 0) {
      console.log('[Geofence] No stores with coordinates configured');
      return;
    }

    console.log(`[Geofence] Checking ${openStores.length} stores...`);

    const GEOFENCE_RADIUS = 500; // meters

    for (const store of openStores) {
      // Check if store is open NOW
      if (!isStoreOpen(currentTime, store.opening_time, store.closing_time)) {
        continue;
      }

      // Get all employees with recent location data
      const { rows: employees } = await query(`
        SELECT el.user_id, el.lat, el.lng, u.name, u.email, c.name as company_name
        FROM employee_locations el
        JOIN users u ON u.id = el.user_id
        JOIN companies c ON c.id = el.company_id
        WHERE el.company_id = $1
          AND el.updated_at > NOW() - INTERVAL '20 minutes'
      `, [store.company_id]);

      for (const emp of employees) {
        const distance = calculateDistance(
          parseFloat(emp.lat), parseFloat(emp.lng),
          parseFloat(store.latitude), parseFloat(store.longitude)
        );

        // Employee is within geofence
        if (distance < GEOFENCE_RADIUS) {
          // Check if we already logged an arrival today
          const { rows: existing } = await query(`
            SELECT id FROM arrival_events
            WHERE user_id = $1 AND store_id = $2
              AND DATE(created_at) = CURRENT_DATE
              AND event_type = 'arrival'
          `, [emp.user_id, store.id]);

          if (existing.length === 0) {
            // Log arrival event
            await query(`
              INSERT INTO arrival_events (company_id, user_id, store_id, event_type, distance_meters)
              VALUES ($1, $2, $3, 'arrival', $4)
            `, [store.company_id, emp.user_id, store.id, Math.round(distance)]);

            // Send email to employee and admins
            await sendGeofenceEmail(emp, store, distance, 'arrival');

            console.log(`✅ [Arrival] ${emp.name} detected at ${store.name} (${distance.toFixed(0)}m)`);
          }
        }
      }
    }
  } catch (error) {
    console.error('[Geofence] Error checking arrivals:', error.message);
  }
}

module.exports = { checkArrivals };
